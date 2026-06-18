//! Cross-process session-metadata patch lock.
//!
//! A 1:1 port of the lock protocol in `src/store.ts` (`acquirePatchLock` and the
//! stale-recovery machinery). The on-disk layout is interop-critical: a Rust
//! client and a TypeScript daemon/server coordinate on the *same* lock files, so
//! the directory layout and `owner.json` schema must match byte/shape exactly.
//!
//! Layout for a session `<id>`:
//! - `sessions/<id>.json.lock/`            — the lock (a directory; `mkdir` is the
//!   atomic create primitive).
//! - `sessions/<id>.json.lock/owner.json`  — `{pid, createdAt, hostname, platform,
//!   token, pidNamespace?, processStartTime?}` identifying the live holder.
//! - `sessions/<id>.json.lock.reclaim/`    — recovery lock serializing stale-lock
//!   reclaimers.
//! - `sessions/<id>.json.lock/.reclaiming.json` — reclaim claim held across the
//!   final validation→rename window.
//!
//! Staleness = a dead owner in the same pid-scope (host + platform + pid
//! namespace), a reused-pid identity (Linux `processStartTime`), or age beyond
//! `stale_ms` for foreign/ownerless locks.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{StoreError, StoreResult};
use crate::paths::{self, Env};

const PATCH_LOCK_RETRY_MS: u64 = 10;
const PATCH_LOCK_TIMEOUT_MS: u64 = 30_000;
const PATCH_LOCK_STALE_MS: u64 = 60_000;
const PATCH_LOCK_OWNER_FILE: &str = "owner.json";
const PATCH_LOCK_RECOVERY_SUFFIX: &str = ".reclaim";
const PATCH_LOCK_RECLAIM_CLAIM_FILE: &str = ".reclaiming.json";

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Tuning knobs for [`acquire_patch_lock`]. `None` selects the production default.
#[derive(Debug, Clone, Default)]
pub struct PatchLockOptions {
    pub timeout_ms: Option<u64>,
    pub retry_ms: Option<u64>,
    pub stale_ms: Option<u64>,
}

/// The full lock owner record, serialized to `owner.json`. camelCase keys match
/// the TS `PatchLockOwner`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PatchLockOwner {
    pid: u32,
    created_at: String,
    hostname: String,
    platform: String,
    token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid_namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_start_time: Option<String>,
}

/// A possibly-partial owner record as read from disk (other processes, including
/// older TS writers and test fixtures, may omit fields).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PartialOwner {
    #[serde(default)]
    pid: Option<i64>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    hostname: Option<String>,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    pid_namespace: Option<String>,
    #[serde(default)]
    process_start_time: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PatchLockIdentity {
    dev: u64,
    ino: u64,
}

#[derive(Debug)]
struct PatchLockInstance {
    identity: PatchLockIdentity,
    owner: PatchLockOwner,
}

struct PatchLockSnapshot {
    identity: PatchLockIdentity,
    mtime_ms: i64,
    owner: Option<PartialOwner>,
    owner_raw: Option<String>,
}

struct OwnerFileSnapshot {
    identity: PatchLockIdentity,
    mtime_ms: i64,
    owner: Option<PartialOwner>,
    owner_raw: String,
}

// ---------------------------------------------------------------------------
// Time / identity / environment helpers
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

