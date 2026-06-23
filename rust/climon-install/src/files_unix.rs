//! Unix file placement for the installer. 1:1 port of `src/install/files-unix.ts`.
//!
//! Same shape as [`crate::files`] but keyed off the Unix manifest, adds
//! `ETXTBSY` to the locked-file set, and does not displace existing files
//! (overwrite-in-place is reliable on Unix).

use std::fs;
use std::path::Path;

use crate::files::{default_copy, errno_code, InstallBinariesOptions, InstallError};
use crate::manifest::{install_files_for_platform, Platform};

/// Unix copy-error codes that indicate the destination binary is locked.
const LOCKED_COPY_ERROR_CODES: &[&str] = &["EBUSY", "EACCES", "EPERM", "ETXTBSY"];

/// Whether an [`InstallError`] is a Unix locked-file copy error (incl. `ETXTBSY`).
pub fn is_locked_binary_copy_error(error: &InstallError) -> bool {
    matches!(&error.code, Some(code) if LOCKED_COPY_ERROR_CODES.contains(&code.as_str()))
}

fn copy_required_binaries(
    source_dir: &Path,
    install_dir: &Path,
    copy_file: &mut dyn FnMut(&Path, &Path) -> Result<(), InstallError>,
) -> Result<(), InstallError> {
    fs::create_dir_all(install_dir).map_err(|e| InstallError {
        code: errno_code(&e),
        message: e.to_string(),
    })?;

    for file in install_files_for_platform(Platform::Linux) {
        let source_path = source_dir.join(&file.source);
        if !source_path.exists() {
            return Err(InstallError::missing_sibling(&file.source));
        }
        let dest_path = install_dir.join(&file.dest);
        copy_file(&source_path, &dest_path)?;
        strip_quarantine(&dest_path);
    }
    Ok(())
}

