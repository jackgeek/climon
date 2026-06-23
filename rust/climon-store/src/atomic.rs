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

fn temp_path_for(path: &Path) -> std::path::PathBuf {
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
    std::path::PathBuf::from(temp_os)
}

/// Writes `data` to `path` atomically (temp file then rename), creating parent
/// directories as needed. Mirrors `atomicWrite`.
pub fn atomic_write(path: &Path, data: &[u8]) -> io::Result<()> {
    atomic_write_with_mode(path, data, 0o666)
}

/// Like [`atomic_write`] but creates the temp file with `mode` (Unix) before
/// writing, so a secret-bearing file (e.g. the ingest beacon with controlToken)
/// is never world-readable even momentarily. On non-Unix, `mode` is ignored.
pub fn atomic_write_with_mode(path: &Path, data: &[u8], _mode: u32) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp_path = temp_path_for(path);

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(_mode)
            .open(&temp_path)?;
        file.write_all(data)?;
    }
    #[cfg(not(unix))]
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

    #[cfg(unix)]
    #[test]
    fn atomic_write_with_mode_sets_0600() {
        use std::os::unix::fs::PermissionsExt;

        let dir = unique_dir("mode");
        let target = dir.join("ingest.json");

        atomic_write_with_mode(&target, b"{\"controlToken\":\"x\"}", 0o600).unwrap();

        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }
}
