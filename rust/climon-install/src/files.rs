//! Windows file placement for the installer. 1:1 port of `src/install/files.ts`.
//!
//! Copies the manifest binaries into the install directory, displacing any
//! locked existing file out of the way first (antivirus/indexer can hold a
//! handle that blocks overwrite but still allows an in-directory rename), and
//! offers an opt-in "kill running climon and retry" path for locked binaries.

use std::fs;
use std::path::Path;

use crate::manifest::{install_files_for_platform, Platform};

/// Windows copy-error codes that indicate the destination binary is locked.
const LOCKED_COPY_ERROR_CODES: &[&str] = &["EBUSY", "EACCES", "EPERM"];

/// An installer copy failure. Mirrors the Node `Error` with an optional `.code`
/// string used to detect locked-file conditions.
#[derive(Debug, Clone)]
pub struct InstallError {
    pub code: Option<String>,
    pub message: String,
}

impl InstallError {
    /// Builds the "Required installer sibling is missing" error (no `.code`).
    pub fn missing_sibling(source: &str) -> InstallError {
        InstallError {
            code: None,
            message: format!("Required installer sibling is missing: {source}"),
        }
    }

    /// Builds a copy error carrying an OS error `code` (e.g. `EBUSY`).
    pub fn with_code(code: &str, message: &str) -> InstallError {
        InstallError {
            code: Some(code.to_string()),
            message: message.to_string(),
        }
    }
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for InstallError {}

/// A pluggable file-copy operation (`copyFileSync` by default).
pub type CopyFile<'a> = &'a mut dyn FnMut(&Path, &Path) -> Result<(), InstallError>;
/// Prompt callback invoked when a locked binary is hit; returns whether to kill+retry.
pub type ConfirmKillAndRetry<'a> = &'a mut dyn FnMut(&InstallError) -> bool;
/// Callback that terminates running climon processes before a retry.
pub type KillRunning<'a> = &'a mut dyn FnMut();

/// Injectable I/O for [`install_binaries`], mirroring the TS options bag.
#[derive(Default)]
pub struct InstallBinariesOptions<'a> {
    pub copy_file: Option<CopyFile<'a>>,
    pub confirm_kill_and_retry: Option<ConfirmKillAndRetry<'a>>,
    pub kill_running_climon_processes: Option<KillRunning<'a>>,
}

/// Whether an [`InstallError`] is a Windows locked-file copy error.
pub fn is_locked_binary_copy_error(error: &InstallError) -> bool {
    matches!(&error.code, Some(code) if LOCKED_COPY_ERROR_CODES.contains(&code.as_str()))
}

/// Default copy: `std::fs::copy`, mapping OS errors to `.code` strings so the
/// locked-file retry path keys off the same codes as the Node installer.
pub(crate) fn default_copy(source: &Path, dest: &Path) -> Result<(), InstallError> {
    fs::copy(source, dest)
        .map(|_| ())
        .map_err(|e| InstallError {
            code: errno_code(&e),
            message: e.to_string(),
        })
}

/// Maps an `io::Error` to the Node-style errno code string used for locked
/// detection. Unmapped errors carry no code (treated as non-locked).
pub(crate) fn errno_code(error: &std::io::Error) -> Option<String> {
    let raw = error.raw_os_error()?;
    let name = if raw == EBUSY {
        "EBUSY"
    } else if raw == EACCES {
        "EACCES"
    } else if raw == EPERM {
        "EPERM"
    } else if raw == ETXTBSY {
        "ETXTBSY"
    } else if raw == ENOENT {
        "ENOENT"
    } else {
        return None;
    };
    Some(name.to_string())
}

#[cfg(unix)]
const EBUSY: i32 = libc::EBUSY;
#[cfg(unix)]
const EACCES: i32 = libc::EACCES;
#[cfg(unix)]
const EPERM: i32 = libc::EPERM;
#[cfg(unix)]
const ETXTBSY: i32 = libc::ETXTBSY;
#[cfg(unix)]
const ENOENT: i32 = libc::ENOENT;
// Windows errno values from the C runtime (`errno.h`).
#[cfg(not(unix))]
const EBUSY: i32 = 16;
#[cfg(not(unix))]
const EACCES: i32 = 13;
#[cfg(not(unix))]
const EPERM: i32 = 1;
#[cfg(not(unix))]
const ETXTBSY: i32 = 26;
#[cfg(not(unix))]
const ENOENT: i32 = 2;

/// Move an existing destination file out of the way before overwriting. On
/// Windows, AV or the indexer can hold a handle that prevents overwrite but
/// still allows a rename within the same directory.
fn displace_existing(dest_path: &Path) {
    if !dest_path.exists() {
        return;
    }
    let mut displaced = dest_path.as_os_str().to_os_string();
    displaced.push(".old");
    if fs::rename(dest_path, &displaced).is_err() {
        // If rename also fails, fall through and let the copy report the error.
        return;
    }
    // Best-effort cleanup of the displaced file.
    let _ = fs::remove_file(&displaced);
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

    for file in install_files_for_platform(Platform::Windows) {
        let source_path = source_dir.join(&file.source);
        if !source_path.exists() {
            return Err(InstallError::missing_sibling(&file.source));
        }
        let dest_path = install_dir.join(&file.dest);
        displace_existing(&dest_path);
        copy_file(&source_path, &dest_path)?;
    }
    Ok(())
}