fn unique_suffix(kind: &str) -> String {
    format!(
        "{kind}-{}-{}-{}",
        std::process::id(),
        now_ms(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn hostname() -> String {
    static HN: OnceLock<String> = OnceLock::new();
    HN.get_or_init(paths::hostname).clone()
}

fn current_pid_namespace() -> Option<String> {
    static NS: OnceLock<Option<String>> = OnceLock::new();
    NS.get_or_init(|| {
        #[cfg(target_os = "linux")]
        {
            fs::read_link("/proc/self/ns/pid")
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        }
        #[cfg(not(target_os = "linux"))]
        {
            None
        }
    })
    .clone()
}

fn process_start_time(pid: i64) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let raw = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let after = raw.rfind(')').map(|i| &raw[i + 2..])?;
        after.split_whitespace().nth(19).map(|s| s.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

fn random_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("getrandom for lock token");
    let mut s = String::with_capacity(32);
    for b in buf {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn current_owner() -> PatchLockOwner {
    PatchLockOwner {
        pid: std::process::id(),
        created_at: paths::now_iso(),
        hostname: hostname(),
        platform: paths::node_platform().to_string(),
        token: random_token(),
        pid_namespace: current_pid_namespace(),
        process_start_time: process_start_time(std::process::id() as i64),
    }
}

#[cfg(unix)]
fn is_process_alive(pid: i64) -> bool {
    use std::os::raw::c_int;
    if pid <= 0 || pid > i64::from(i32::MAX) {
        return false;
    }
    // SAFETY: signal 0 performs error checking only and sends no signal.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0 as c_int) };
    if rc == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn is_process_alive(pid: i64) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid <= 0 || pid > i64::from(u32::MAX) {
        return false;
    }
    // SAFETY: standard OpenProcess liveness probe; the handle is closed on success.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
        if !handle.is_null() {
            CloseHandle(handle);
            return true;
        }
        GetLastError() == ERROR_ACCESS_DENIED
    }
}

#[cfg(not(any(unix, windows)))]
fn is_process_alive(_pid: i64) -> bool {
    false
}

#[cfg(unix)]
fn identity_of(meta: &fs::Metadata) -> PatchLockIdentity {
    use std::os::unix::fs::MetadataExt;
    PatchLockIdentity {
        dev: meta.dev(),
        ino: meta.ino(),
    }
}

#[cfg(windows)]
fn identity_of(path: &Path) -> io::Result<PatchLockIdentity> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let mut wide = path.as_os_str().encode_wide().collect::<Vec<u16>>();
    wide.push(0);

    // SAFETY: `wide` is a valid, NUL-terminated UTF-16 path for the duration of the call.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }

    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: `handle` is valid on this branch and `info` points to writable storage.
    let ok = unsafe { GetFileInformationByHandle(handle, info.as_mut_ptr()) };
    // SAFETY: `handle` was returned by `CreateFileW` and must be closed once.
    unsafe {
        CloseHandle(handle);
    }
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    // SAFETY: `GetFileInformationByHandle` succeeded, so `info` is fully initialized.
    let info = unsafe { info.assume_init() };
    Ok(PatchLockIdentity {
        dev: u64::from(info.dwVolumeSerialNumber),
        ino: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    })
}

#[cfg(not(any(unix, windows)))]
fn identity_of(meta: &fs::Metadata) -> PatchLockIdentity {
    let _ = meta;
    PatchLockIdentity { dev: 0, ino: 0 }
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Owner read/write
// ---------------------------------------------------------------------------

fn write_owner(lock_path: &Path, owner: &PatchLockOwner) -> StoreResult<()> {
    let json = serde_json::to_string(owner)?;
    fs::write(lock_path.join(PATCH_LOCK_OWNER_FILE), format!("{json}\n"))?;
    Ok(())
}

fn read_owner(lock_path: &Path) -> io::Result<Option<PartialOwner>> {
    read_owner_file(&lock_path.join(PATCH_LOCK_OWNER_FILE))
}

fn read_owner_file(path: &Path) -> io::Result<Option<PartialOwner>> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(serde_json::from_str::<PartialOwner>(&raw).ok()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn get_identity(path: &Path) -> io::Result<PatchLockIdentity> {
    #[cfg(windows)]
    {
        identity_of(path)
    }
    #[cfg(not(windows))]
    {
        Ok(identity_of(&fs::metadata(path)?))
    }
}

fn get_owner_file_snapshot(path: &Path) -> io::Result<Option<OwnerFileSnapshot>> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let owner_raw = fs::read_to_string(path)?;
    let owner = serde_json::from_str::<PartialOwner>(&owner_raw).ok();
    Ok(Some(OwnerFileSnapshot {
        #[cfg(windows)]
        identity: identity_of(path)?,
        #[cfg(not(windows))]
        identity: identity_of(&meta),
        mtime_ms: mtime_ms(&meta),
        owner,
        owner_raw,
    }))
}

fn get_snapshot(lock_path: &Path) -> io::Result<Option<PatchLockSnapshot>> {
    let meta = match fs::metadata(lock_path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let (owner, owner_raw) = match fs::read_to_string(lock_path.join(PATCH_LOCK_OWNER_FILE)) {
        Ok(raw) => (serde_json::from_str::<PartialOwner>(&raw).ok(), Some(raw)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (None, None),
        Err(e) => return Err(e),
    };
    Ok(Some(PatchLockSnapshot {
        #[cfg(windows)]
        identity: identity_of(lock_path)?,
        #[cfg(not(windows))]
        identity: identity_of(&meta),
        mtime_ms: mtime_ms(&meta),
        owner,
        owner_raw,
    }))
}

// ---------------------------------------------------------------------------
// Owner comparisons
// ---------------------------------------------------------------------------

fn same_identity(a: PatchLockIdentity, b: PatchLockIdentity) -> bool {
    a == b
}

fn same_owner_token(actual: &Option<PartialOwner>, expected: &PatchLockOwner) -> bool {
    actual.as_ref().and_then(|o| o.token.as_deref()) == Some(expected.token.as_str())
}

fn same_instance_owner(actual: &Option<PartialOwner>, expected: &PatchLockOwner) -> bool {
    let Some(a) = actual else { return false };
    a.token.as_deref() == Some(expected.token.as_str())
        && a.pid == Some(i64::from(expected.pid))
        && a.created_at.as_deref() == Some(expected.created_at.as_str())
        && a.hostname.as_deref() == Some(expected.hostname.as_str())
        && a.platform.as_deref() == Some(expected.platform.as_str())
        && a.pid_namespace == expected.pid_namespace
        && a.process_start_time == expected.process_start_time
}

fn same_snapshot_owner(actual: &Option<PartialOwner>, expected: &Option<PartialOwner>) -> bool {
    match (actual, expected) {
        (None, None) => true,
        (Some(_), None) | (None, Some(_)) => false,
        (Some(a), Some(e)) => {
            if a.token.is_some() || e.token.is_some() {
                a.token == e.token
            } else {
                a.pid == e.pid
                    && a.created_at == e.created_at
                    && a.hostname == e.hostname
                    && a.platform == e.platform
                    && a.pid_namespace == e.pid_namespace
                    && a.process_start_time == e.process_start_time
            }
        }
    }
}

fn same_reclaim_snapshot(
    actual: Option<&PatchLockSnapshot>,
    expected: Option<&PatchLockSnapshot>,
) -> bool {
    match (actual, expected) {
        (Some(a), Some(e)) => {
            same_identity(a.identity, e.identity)
                && a.owner_raw == e.owner_raw
                && same_snapshot_owner(&a.owner, &e.owner)
        }
        _ => false,
    }
}

fn same_owner_file_snapshot(
    actual: Option<&OwnerFileSnapshot>,
    expected: &OwnerFileSnapshot,
) -> bool {
    match actual {
        Some(a) => {
            same_identity(a.identity, expected.identity)
                && a.owner_raw == expected.owner_raw
                && same_snapshot_owner(&a.owner, &expected.owner)
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

fn same_pid_scope(owner: &PartialOwner) -> bool {
    if owner.hostname.as_deref() != Some(hostname().as_str())
        || owner.platform.as_deref() != Some(paths::node_platform())
    {
        return false;
    }
    match current_pid_namespace() {
        Some(ns) => owner.pid_namespace.as_deref() == Some(ns.as_str()),
        None => owner.pid_namespace.is_none(),
    }
}

fn owner_stale(owner: &Option<PartialOwner>, fallback_mtime_ms: i64, stale_ms: u64) -> bool {
    let now = now_ms();
    let created_at_ms = owner
        .as_ref()
        .and_then(|o| o.created_at.as_deref())
        .and_then(parse_iso8601_to_millis);

    if let Some(o) = owner {
        let pid = o.pid.filter(|p| *p > 0);
        if let Some(pid) = pid {
            if same_pid_scope(o) {
                if !is_process_alive(pid) {
                    return true;
                }
                let current_start = process_start_time(pid);
                if o.process_start_time.is_some()
                    && current_start.is_some()
                    && o.process_start_time != current_start
                {
                    return true;
                }
                return false;
            }
        }
    }
    let elapsed = match created_at_ms {
        Some(c) => now - c,
        None => now - fallback_mtime_ms,
    };
    elapsed > stale_ms as i64
}

fn snapshot_stale(snapshot: &PatchLockSnapshot, stale_ms: u64) -> bool {
    owner_stale(&snapshot.owner, snapshot.mtime_ms, stale_ms)
}

fn is_complete_owner(owner: &Option<PartialOwner>) -> bool {
    let Some(o) = owner else { return false };
    o.pid.is_some()
        && o.created_at
            .as_deref()
            .and_then(parse_iso8601_to_millis)
            .is_some()
        && o.hostname.is_some()
        && o.platform.is_some()
        && o.token.is_some()
}

fn reclaim_claim_stale(snapshot: &OwnerFileSnapshot, stale_ms: u64) -> bool {
    if is_complete_owner(&snapshot.owner) {
        return owner_stale(&snapshot.owner, snapshot.mtime_ms, stale_ms);
    }
    let created_at_ms = snapshot
        .owner
        .as_ref()
        .and_then(|o| o.created_at.as_deref())
        .and_then(parse_iso8601_to_millis);
    let now = now_ms();
    let elapsed = match created_at_ms {
        Some(c) => now - c,
        None => now - snapshot.mtime_ms,
    };
    elapsed > stale_ms as i64
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

fn release_patch_lock(lock_path: &Path, instance: &PatchLockInstance) -> StoreResult<()> {
    let current_identity = match get_identity(lock_path) {
        Ok(id) => id,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let current_owner = read_owner(lock_path)?;
    if !same_identity(current_identity, instance.identity)
        || !same_instance_owner(&current_owner, &instance.owner)
    {
        return Ok(());
    }

    let release_path = sibling(lock_path, &unique_suffix("release"));
    match fs::rename(lock_path, &release_path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
            let retry_identity = match get_identity(lock_path) {
                Ok(id) => id,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(e) => return Err(e.into()),
            };
            let retry_owner = read_owner(lock_path)?;
            if same_identity(retry_identity, instance.identity)
                && same_instance_owner(&retry_owner, &instance.owner)
            {
                remove_dir_all_force(lock_path);
            }
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    }

    let release_identity = match get_identity(&release_path) {
        Ok(id) => id,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let release_owner = read_owner(&release_path)?;
    if !same_identity(release_identity, instance.identity)
        || !same_instance_owner(&release_owner, &instance.owner)
    {
        return Ok(());
    }
    remove_dir_all_force(&release_path);
    Ok(())
}

// ---------------------------------------------------------------------------
// Reclaim claim
// ---------------------------------------------------------------------------

fn claim_for_reclaim(lock_path: &Path, stale_ms: u64) -> StoreResult<Option<PatchLockOwner>> {
    let claim = current_owner();
    let claim_path = lock_path.join(PATCH_LOCK_RECLAIM_CLAIM_FILE);
    loop {
        match write_new_file(
            &claim_path,
            &format!("{}\n", serde_json::to_string(&claim)?),
        ) {
            Ok(()) => return Ok(Some(claim)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }

        let stale_claim = match get_owner_file_snapshot(&claim_path)? {
            Some(s) => s,
            None => continue,
        };
        if !reclaim_claim_stale(&stale_claim, stale_ms) {
            return Ok(None);
        }

        let quarantine_path = sibling(&claim_path, &unique_suffix("stale"));
        match fs::rename(&claim_path, &quarantine_path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }

        let quarantined = get_owner_file_snapshot(&quarantine_path)?;
        if let Some(q) = &quarantined {
            if same_owner_file_snapshot(Some(q), &stale_claim) && reclaim_claim_stale(q, stale_ms) {
                let _ = fs::remove_file(&quarantine_path);
                continue;
            }
        }
        if let Some(q) = &quarantined {
            match write_new_file(&claim_path, &q.owner_raw) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
            let _ = fs::remove_file(&quarantine_path);
        }
        return Ok(None);
    }
}

fn same_reclaim_claim(lock_path: &Path, expected: &PatchLockOwner) -> StoreResult<bool> {
    let actual = read_owner_file(&lock_path.join(PATCH_LOCK_RECLAIM_CLAIM_FILE))?;
    Ok(same_owner_token(&actual, expected))
}

fn release_reclaim_claim(lock_path: &Path, claim: &PatchLockOwner) -> StoreResult<()> {
    if same_reclaim_claim(lock_path, claim)? {
        let _ = fs::remove_file(lock_path.join(PATCH_LOCK_RECLAIM_CLAIM_FILE));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

fn quarantine_stale_lock(lock_path: &Path, stale_ms: u64) -> StoreResult<bool> {
    let stale_snapshot = match get_snapshot(lock_path)? {
        Some(s) => s,
        None => return Ok(false),
    };
    if !snapshot_stale(&stale_snapshot, stale_ms) {
        return Ok(false);
    }
    let pre_rename = match get_snapshot(lock_path)? {
        Some(s) => s,
        None => return Ok(false),
    };
    if !same_reclaim_snapshot(Some(&pre_rename), Some(&stale_snapshot))
        || !snapshot_stale(&pre_rename, stale_ms)
    {
        return Ok(false);
    }

    let reclaim_claim = match claim_for_reclaim(lock_path, stale_ms)? {
        Some(c) => c,
        None => return Ok(false),
    };

    let mut quarantine_path = PathBuf::new();
    let mut renamed = false;
    let rename_result: StoreResult<bool> = (|| {
        let claimed = get_snapshot(lock_path)?;
        if !same_reclaim_snapshot(claimed.as_ref(), Some(&pre_rename))
            || !snapshot_stale(&pre_rename, stale_ms)
            || !same_reclaim_claim(lock_path, &reclaim_claim)?
        {
            return Ok(false);
        }
        loop {
            quarantine_path = sibling(lock_path, &unique_suffix("stale"));
            match fs::rename(lock_path, &quarantine_path) {
                Ok(()) => {
                    renamed = true;
                    return Ok(true);
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
                Err(e) => return Err(e.into()),
            }
        }
    })();

    if !renamed {
        release_reclaim_claim(lock_path, &reclaim_claim)?;
    }
    if !rename_result? {
        return Ok(false);
    }

    let quarantine_snapshot = get_snapshot(&quarantine_path)?;
    if !same_reclaim_snapshot(quarantine_snapshot.as_ref(), Some(&pre_rename))
        || !snapshot_stale(&pre_rename, stale_ms)
    {
        return Ok(false);
    }
    remove_dir_all_force(&quarantine_path);
    Ok(true)
}

// ---------------------------------------------------------------------------
// Recovery lock
// ---------------------------------------------------------------------------

fn recovery_lock_path(lock_path: &Path) -> PathBuf {
    append_suffix(lock_path, PATCH_LOCK_RECOVERY_SUFFIX)
}

struct RecoveryLockHandle {
    path: PathBuf,
    instance: PatchLockInstance,
}

fn acquire_recovery_lock(
    lock_path: &Path,
    stale_ms: u64,
) -> StoreResult<Option<RecoveryLockHandle>> {
    let recovery_lock_path = recovery_lock_path(lock_path);
    match fs::create_dir(&recovery_lock_path) {
        Ok(()) => {
            let owner = current_owner();
            if let Err(e) = write_owner(&recovery_lock_path, &owner) {
                remove_dir_all_force(&recovery_lock_path);
                return Err(e);
            }
            let identity = get_identity(&recovery_lock_path)?;
            Ok(Some(RecoveryLockHandle {
                path: recovery_lock_path,
                instance: PatchLockInstance { identity, owner },
            }))
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            quarantine_stale_lock(&recovery_lock_path, stale_ms)?;
            Ok(None)
        }
        Err(e) => Err(e.into()),
    }
}

fn recovery_active(lock_path: &Path, stale_ms: u64) -> StoreResult<bool> {
    let recovery_lock_path = recovery_lock_path(lock_path);
    match fs::metadata(&recovery_lock_path) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    }
    if quarantine_stale_lock(&recovery_lock_path, stale_ms)? {
        return Ok(false);
    }
    Ok(true)
}

fn recover_stale_if_recovery_owner(lock_path: &Path, stale_ms: u64) -> StoreResult<bool> {
    let handle = match acquire_recovery_lock(lock_path, stale_ms)? {
        Some(h) => h,
        None => return Ok(false),
    };
    let result = quarantine_stale_lock(lock_path, stale_ms);
    let _ = release_patch_lock(&handle.path, &handle.instance);
    result
}

// ---------------------------------------------------------------------------
// Acquire
// ---------------------------------------------------------------------------

/// RAII-ish guard for a held patch lock. Call [`PatchLockGuard::release`] to
/// release it; mirrors the release closure returned by `acquirePatchLock`.
#[derive(Debug)]
pub struct PatchLockGuard {
    lock_path: PathBuf,
    instance: PatchLockInstance,
    released: bool,
}

impl PatchLockGuard {
    /// Releases the lock (rename-then-remove with identity + owner-token guard).
    pub fn release(mut self) -> StoreResult<()> {
        self.released = true;
        release_patch_lock(&self.lock_path, &self.instance)
    }
}

impl Drop for PatchLockGuard {
    fn drop(&mut self) {
        if !self.released {
            let _ = release_patch_lock(&self.lock_path, &self.instance);
        }
    }
}

fn lock_path_for(env: &Env, id: &str) -> PathBuf {
    append_suffix(&env.session_meta_path(id), ".lock")
}

/// Acquires the cross-process patch lock for session `id`, retrying past stale
/// locks until success or timeout. Mirrors `acquirePatchLock`.
pub fn acquire_patch_lock(
    env: &Env,
    id: &str,
    options: &PatchLockOptions,
) -> StoreResult<PatchLockGuard> {
    let lock_path = lock_path_for(env, id);
    let retry_ms = options.retry_ms.unwrap_or(PATCH_LOCK_RETRY_MS);
    let stale_ms = options.stale_ms.unwrap_or(PATCH_LOCK_STALE_MS);
    let deadline = now_ms() + options.timeout_ms.unwrap_or(PATCH_LOCK_TIMEOUT_MS) as i64;
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)?;
    }

    loop {
        match fs::create_dir(&lock_path) {
            Ok(()) => {
                if recovery_active(&lock_path, stale_ms)? {
                    remove_dir_all_force(&lock_path);
                    if now_ms() >= deadline {
                        return Err(StoreError::LockTimeout(id.to_string()));
                    }
                    sleep(retry_ms);
                    continue;
                }
                let owner = current_owner();
                if let Err(e) = write_owner(&lock_path, &owner) {
                    remove_dir_all_force(&lock_path);
                    return Err(e);
                }
                let identity = get_identity(&lock_path)?;
                return Ok(PatchLockGuard {
                    lock_path,
                    instance: PatchLockInstance { identity, owner },
                    released: false,
                });
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                if now_ms() >= deadline {
                    return Err(StoreError::LockTimeout(id.to_string()));
                }
                recover_stale_if_recovery_owner(&lock_path, stale_ms)?;
                sleep(retry_ms);
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// Test-only entry point mirroring `acquireSessionMetaPatchLockForTest`.
pub fn acquire_session_meta_patch_lock_for_test(
    env: &Env,
    id: &str,
    options: &PatchLockOptions,
) -> StoreResult<PatchLockGuard> {
    acquire_patch_lock(env, id, options)
}

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------

/// Returns a sibling path: `<parent>/<name>` where parent is `path`'s parent.
fn sibling(path: &Path, name: &str) -> PathBuf {
    match path.parent() {
        Some(parent) => parent.join(name),
        None => PathBuf::from(name),
    }
}

/// Appends `suffix` to the full path string (e.g. `<p>` + `.lock` → `<p>.lock`).
fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

fn write_new_file(path: &Path, contents: &str) -> io::Result<()> {
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    f.write_all(contents.as_bytes())
}

fn remove_dir_all_force(path: &Path) {
    let _ = fs::remove_dir_all(path);
    let _ = fs::remove_file(path);
}

// ---------------------------------------------------------------------------
// ISO-8601 parsing (Date.parse equivalent for canonical `toISOString` output)
// ---------------------------------------------------------------------------

fn parse_iso8601_to_millis(s: &str) -> Option<i64> {
    let (date, mut time) = s.split_once('T')?;
    let mut dparts = date.split('-');
    let year: i64 = dparts.next()?.parse().ok()?;
    let month: i64 = dparts.next()?.parse().ok()?;
    let day: i64 = dparts.next()?.parse().ok()?;
    if dparts.next().is_some() {
        return None;
    }
    if let Some(stripped) = time.strip_suffix('Z') {
        time = stripped;
    }
    let (hms, frac) = match time.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (time, None),
    };
    let mut tparts = hms.split(':');
    let hour: i64 = tparts.next()?.parse().ok()?;
    let minute: i64 = tparts.next()?.parse().ok()?;
    let second: i64 = tparts.next()?.parse().ok()?;
    if tparts.next().is_some() {
        return None;
    }
    let millis: i64 = match frac {
        Some(f) => {
            let mut digits: String = f.chars().take_while(|c| c.is_ascii_digit()).collect();
            if digits.is_empty() {
                return None;
            }
            while digits.len() < 3 {
                digits.push('0');
            }
            digits.truncate(3);
            digits.parse().ok()?
        }
        None => 0,
    };
    let days = days_from_civil(year, month, day);
    Some(((days * 86_400 + hour * 3600 + minute * 60 + second) * 1000) + millis)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_iso_and_rejects_garbage() {
        assert_eq!(parse_iso8601_to_millis("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso8601_to_millis("2021-01-01T00:00:00.000Z"),
            Some(1_609_459_200_000)
        );
        assert_eq!(
            parse_iso8601_to_millis("2023-11-14T22:13:20.123Z"),
            Some(1_700_000_000_123)
        );
        // Tolerates missing milliseconds.
        assert_eq!(parse_iso8601_to_millis("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(parse_iso8601_to_millis("not-a-date"), None);
        assert_eq!(parse_iso8601_to_millis("1970-01-01"), None);
    }

    #[test]
    fn complete_owner_requires_all_fields() {
        let full = Some(PartialOwner {
            pid: Some(1),
            created_at: Some("1970-01-01T00:00:00.000Z".into()),
            hostname: Some("h".into()),
            platform: Some("linux".into()),
            token: Some("t".into()),
            pid_namespace: None,
            process_start_time: None,
        });
        assert!(is_complete_owner(&full));
        let mut missing = full.clone();
        missing.as_mut().unwrap().token = None;
        assert!(!is_complete_owner(&missing));
        assert!(!is_complete_owner(&None));
    }
}
