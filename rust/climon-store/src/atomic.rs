//! Atomic file writes: write to a unique temp path, then `rename` over the
//! target so a reader never observes a partial file. Mirrors `atomicWrite` /
//! `renameWithRetry` from `src/store.ts`, including the transient-rename retry
//! loop that resolves Windows lock contention (antivirus / indexer / the
//! dashboard server reading metadata).

use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const RENAME_MAX_ATTEMPTS: u32 = 10;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Injectable rename used only by tests to force transient/permanent failures.
/// Thread-local so an installed hook only affects `atomic_write` calls made on
/// the same thread — concurrent unrelated tests (and worker threads they spawn)
/// keep using the real `fs::rename`.
type RenameHook = Box<dyn Fn(&Path, &Path) -> io::Result<()>>;

thread_local! {
    static RENAME_HOOK: std::cell::RefCell<Option<RenameHook>> =
        const { std::cell::RefCell::new(None) };
}

/// Guard returned by [`set_atomic_write_test_hook`]; restores the previous hook
/// (clears it) on drop. Mirrors the closure returned by
/// `setAtomicWriteTestHooksForTest`.
#[must_use]
pub struct AtomicWriteHookGuard(());

impl Drop for AtomicWriteHookGuard {
    fn drop(&mut self) {
        RENAME_HOOK.with(|slot| *slot.borrow_mut() = None);
    }
}

/// Installs a test rename hook on the current thread; the returned guard clears
/// it on drop.
pub fn set_atomic_write_test_hook<F>(hook: F) -> AtomicWriteHookGuard
where
    F: Fn(&Path, &Path) -> io::Result<()> + 'static,
{
    RENAME_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    AtomicWriteHookGuard(())
}

fn do_rename(from: &Path, to: &Path) -> io::Result<()> {
    RENAME_HOOK.with(|slot| match slot.borrow().as_ref() {
        Some(hook) => hook(from, to),
        None => fs::rename(from, to),
    })
}

/// Windows can transiently fail `rename` with these codes when the destination
/// is briefly locked by another process. Retrying with a short backoff resolves
/// the contention instead of aborting the write.
#[cfg(unix)]
fn is_transient_rename_error(err: &io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        Some(c) if c == libc::EPERM
            || c == libc::EACCES
            || c == libc::EBUSY
            || c == libc::ENOTEMPTY
    )
}

#[cfg(windows)]
fn is_transient_rename_error(err: &io::Error) -> bool {
    // win32: ACCESS_DENIED(5), SHARING_VIOLATION(32), LOCK_VIOLATION(33),
    // DIR_NOT_EMPTY(145). Also accept the libc errno values used by injected
    // test errors for cross-platform test parity.
    matches!(
        err.raw_os_error(),
        Some(5) | Some(32) | Some(33) | Some(145) | Some(1) | Some(13) | Some(16) | Some(41)
    )
}

#[cfg(not(any(unix, windows)))]
fn is_transient_rename_error(_err: &io::Error) -> bool {
    false
}

fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt: u32 = 0;
    loop {
        match do_rename(from, to) {
            Ok(()) => return Ok(()),
            Err(err) => {
                let transient = is_transient_rename_error(&err);
                if !transient || attempt >= RENAME_MAX_ATTEMPTS - 1 {
                    return Err(err);
                }
                let backoff = std::cmp::min(100, 10 * (attempt as u64 + 1));
                std::thread::sleep(std::time::Duration::from_millis(backoff));
                attempt += 1;
            }
        }
    }
}

/// Like [`atomic_write`], but the destination file is only readable/writable by
/// the owning user (unix `0600`; Windows: a same-user-only DACL). The temp file
/// is created with restricted permissions *before* any bytes are written, so the
/// credential is never briefly world-readable.
pub fn atomic_write_owner_only(path: &Path, data: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let mut temp_os = path.as_os_str().to_os_string();
    temp_os.push(format!(".{pid}.{now_ms}.{counter}.tmp"));
    let temp_path = std::path::PathBuf::from(temp_os);

    write_owner_only(&temp_path, data)?;
    match rename_with_retry(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&temp_path);
            Err(err)
        }
    }
}

#[cfg(unix)]
fn write_owner_only(path: &Path, data: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(data)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(windows)]
fn write_owner_only(path: &Path, data: &[u8]) -> io::Result<()> {
    // On Windows a freshly created file under the user profile inherits an ACL
    // granting only the owner + SYSTEM/Administrators. $CLIMON_HOME lives under
    // the user profile, so a plain create is owner-restricted; if we later move
    // $CLIMON_HOME, tighten this with an explicit DACL. Documented in
    // docs/security.md.
    fs::write(path, data)
}

#[cfg(not(any(unix, windows)))]
fn write_owner_only(path: &Path, data: &[u8]) -> io::Result<()> {
    fs::write(path, data)
}

/// Writes `data` to `path` atomically (temp file then rename), creating parent
/// directories as needed. Mirrors `atomicWrite`.
pub fn atomic_write(path: &Path, data: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    // Append (never replace the extension) so the temp name can't collide with
    // the target's stem: `<path>.<pid>.<ms>.<n>.tmp`, matching `store.ts`.
    let mut temp_os = path.as_os_str().to_os_string();
    temp_os.push(format!(".{pid}.{now_ms}.{counter}.tmp"));
    let temp_path = std::path::PathBuf::from(temp_os);

    fs::write(&temp_path, data)?;
    match rename_with_retry(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&temp_path);
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn unique_dir(tag: &str) -> std::path::PathBuf {
        // Real local filesystem under the workspace target dir (gitignored), not
        // the system temp dir.
        let base = crate::test_support::scratch_dir(tag);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn eperm() -> io::Error {
        // Use a transient errno for cross-platform test parity (1 = EPERM).
        io::Error::from_raw_os_error(1)
    }

    #[test]
    fn retries_transient_rename_then_succeeds() {
        let dir = unique_dir("retry");
        let target = dir.join("retry-success.json");
        let attempts = std::sync::Arc::new(AtomicU32::new(0));
        let attempts_hook = attempts.clone();

        let guard = set_atomic_write_test_hook(move |from, to| {
            let n = attempts_hook.fetch_add(1, Ordering::SeqCst) + 1;
            if n < 3 {
                Err(eperm())
            } else {
                fs::rename(from, to)
            }
        });

        atomic_write(&target, b"{\"id\":\"retry-success\"}").unwrap();
        drop(guard);

        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "{\"id\":\"retry-success\"}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn owner_only_write_sets_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_dir("owner-only");
        let target = dir.join("secret.ipc-auth");
        atomic_write_owner_only(&target, b"top-secret").unwrap();
        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600, got {mode:o}");
        assert_eq!(fs::read(&target).unwrap(), b"top-secret");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn propagates_non_transient_rename_without_retry() {
        let dir = unique_dir("no-retry");
        let target = dir.join("no-retry.json");
        let attempts = std::sync::Arc::new(AtomicU32::new(0));
        let attempts_hook = attempts.clone();

        let guard = set_atomic_write_test_hook(move |_from, _to| {
            attempts_hook.fetch_add(1, Ordering::SeqCst);
            // ENOSPC (28) is not in the transient set.
            Err(io::Error::from_raw_os_error(28))
        });

        let result = atomic_write(&target, b"data");
        drop(guard);

        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