fn with_locked_retry(
    mut place_once: impl FnMut() -> Result<(), InstallError>,
    mut confirm_kill_and_retry: Option<ConfirmKillAndRetry<'_>>,
    mut kill_running_climon_processes: Option<KillRunning<'_>>,
) -> Result<(), InstallError> {
    match place_once() {
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
            place_once()
        }
    }
}

/// Copies the manifest binaries into `install_dir`, with an opt-in locked-file
/// kill-and-retry path. Mirrors `installBinaries` in `src/install/files.ts`.
pub fn install_binaries(
    source_dir: &Path,
    install_dir: &Path,
    options: InstallBinariesOptions<'_>,
) -> Result<(), InstallError> {
    let InstallBinariesOptions {
        copy_file,
        confirm_kill_and_retry,
        kill_running_climon_processes,
    } = options;

    let mut default = default_copy;
    let copy: &mut dyn FnMut(&Path, &Path) -> Result<(), InstallError> = match copy_file {
        Some(c) => c,
        None => &mut default,
    };

    with_locked_retry(
        || copy_required_binaries(source_dir, install_dir, copy),
        confirm_kill_and_retry,
        kill_running_climon_processes,
    )
}

/// The Windows install-dir filenames for `version`, in placement order
/// (versioned payloads, then stubs, then the pointer files last).
pub fn windows_layout_files(version: &str) -> Vec<String> {
    vec![
        format!("climon-{version}.dll"),
        format!("climon-server-{version}.exe"),
        "climon.exe".to_string(),
        "climon-server.exe".to_string(),
        "climon.version".to_string(),
        "climon-server.version".to_string(),
    ]
}

#[cfg(target_os = "windows")]
fn write_file(install_dir: &Path, name: &str, contents: &[u8]) -> Result<(), InstallError> {
    fs::create_dir_all(install_dir).map_err(|e| InstallError {
        code: errno_code(&e),
        message: e.to_string(),
    })?;
    fs::write(install_dir.join(name), contents).map_err(|e| InstallError {
        code: errno_code(&e),
        message: e.to_string(),
    })
}

#[cfg(target_os = "windows")]
fn write_text(install_dir: &Path, name: &str, contents: &str) -> Result<(), InstallError> {
    write_file(install_dir, name, contents.as_bytes())
}

#[cfg(target_os = "windows")]
fn place_stub(install_dir: &Path, name: &str, contents: &[u8]) -> Result<(), InstallError> {
    fs::create_dir_all(install_dir).map_err(|e| InstallError {
        code: errno_code(&e),
        message: e.to_string(),
    })?;
    let dest_path = install_dir.join(name);
    displace_existing(&dest_path);
    fs::write(dest_path, contents).map_err(|e| InstallError {
        code: errno_code(&e),
        message: e.to_string(),
    })
}

#[cfg(target_os = "windows")]
fn place_windows_layout_once(
    install_dir: &Path,
    version: &str,
    stub_client: &[u8],
    stub_server: &[u8],
    client_dll: &[u8],
    server_exe: &[u8],
) -> Result<(), InstallError> {
    // Order matters for crash-safety. The pointer files (`*.version`) are both
    // the runtime resolution target AND the migration-complete signal
    // (`should_migrate_legacy` re-runs only while `climon.version` is absent).
    // Write the versioned payloads and the stubs FIRST, then the pointers LAST,
    // so a failure partway through leaves no pointer — the next update re-runs
    // migration and the install is never stranded without a client entrypoint.
    write_file(install_dir, &format!("climon-{version}.dll"), client_dll)?;
    write_file(
        install_dir,
        &format!("climon-server-{version}.exe"),
        server_exe,
    )?;
    place_stub(install_dir, "climon.exe", stub_client)?;
    place_stub(install_dir, "climon-server.exe", stub_server)?;
    write_text(install_dir, "climon.version", &format!("{version}\n"))?;
    write_text(
        install_dir,
        "climon-server.version",
        &format!("{version}\n"),
    )?;
    Ok(())
}

/// Places the Windows binary layout with the same opt-in locked-file kill/retry
/// path as [`install_binaries`].
#[cfg(target_os = "windows")]
pub fn place_windows_layout_with_options(
    install_dir: &Path,
    version: &str,
    stub_client: &[u8],
    stub_server: &[u8],
    client_dll: &[u8],
    server_exe: &[u8],
    options: InstallBinariesOptions<'_>,
) -> Result<(), InstallError> {
    let InstallBinariesOptions {
        copy_file: _,
        confirm_kill_and_retry,
        kill_running_climon_processes,
    } = options;
    with_locked_retry(
        || {
            place_windows_layout_once(
                install_dir,
                version,
                stub_client,
                stub_server,
                client_dll,
                server_exe,
            )
        },
        confirm_kill_and_retry,
        kill_running_climon_processes,
    )
}

