//! Patch-lock recovery + concurrency integration tests, ported from the
//! operational subset of `tests/store-concurrency.test.ts`. Each test isolates
//! state under a real local filesystem dir (the cargo target tmp dir) and never
//! touches the system temp dir.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use climon_store::lock::{acquire_session_meta_patch_lock_for_test, PatchLockOptions};
use climon_store::paths::{hostname, node_platform, Env};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn home(tag: &str) -> Env {
    let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "{tag}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(base.join("sessions")).unwrap();
    Env::with_home(base)
}

fn lock_dir(env: &Env, id: &str) -> PathBuf {
    let mut s = env.session_meta_path(id).into_os_string();
    s.push(".lock");
    PathBuf::from(s)
}

fn recovery_dir(env: &Env, id: &str) -> PathBuf {
    let mut s = lock_dir(env, id).into_os_string();
    s.push(".reclaim");
    PathBuf::from(s)
}

fn pid_namespace() -> Option<String> {
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
}

/// Mirrors the TS `lockOwner` test helper: pid + createdAt + host/platform scope,
/// plus pidNamespace on Linux. No token (matches the TS helper).
fn lock_owner(pid: i64) -> serde_json::Value {
    let mut v = serde_json::json!({
        "pid": pid,
        "createdAt": climon_store::paths::now_iso(),
        "hostname": hostname(),
        "platform": node_platform(),
    });
    if let Some(ns) = pid_namespace() {
        v["pidNamespace"] = serde_json::Value::String(ns);
    }
    v
}

fn write_owner(lock: &Path, value: &serde_json::Value) {
    fs::write(
        lock.join("owner.json"),
        serde_json::to_string(value).unwrap(),
    )
    .unwrap();
}

#[cfg(unix)]
fn set_old_mtime(path: &Path) {
    use std::ffi::CString;
    let secs = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64)
        - 120;
    let c = CString::new(path.as_os_str().to_str().unwrap()).unwrap();
    let times = [
        libc::timeval {
            tv_sec: secs as libc::time_t,
            tv_usec: 0,
        },
        libc::timeval {
            tv_sec: secs as libc::time_t,
            tv_usec: 0,
        },
    ];
    // SAFETY: valid C string and a 2-element timeval array as documented.
    let rc = unsafe { libc::utimes(c.as_ptr(), times.as_ptr()) };
    assert_eq!(rc, 0, "utimes failed");
}

fn opts(timeout_ms: u64, retry_ms: u64, stale_ms: Option<u64>) -> PatchLockOptions {
    PatchLockOptions {
        timeout_ms: Some(timeout_ms),
        retry_ms: Some(retry_ms),
        stale_ms,
    }
}

#[test]
fn reclaims_stale_lock_with_dead_owner() {
    let env = home("dead-owner");
    let id = "stale-dead-owner";
    let lock = lock_dir(&env, id);
    fs::create_dir_all(&lock).unwrap();
    write_owner(&lock, &lock_owner(999_999_999));

    let guard = acquire_session_meta_patch_lock_for_test(&env, id, &opts(5000, 5, None))
        .expect("should reclaim dead-owner lock");
    guard.release().unwrap();
    assert!(!lock.exists());
    let _ = fs::remove_dir_all(env.climon_home());
}

#[cfg(unix)]
#[test]
fn reclaims_stale_lock_with_missing_owner() {
    let env = home("missing-owner");
    let id = "stale-missing-owner";
    let lock = lock_dir(&env, id);
    fs::create_dir_all(&lock).unwrap();
    set_old_mtime(&lock);

    let guard = acquire_session_meta_patch_lock_for_test(&env, id, &opts(5000, 5, None))
        .expect("should reclaim ownerless aged lock");
    guard.release().unwrap();
    assert!(!lock.exists());
    let _ = fs::remove_dir_all(env.climon_home());
}

#[cfg(unix)]
#[test]
fn reclaims_stale_lock_with_malformed_owner() {
    let env = home("malformed-owner");
    let id = "stale-malformed-owner";
    let lock = lock_dir(&env, id);
    fs::create_dir_all(&lock).unwrap();
    fs::write(lock.join("owner.json"), "{not-json").unwrap();
    set_old_mtime(&lock);

    let guard = acquire_session_meta_patch_lock_for_test(&env, id, &opts(5000, 5, None))
        .expect("should reclaim malformed aged lock");
    guard.release().unwrap();
    assert!(!lock.exists());
    let _ = fs::remove_dir_all(env.climon_home());
}

#[test]
fn fresh_live_lock_preserved_on_timeout() {
    let env = home("fresh-live");
    let id = "fresh-live-owner";
    let lock = lock_dir(&env, id);
    fs::create_dir_all(&lock).unwrap();
    write_owner(&lock, &lock_owner(std::process::id() as i64));

    let err = acquire_session_meta_patch_lock_for_test(&env, id, &opts(30, 5, None)).unwrap_err();
    assert!(matches!(err, climon_store::StoreError::LockTimeout(_)));
    assert!(lock.exists());
    let _ = fs::remove_dir_all(env.climon_home());
}

#[test]
fn fresh_foreign_lock_preserved() {
    let env = home("fresh-foreign");
    let id = "fresh-foreign-owner";
    let lock = lock_dir(&env, id);
    fs::create_dir_all(&lock).unwrap();
    write_owner(
        &lock,
        &serde_json::json!({
            "pid": 999_999_999,
            "createdAt": climon_store::paths::now_iso(),
            "hostname": "foreign-host",
            "platform": node_platform(),
        }),
    );

    let err = acquire_session_meta_patch_lock_for_test(&env, id, &opts(30, 5, None)).unwrap_err();
    assert!(matches!(err, climon_store::StoreError::LockTimeout(_)));
    assert!(lock.exists());
    let _ = fs::remove_dir_all(env.climon_home());
}

