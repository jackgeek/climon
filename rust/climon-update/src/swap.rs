//! Atomic, no-kill binary swap. Port of `src/update/swap.ts`.
//!
//! The swap NEVER kills any process. On Unix it writes a temp file in the same
//! directory and `rename()`s it over the target; running processes keep their
//! old inode until they exit, so live sessions are never disrupted. On Windows a
//! running executable cannot be displaced, so the swap defers rather than kills.

use std::path::Path;

/// Outcome of an atomic swap attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SwapResult {
    /// True when the new bytes are now in place.
    pub applied: bool,
    /// True when application was deferred because the file was locked.
    pub deferred: bool,
}

/// Atomically replaces `dir/name` with `bytes` without killing any process.
///
/// The replacement preserves the existing target's permission bits (or defaults
/// to `0o755`) so the swapped-in binary stays executable.
pub fn replace_file_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<SwapResult, String> {
    let target = dir.join(name);
    let pid = std::process::id();
    let now = crate::clock::now_ms();
    let tmp = dir.join(format!("{name}.tmp-{pid}-{now}"));
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {} failed: {e}", tmp.display()))?;

    let result = (|| -> Result<SwapResult, String> {
        // Preserve the target's mode (these are executables); default to 0o755.
        let mode = current_mode(&target).unwrap_or(0o755);
        set_mode(&tmp, mode);

        if cfg!(windows) {
            return windows_swap(dir, name, &target, &tmp);
        }

        // Unix: atomic rename-over.
        std::fs::rename(&tmp, &target)
            .map_err(|e| format!("rename to {} failed: {e}", target.display()))?;
        Ok(SwapResult {
            applied: true,
            deferred: false,
        })
    })();

    // Remove the temp on any path that didn't consume it (defer/error).
    if tmp.exists() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(windows)]
fn windows_swap(dir: &Path, name: &str, target: &Path, tmp: &Path) -> Result<SwapResult, String> {
    let old = dir.join(format!("{name}.old"));
    if old.exists() {
        // A previous .old still locked; ignore and continue.
        let _ = std::fs::remove_file(&old);
    }
    let mut displaced = false;
    if target.exists() {
        match std::fs::rename(target, &old) {
            Ok(()) => displaced = true,
            Err(e) => {
                if is_busy(&e) {
                    return Ok(SwapResult {
                        applied: false,
                        deferred: true,
                    });
                }
                return Err(format!("displace {} failed: {e}", target.display()));
            }
        }
    }
    if let Err(e) = std::fs::rename(tmp, target) {
        // Final rename failed after displacing; restore the prior binary so the
        // install is never left with no executable at the expected path.
        if displaced {
            let _ = std::fs::rename(&old, target);
        }
        return Err(format!("rename to {} failed: {e}", target.display()));
    }
    Ok(SwapResult {
        applied: true,
        deferred: false,
    })
}

#[cfg(not(windows))]
fn windows_swap(
    _dir: &Path,
    _name: &str,
    _target: &Path,
    _tmp: &Path,
) -> Result<SwapResult, String> {
    unreachable!("windows_swap only invoked on Windows")
}

#[cfg(windows)]
fn is_busy(e: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    matches!(e.kind(), ErrorKind::PermissionDenied)
        || matches!(e.raw_os_error(), Some(32) | Some(33) | Some(5))
}

#[cfg(unix)]
fn current_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| m.mode() & 0o777)
}

#[cfg(not(unix))]
fn current_mode(_path: &Path) -> Option<u32> {
    None
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {
    // Best effort; non-unix filesystems manage executability differently.
}

/// Best-effort cleanup of leftover `.old` files from prior Windows swaps.
pub fn cleanup_old_files(dir: &Path, names: &[String]) {
    for name in names {
        let old = dir.join(format!("{name}.old"));
        if old.exists() {
            // Still locked by a running process; try again next time.
            let _ = std::fs::remove_file(&old);
        }
    }
}

/// Best-effort removal of files that are no longer part of the install set
/// (e.g. a retired `climon-beta` server bundle). These are data files that are
/// never executed, so they cannot be locked by a running process (even on
/// Windows); removal never kills anything and ignores all errors, retrying on
/// the next update. Also clears any leftover `.old` swap sibling.
pub fn remove_orphan_files(dir: &Path, names: &[&str]) {
    for name in names {
        let _ = std::fs::remove_file(dir.join(name));
        let _ = std::fs::remove_file(dir.join(format!("{name}.old")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn remove_orphan_files_deletes_named_files_and_old_siblings() {
        let d = tmp_dir();
        std::fs::write(d.path().join("climon-beta"), "stale").unwrap();
        std::fs::write(d.path().join("climon-beta.old"), "stale-old").unwrap();
        std::fs::write(d.path().join("climon"), "keep").unwrap();
        remove_orphan_files(d.path(), &["climon-beta"]);
        assert!(!d.path().join("climon-beta").exists());
        assert!(!d.path().join("climon-beta.old").exists());
        assert!(d.path().join("climon").exists());
    }

    #[test]
    fn remove_orphan_files_ignores_absent_files() {
        let d = tmp_dir();
        remove_orphan_files(d.path(), &["climon-beta"]);
        assert!(!d.path().join("climon-beta").exists());
    }

    #[test]
    fn replaces_an_existing_files_contents() {
        let d = tmp_dir();
        std::fs::write(d.path().join("climon"), "old").unwrap();
        let result = replace_file_atomic(d.path(), "climon", b"new").unwrap();
        assert!(result.applied);
        assert_eq!(std::fs::read(d.path().join("climon")).unwrap(), b"new");
    }

    #[test]
    fn creates_the_file_when_it_does_not_exist() {
        let d = tmp_dir();
        let result = replace_file_atomic(d.path(), "climon-server", b"data").unwrap();
        assert!(result.applied);
        assert_eq!(
            std::fs::read(d.path().join("climon-server")).unwrap(),
            b"data"
        );
    }

    #[test]
    fn does_not_leave_a_temp_file_behind_on_success() {
        let d = tmp_dir();
        replace_file_atomic(d.path(), "climon", b"x").unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(d.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn replacing_a_file_held_open_by_a_reader_still_succeeds() {
        let d = tmp_dir();
        let path = d.path().join("climon");
        std::fs::write(&path, "old").unwrap();
        let _reader = std::fs::File::open(&path).unwrap();
        let result = replace_file_atomic(d.path(), "climon", b"new").unwrap();
        assert!(result.applied);
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn the_swapped_in_file_is_executable() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp_dir();
        let path = d.path().join("climon");
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        replace_file_atomic(d.path(), "climon", b"new").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_ne!(mode & 0o111, 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_newly_created_binary_is_executable() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp_dir();
        replace_file_atomic(d.path(), "climon-server", b"data").unwrap();
        let mode = std::fs::metadata(d.path().join("climon-server"))
            .unwrap()
            .permissions()
            .mode();
        assert_ne!(mode & 0o111, 0);
    }
}