/// Places the Windows binary layout: two stubs, two versioned artifacts, and
/// two pointer files. `stub_client`/`stub_server` are the stub bytes; the
/// versioned artifacts come from the extracted zip (`climon.dll`,
/// `climon-server.exe`).
#[cfg(target_os = "windows")]
pub fn place_windows_layout(
    install_dir: &Path,
    version: &str,
    stub_client: &[u8],
    stub_server: &[u8],
    client_dll: &[u8],
    server_exe: &[u8],
) -> Result<(), InstallError> {
    place_windows_layout_with_options(
        install_dir,
        version,
        stub_client,
        stub_server,
        client_dll,
        server_exe,
        InstallBinariesOptions::default(),
    )
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
            .join("install-files-test")
            .join(format!(
                "{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn layout_lists_versioned_stubs_and_pointers() {
        let f = windows_layout_files("3.2.1");
        assert!(f.contains(&"climon-3.2.1.dll".to_string()));
        assert!(f.contains(&"climon-server-3.2.1.exe".to_string()));
        assert!(f.contains(&"climon.version".to_string()));
        assert!(f.contains(&"climon.exe".to_string()));
        assert_eq!(
            f,
            vec![
                "climon-3.2.1.dll".to_string(),
                "climon-server-3.2.1.exe".to_string(),
                "climon.exe".to_string(),
                "climon-server.exe".to_string(),
                "climon.version".to_string(),
                "climon-server.version".to_string(),
            ]
        );
    }

    #[test]
    fn copies_windows_manifest_artifacts() {
        let root = temp_root();
        let source_dir = root.join("src");
        let install_dir = root.join("Programs").join("climon");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("climon.dll"), "client").unwrap();
        fs::write(source_dir.join("climon-server.exe"), "server").unwrap();

        install_binaries(&source_dir, &install_dir, InstallBinariesOptions::default()).unwrap();

        assert_eq!(
            fs::read_to_string(install_dir.join("climon.dll")).unwrap(),
            "client"
        );
        assert_eq!(
            fs::read_to_string(install_dir.join("climon-server.exe")).unwrap(),
            "server"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn throws_when_required_sibling_missing() {
        let root = temp_root();
        let source_dir = root.join("src");
        let install_dir = root.join("Programs").join("climon");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("climon.dll"), "client").unwrap();

        let err = install_binaries(&source_dir, &install_dir, InstallBinariesOptions::default())
            .unwrap_err();
        assert_eq!(
            err.message,
            "Required installer sibling is missing: climon-server.exe"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn identifies_windows_locked_file_errors() {
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
        assert!(!is_locked_binary_copy_error(&InstallError::with_code(
            "ENOENT", "missing"
        )));
    }

    #[test]
    fn prompts_to_kill_and_retries_when_locked() {
        let root = temp_root();
        let source_dir = root.join("src");
        let install_dir = root.join("Programs").join("climon");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("climon.dll"), "client").unwrap();
        fs::write(source_dir.join("climon-server.exe"), "server").unwrap();

        let climon_attempts = Cell::new(0);
        let prompted = Cell::new(0);
        let killed = Cell::new(0);

        let mut copy = |source: &Path, dest: &Path| -> Result<(), InstallError> {
            if dest.file_name().and_then(|n| n.to_str()) == Some("climon.dll")
                && climon_attempts.replace(climon_attempts.get() + 1) == 0
            {
                return Err(InstallError::with_code("EBUSY", "locked"));
            }
            fs::copy(source, dest).unwrap();
            Ok(())
        };
        let mut confirm = |error: &InstallError| {
            prompted.set(prompted.get() + 1);
            assert!(is_locked_binary_copy_error(error));
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
            fs::read_to_string(install_dir.join("climon.dll")).unwrap(),
            "client"
        );
        assert_eq!(
            fs::read_to_string(install_dir.join("climon-server.exe")).unwrap(),
            "server"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn does_not_retry_when_user_declines() {
        let root = temp_root();
        let source_dir = root.join("src");
        let install_dir = root.join("Programs").join("climon");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("climon.dll"), "client").unwrap();
        fs::write(source_dir.join("climon-server.exe"), "server").unwrap();

        let killed = Cell::new(0);
        let mut copy = |_s: &Path, _d: &Path| -> Result<(), InstallError> {
            Err(InstallError::with_code("EPERM", "locked"))
        };
        let mut confirm = |_e: &InstallError| false;
        let mut kill = || killed.set(killed.get() + 1);

        let err = install_binaries(
            &source_dir,
            &install_dir,
            InstallBinariesOptions {
                copy_file: Some(&mut copy),
                confirm_kill_and_retry: Some(&mut confirm),
                kill_running_climon_processes: Some(&mut kill),
            },
        )
        .unwrap_err();

        assert_eq!(err.message, "locked");
        assert_eq!(killed.get(), 0);
        fs::remove_dir_all(&root).ok();
    }
}