#[test]
fn new_acquisitions_wait_while_recovery_active() {
    let env = home("active-recovery");
    let id = "active-recovery";
    let recovery = recovery_dir(&env, id);
    fs::create_dir_all(&recovery).unwrap();
    write_owner(&recovery, &lock_owner(std::process::id() as i64));

    let err = acquire_session_meta_patch_lock_for_test(&env, id, &opts(30, 5, None)).unwrap_err();
    assert!(matches!(err, climon_store::StoreError::LockTimeout(_)));
    assert!(!lock_dir(&env, id).exists());
    assert!(recovery.exists());
    let _ = fs::remove_dir_all(env.climon_home());
}

#[test]
fn stale_recovery_lock_reclaimed() {
    let env = home("stale-recovery");
    let id = "stale-recovery-lock";
    let lock = lock_dir(&env, id);
    let recovery = recovery_dir(&env, id);
    fs::create_dir_all(&lock).unwrap();
    write_owner(&lock, &lock_owner(999_999_999));
    fs::create_dir_all(&recovery).unwrap();
    write_owner(&recovery, &lock_owner(999_999_998));

    let guard = acquire_session_meta_patch_lock_for_test(&env, id, &opts(5000, 5, None))
        .expect("should reclaim both stale locks");
    guard.release().unwrap();
    assert!(!lock.exists());
    assert!(!recovery.exists());
    let _ = fs::remove_dir_all(env.climon_home());
}

#[test]
fn orphaned_dead_reclaim_claim_reclaimed() {
    let env = home("orphan-claim");
    let id = "stale-lock-orphaned-reclaim-claim";
    let lock = lock_dir(&env, id);
    fs::create_dir_all(&lock).unwrap();
    let mut dead = lock_owner(999_999_999);
    dead["createdAt"] = serde_json::Value::String("1970-01-01T00:00:00.000Z".into());
    write_owner(&lock, &dead);
    let mut claim = lock_owner(999_999_998);
    claim["createdAt"] = serde_json::Value::String("1970-01-01T00:00:00.000Z".into());
    fs::write(
        lock.join(".reclaiming.json"),
        serde_json::to_string(&claim).unwrap(),
    )
    .unwrap();

    let guard = acquire_session_meta_patch_lock_for_test(&env, id, &opts(5000, 5, None))
        .expect("should reclaim lock past orphaned dead claim");
    guard.release().unwrap();
    assert!(!lock.exists());
    let _ = fs::remove_dir_all(env.climon_home());
}

#[test]
fn fresh_live_reclaim_claim_blocks() {
    let env = home("live-claim");
    let id = "fresh-live-reclaim-claim";
    let lock = lock_dir(&env, id);
    fs::create_dir_all(&lock).unwrap();
    let mut dead = lock_owner(999_999_999);
    dead["createdAt"] = serde_json::Value::String("1970-01-01T00:00:00.000Z".into());
    write_owner(&lock, &dead);
    let mut claim = lock_owner(std::process::id() as i64);
    claim["token"] = serde_json::Value::String("live-reclaim-claim".into());
    fs::write(
        lock.join(".reclaiming.json"),
        serde_json::to_string(&claim).unwrap(),
    )
    .unwrap();

    let err =
        acquire_session_meta_patch_lock_for_test(&env, id, &opts(30, 5, Some(1))).unwrap_err();
    assert!(matches!(err, climon_store::StoreError::LockTimeout(_)));
    assert!(lock.exists());
    assert!(lock.join(".reclaiming.json").exists());
    let _ = fs::remove_dir_all(env.climon_home());
}

#[test]
fn old_live_pid_without_start_time_preserved() {
    let env = home("live-no-start");
    let id = "live-pid-no-start-time";
    let lock = lock_dir(&env, id);
    fs::create_dir_all(&lock).unwrap();
    let mut owner = lock_owner(std::process::id() as i64);
    owner["createdAt"] = serde_json::Value::String("1970-01-01T00:00:00.000Z".into());
    write_owner(&lock, &owner);

    let err =
        acquire_session_meta_patch_lock_for_test(&env, id, &opts(30, 5, Some(1))).unwrap_err();
    assert!(matches!(err, climon_store::StoreError::LockTimeout(_)));
    assert!(lock.exists());
    let _ = fs::remove_dir_all(env.climon_home());
}

#[cfg(target_os = "linux")]
#[test]
fn reused_pid_identity_reclaimed() {
    let env = home("reused-pid");
    let id = "reused-pid-owner";
    let lock = lock_dir(&env, id);
    fs::create_dir_all(&lock).unwrap();
    let mut owner = lock_owner(std::process::id() as i64);
    owner["createdAt"] = serde_json::Value::String("1970-01-01T00:00:00.000Z".into());
    owner["processStartTime"] =
        serde_json::Value::String("not-the-current-process-start-time".into());
    write_owner(&lock, &owner);

    let guard = acquire_session_meta_patch_lock_for_test(&env, id, &opts(2000, 5, Some(1)))
        .expect("should reclaim reused-pid lock");
    guard.release().unwrap();
    assert!(!lock.exists());
    let _ = fs::remove_dir_all(env.climon_home());
}
