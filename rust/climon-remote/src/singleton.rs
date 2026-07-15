//! Cross-process singleton acquisition backed by an OS advisory file lock.
//!
//! The previous design decided ownership purely from the pidfile plus a
//! `is_process_alive(pid)` probe. That is unreliable: an OS is free to recycle a
//! dead holder's PID onto an unrelated process (extremely common on Windows,
//! where a dead uplink's PID routinely reappears as e.g. `WUDFHost`). When that
//! happens the probe returns "alive", the new instance concludes another
//! singleton is running, and it exits silently — leaving remote sessions
//! unpushed with no error.
//!
//! Instead we hold an exclusive OS lock on a sibling `<pidfile>.lock` file for
//! the lifetime of the owning process. The kernel releases the lock the instant
//! the process dies (crash or clean exit), so a stale lock can never block a new
//! instance and PID recycling is irrelevant. Ownership is expressed by the
//! returned [`SingletonGuard`]: keep it alive for as long as this process should
//! remain the singleton; dropping it releases the lock.
//!
//! The plain `<pidfile>` (e.g. `uplink.pid`, `ingest.pid`) is still written with
//! this process's PID so the Bun dashboard server and teardown paths that read
//! it for diagnostics/kill-by-pid keep working unchanged.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

/// Owns the singleton for as long as it is alive. Holding the inner [`File`]
/// keeps the OS advisory lock; dropping the guard releases the lock and removes
/// the pidfile when it still records this process. Store it in a binding that
/// lives for the whole singleton lifetime (e.g. the daemon/supervisor loop).
#[derive(Debug)]
pub struct SingletonGuard {
    // Held purely for its RAII effect: keeping this file open holds the OS lock;
    // dropping it releases the lock. Never read directly.
    #[allow(dead_code)]
    lock: File,
    pid_file: PathBuf,
}

impl Drop for SingletonGuard {
    fn drop(&mut self) {
        // Best-effort: only remove the pidfile if it still records us, so we
        // never delete a pidfile a newer instance has already claimed. The lock
        // itself is released by the OS when `lock` is closed on drop; we keep
        // the (empty) `.lock` file in place because on Windows it is opened
        // without FILE_SHARE_DELETE and a leftover zero-byte file is harmless.
        if let Ok(existing) = std::fs::read_to_string(&self.pid_file) {
            if existing.trim().parse::<u32>().ok() == Some(std::process::id()) {
                let _ = std::fs::remove_file(&self.pid_file);
            }
        }
    }
}

/// Result of a singleton acquisition attempt. Mirrors `SingletonResult`.
#[derive(Debug)]
pub struct SingletonResult {
    pub acquired: bool,
    /// PID recorded in the pidfile when `acquired` is false (diagnostics only;
    /// may be stale since ownership is decided by the lock, not this value).
    pub holder: Option<u32>,
    /// The ownership guard when `acquired` is true. Keep it alive to retain the
    /// singleton; drop it to release.
    pub guard: Option<SingletonGuard>,
}

/// Attempts to become the singleton for `pid_file`. Returns a [`SingletonResult`]
/// whose `guard` (when `acquired`) must be kept alive for the owning lifetime.
pub fn acquire_singleton_detailed(pid_file: &Path) -> SingletonResult {
    if let Some(parent) = pid_file.parent() {
        let _ = std::fs::create_dir_all(parent);
        set_mode(parent, 0o700);
    }

    let lock_path = lock_path_for(pid_file);
    match try_lock(&lock_path) {
        Some(lock) => {
            // We hold the exclusive lock: record our pid for readers/teardown.
            let _ = std::fs::write(pid_file, format!("{}\n", std::process::id()));
            set_mode(pid_file, 0o600);
            SingletonResult {
                acquired: true,
                holder: None,
                guard: Some(SingletonGuard {
                    lock,
                    pid_file: pid_file.to_path_buf(),
                }),
            }
        }
        None => SingletonResult {
            acquired: false,
            holder: read_holder_pid(pid_file),
            guard: None,
        },
    }
}

/// Sibling lock path for a pidfile: `uplink.pid` -> `uplink.pid.lock`.
fn lock_path_for(pid_file: &Path) -> PathBuf {
    let mut name = pid_file
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".lock");
    pid_file.with_file_name(name)
}

fn read_holder_pid(pid_file: &Path) -> Option<u32> {
    std::fs::read_to_string(pid_file)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .filter(|&pid| pid > 0)
}

/// Tries to take an exclusive, non-blocking OS lock on `lock_path`, returning the
/// held file handle on success or `None` when another live process holds it.
#[cfg(unix)]
fn try_lock(lock_path: &Path) -> Option<File> {
    use std::os::unix::io::AsRawFd;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .ok()?;
    set_mode(lock_path, 0o600);
    // SAFETY: `flock` on a valid fd owned by `file`; `LOCK_NB` returns instead of
    // blocking when another open file description already holds the lock. The
    // lock is bound to the open file description and released when `file` closes.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        Some(file)
    } else {
        None
    }
}

#[cfg(windows)]
fn try_lock(lock_path: &Path) -> Option<File> {
    use std::os::windows::fs::OpenOptionsExt;
    // share_mode(0) denies all sharing: the first opener holds the file
    // exclusively and any later open fails with a sharing violation until this
    // handle closes (on process exit/crash the OS closes it). This is exactly
    // the singleton semantics we want and is immune to PID recycling.
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(lock_path)
        .ok()
}

#[cfg(not(any(unix, windows)))]
fn try_lock(_lock_path: &Path) -> Option<File> {
    None
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "climon-singleton-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn acquires_when_no_pidfile_exists() {
        let dir = tmp("fresh");
        let pid_file = dir.join("nested").join("x.pid");
        let result = acquire_singleton_detailed(&pid_file);
        assert!(result.acquired);
        assert!(result.guard.is_some());
        assert!(pid_file.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn does_not_acquire_while_a_guard_is_held() {
        let dir = tmp("held");
        let pid_file = dir.join("x.pid");
        // First acquisition holds the OS lock for the lifetime of `first`.
        let first = acquire_singleton_detailed(&pid_file);
        assert!(first.acquired);
        // A second attempt (simulating another instance) is refused while the
        // lock is held — even from the same process, because the lock is bound
        // to the open file handle, not the PID.
        let second = acquire_singleton_detailed(&pid_file);
        assert!(!second.acquired);
        assert!(second.guard.is_none());
        assert_eq!(second.holder, Some(std::process::id()));
        drop(first);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn acquires_over_a_stale_pidfile_and_lockfile() {
        let dir = tmp("stale");
        let pid_file = dir.join("x.pid");
        // Simulate a crashed prior holder whose PID was recycled: a leftover
        // pidfile pointing at some other (possibly live) PID, plus a leftover
        // `.lock` file that no process actually holds. The lock model must
        // ignore the recycled PID and acquire cleanly.
        std::fs::write(&pid_file, "999999\n").unwrap();
        std::fs::write(dir.join("x.pid.lock"), b"").unwrap();
        let result = acquire_singleton_detailed(&pid_file);
        assert!(result.acquired);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reacquires_after_guard_dropped() {
        let dir = tmp("reacq");
        let pid_file = dir.join("x.pid");
        {
            let first = acquire_singleton_detailed(&pid_file);
            assert!(first.acquired);
            // Guard dropped at end of block -> lock released, pidfile removed.
        }
        assert!(!pid_file.exists());
        let second = acquire_singleton_detailed(&pid_file);
        assert!(second.acquired);
        std::fs::remove_dir_all(&dir).ok();
    }
}