/// Removes the macOS `com.apple.quarantine` extended attribute from a freshly
/// installed binary.
///
/// Files extracted from a downloaded `.zip` carry the quarantine attribute, and
/// `std::fs::copy` (via `copyfile`) propagates it to the installed copy. Because
/// the macOS binaries are not Developer ID signed + notarized, Gatekeeper then
/// refuses to launch the quarantined `climon-server` with "is damaged and can't
/// be opened". Stripping the attribute from the binaries the user just chose to
/// install lets them run — equivalent to `xattr -d com.apple.quarantine`.
///
/// Best effort: a missing attribute (`ENOATTR`) or any other error is ignored.
/// No-op on non-macOS targets.
#[cfg(target_os = "macos")]
fn strip_quarantine(path: &Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    const QUARANTINE: &[u8] = b"com.apple.quarantine\0";
    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
        return;
    };
    unsafe {
        libc::removexattr(
            c_path.as_ptr(),
            QUARANTINE.as_ptr() as *const libc::c_char,
            0,
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn strip_quarantine(_path: &Path) {}

/// Copies the manifest binaries into `install_dir`, with an opt-in locked-file
/// kill-and-retry path. Mirrors `installBinaries` in `src/install/files-unix.ts`.
pub fn install_binaries(
    source_dir: &Path,
    install_dir: &Path,
    options: InstallBinariesOptions<'_>,
) -> Result<(), InstallError> {
    let InstallBinariesOptions {
        copy_file,
        mut confirm_kill_and_retry,
        mut kill_running_climon_processes,
    } = options;

    let mut default = default_copy;
    let copy: &mut dyn FnMut(&Path, &Path) -> Result<(), InstallError> = match copy_file {
        Some(c) => c,
        None => &mut default,
    };

    match copy_required_binaries(source_dir, install_dir, copy) {
        Ok(()) => Ok(()),
        Err(error) => {
            let (Some(confirm), Some(kill)) = (
                confirm_kill_and_retry.as_mut(),
                kill_running_climon_processes.as_mut(),
            ) else {
                return Err(error);
            };
            if !is_locked_binary_copy_error(&error) {
                return Err(error);
            }
            if !confirm(&error) {
                return Err(error);
            }
            kill();
            copy_required_binaries(source_dir, install_dir, copy)
        }
    }
}

/// Writes the currently-installed version to a `.version` file so the next
/// upgrade can detect what was previously installed.
pub fn write_version_file(install_dir: &Path, version: &str) -> std::io::Result<()> {
    fs::write(install_dir.join(".version"), version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn temp_root() -> std::path::PathBuf {
        let dir = std::env::current_dir()
            .unwrap()
            .join(".copilot-tmp")
            .join("install-files-unix-test")
            .join(format!(
                "{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copies_install_as_climon_and_siblings() {
        let root = temp_root();
        let source_dir = root.join("src");
        let install_dir = root.join(".local").join("bin");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("install"), "client").unwrap();
        fs::write(source_dir.join("climon-server"), "server").unwrap();

        install_binaries(&source_dir, &install_dir, InstallBinariesOptions::default()).unwrap();

        assert_eq!(
            fs::read_to_string(install_dir.join("climon")).unwrap(),
            "client"
        );
        assert_eq!(
            fs::read_to_string(install_dir.join("climon-server")).unwrap(),
            "server"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn throws_when_required_sibling_missing() {
        let root = temp_root();
        let source_dir = root.join("src");
        let install_dir = root.join(".local").join("bin");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("install"), "client").unwrap();

        let err = install_binaries(&source_dir, &install_dir, InstallBinariesOptions::default())
            .unwrap_err();
        assert_eq!(
            err.message,
            "Required installer sibling is missing: climon-server"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn identifies_unix_locked_file_errors_including_etxtbsy() {
        assert!(is_locked_binary_copy_error(&InstallError::with_code(
            "EBUSY", "busy"
        )));
        assert!(is_locked_binary_copy_error(&InstallError::with_code(
            "EACCES", "denied"
        )));
        assert!(is_locked_binary_copy_error(&InstallError::with_code(
            "EPERM",
            "permission"
        )));
        assert!(is_locked_binary_copy_error(&InstallError::with_code(
            "ETXTBSY",
            "text busy"
        )));
        assert!(!is_locked_binary_copy_error(&InstallError::with_code(
            "ENOENT", "missing"
        )));
    }

    #[test]
    fn prompts_to_kill_and_retries_on_locked_binary() {
        let root = temp_root();
        let source_dir = root.join("src");
        let install_dir = root.join(".local").join("bin");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("install"), "client").unwrap();
        fs::write(source_dir.join("climon-server"), "server").unwrap();

        let climon_attempts = Cell::new(0);
        let prompted = Cell::new(0);
        let killed = Cell::new(0);

        let mut copy = |source: &Path, dest: &Path| -> Result<(), InstallError> {
            let name = dest.file_name().and_then(|n| n.to_str());
            if name == Some("climon") && climon_attempts.replace(climon_attempts.get() + 1) == 0 {
                return Err(InstallError::with_code("ETXTBSY", "text busy"));
            }
            fs::copy(source, dest).unwrap();
            Ok(())
        };
        let mut confirm = |_e: &InstallError| {
            prompted.set(prompted.get() + 1);
            true
        };
        let mut kill = || killed.set(killed.get() + 1);

        install_binaries(
            &source_dir,
            &install_dir,
            InstallBinariesOptions {
                copy_file: Some(&mut copy),
                confirm_kill_and_retry: Some(&mut confirm),
                kill_running_climon_processes: Some(&mut kill),
            },
        )
        .unwrap();

        assert_eq!(prompted.get(), 1);
        assert_eq!(killed.get(), 1);
        assert_eq!(
            fs::read_to_string(install_dir.join("climon")).unwrap(),
            "client"
        );
        assert_eq!(
            fs::read_to_string(install_dir.join("climon-server")).unwrap(),
            "server"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[cfg(target_os = "macos")]
    const QUARANTINE_XATTR: &[u8] = b"com.apple.quarantine\0";

    #[cfg(target_os = "macos")]
    fn set_quarantine(path: &Path) {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
        let value = b"0081;00000000;Safari;";
        let rc = unsafe {
            libc::setxattr(
                c_path.as_ptr(),
                QUARANTINE_XATTR.as_ptr() as *const libc::c_char,
                value.as_ptr() as *const libc::c_void,
                value.len(),
                0,
                0,
            )
        };
        assert_eq!(
            rc,
            0,
            "setxattr failed: {}",
            std::io::Error::last_os_error()
        );
    }

    #[cfg(target_os = "macos")]
    fn has_quarantine(path: &Path) -> bool {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
        let rc = unsafe {
            libc::getxattr(
                c_path.as_ptr(),
                QUARANTINE_XATTR.as_ptr() as *const libc::c_char,
                std::ptr::null_mut(),
                0,
                0,
                0,
            )
        };
        rc >= 0
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn strip_quarantine_removes_the_attribute() {
        let root = temp_root();
        let path = root.join("binary");
        fs::write(&path, "bin").unwrap();
        set_quarantine(&path);
        assert!(has_quarantine(&path), "precondition: xattr should be set");

        super::strip_quarantine(&path);

        assert!(
            !has_quarantine(&path),
            "com.apple.quarantine should be removed"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn strip_quarantine_is_noop_when_attribute_absent() {
        let root = temp_root();
        let path = root.join("binary");
        fs::write(&path, "bin").unwrap();

        // Must not panic or error when there is nothing to remove.
        super::strip_quarantine(&path);

        assert!(!has_quarantine(&path));
        fs::remove_dir_all(&root).ok();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn install_strips_quarantine_from_installed_binaries() {
        let root = temp_root();
        let source_dir = root.join("src");
        let install_dir = root.join(".local").join("bin");
        fs::create_dir_all(&source_dir).unwrap();
        for name in ["install", "climon-server", "climon-beta"] {
            let p = source_dir.join(name);
            fs::write(&p, "bin").unwrap();
            set_quarantine(&p);
        }

        install_binaries(&source_dir, &install_dir, InstallBinariesOptions::default()).unwrap();

        for name in ["climon", "climon-server", "climon-beta"] {
            let installed = install_dir.join(name);
            assert!(installed.exists(), "{name} should be installed");
            assert!(
                !has_quarantine(&installed),
                "{name} should not be quarantined after install"
            );
        }
        fs::remove_dir_all(&root).ok();
    }
}
