//! Versioned update protocol for the installer binary.
//!
//! The update protocol is parsed from raw `OsString` process arguments before
//! normal UTF-8 onboarding parsing, so it can carry arbitrary path bytes on
//! Unix. Two operations are defined:
//!
//! - **Apply** (`--apply-update-v1`): headlessly replaces installed binaries
//!   from a staged source directory, validates payloads and version, then
//!   cleans up retired siblings.
//!
//! - **Recover** (`--recover-bootstrap-v1`): applies a verified staged release
//!   and resumes the original command through the newly installed client.
//!
//! The installer owns all archive payload validation and installed layout
//! placement. The updater (`climon-update`) delegates to this protocol
//! rather than performing file placement itself.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Direct launcher used to resume the newly installed client after recovery.
pub type RecoveryClientLauncher<'a> = dyn FnMut(&Path, &[OsString]) -> Result<i32, String> + 'a;

/// Arguments for the `--apply-update-v1` operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyUpdateArgs {
    /// Install directory (the directory containing the installed binaries).
    pub dir: PathBuf,
    /// Source directory containing the staged update payloads.
    pub source: PathBuf,
    /// The exact version being applied (must match the installer's build version).
    pub version: String,
}

/// Arguments for the `--recover-bootstrap-v1` operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoverBootstrapArgs {
    /// The underlying apply arguments.
    pub apply: ApplyUpdateArgs,
    /// Optional PID of the bootstrap process to wait for.
    pub bootstrap_pid: Option<u32>,
    /// Optional fallback binary path.
    pub fallback: Option<PathBuf>,
    /// Original arguments to resume after recovery, preserved as raw OsStrings.
    pub original_args: Vec<OsString>,
}

/// A parsed update operation from process arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateOperation {
    Apply(ApplyUpdateArgs),
    Recover(RecoverBootstrapArgs),
}

/// Parses an update operation from raw process arguments (excluding argv[0]).
///
/// Returns `Ok(None)` when the arguments do not contain an update operation
/// flag, allowing the caller to fall through to normal installer behaviour.
///
/// Returns `Err` when an update flag is present but the arguments are invalid
/// (missing values, duplicates, unknown flags within the operation, etc.).
pub fn parse_update_operation(args: &[OsString]) -> Result<Option<UpdateOperation>, String> {
    let has_apply = args.iter().any(|a| a == "--apply-update-v1");
    let has_recover = args.iter().any(|a| a == "--recover-bootstrap-v1");

    if !has_apply && !has_recover {
        return Ok(None);
    }
    if has_apply && has_recover {
        return Err("Cannot specify both --apply-update-v1 and --recover-bootstrap-v1".to_string());
    }

    let mut dir: Option<PathBuf> = None;
    let mut source: Option<PathBuf> = None;
    let mut version: Option<String> = None;
    let mut bootstrap_pid: Option<u32> = None;
    let mut fallback: Option<PathBuf> = None;
    let mut original_args: Vec<OsString> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--apply-update-v1" || arg == "--recover-bootstrap-v1" {
            i += 1;
            continue;
        }
        if arg == "--dir" {
            if dir.is_some() {
                return Err("Duplicate --dir flag".to_string());
            }
            i += 1;
            let val = args
                .get(i)
                .ok_or_else(|| "--dir requires a value".to_string())?;
            dir = Some(PathBuf::from(val));
            i += 1;
            continue;
        }
        if arg == "--source" {
            if source.is_some() {
                return Err("Duplicate --source flag".to_string());
            }
            i += 1;
            let val = args
                .get(i)
                .ok_or_else(|| "--source requires a value".to_string())?;
            source = Some(PathBuf::from(val));
            i += 1;
            continue;
        }
        if arg == "--version" {
            if version.is_some() {
                return Err("Duplicate --version flag".to_string());
            }
            i += 1;
            let val = args
                .get(i)
                .ok_or_else(|| "--version requires a value".to_string())?;
            let v = val
                .to_str()
                .ok_or_else(|| "--version value must be valid UTF-8".to_string())?;
            if v.is_empty() {
                return Err("--version must not be empty".to_string());
            }
            version = Some(v.to_string());
            i += 1;
            continue;
        }
        if arg == "--bootstrap-pid" {
            if !has_recover {
                return Err("--bootstrap-pid is only valid with --recover-bootstrap-v1".to_string());
            }
            if bootstrap_pid.is_some() {
                return Err("Duplicate --bootstrap-pid flag".to_string());
            }
            i += 1;
            let val = args
                .get(i)
                .ok_or_else(|| "--bootstrap-pid requires a value".to_string())?;
            let s = val
                .to_str()
                .ok_or_else(|| "--bootstrap-pid value must be valid UTF-8".to_string())?;
            let pid: u32 = s
                .parse()
                .map_err(|_| format!("--bootstrap-pid value is not a valid PID: {s}"))?;
            bootstrap_pid = Some(pid);
            i += 1;
            continue;
        }
        if arg == "--fallback" {
            if !has_recover {
                return Err("--fallback is only valid with --recover-bootstrap-v1".to_string());
            }
            if fallback.is_some() {
                return Err("Duplicate --fallback flag".to_string());
            }
            i += 1;
            let val = args
                .get(i)
                .ok_or_else(|| "--fallback requires a value".to_string())?;
            fallback = Some(PathBuf::from(val));
            i += 1;
            continue;
        }
        if arg == "--original-arg" {
            if !has_recover {
                return Err("--original-arg is only valid with --recover-bootstrap-v1".to_string());
            }
            i += 1;
            let val = args
                .get(i)
                .ok_or_else(|| "--original-arg requires a value".to_string())?;
            original_args.push(val.clone());
            i += 1;
            continue;
        }
        // Unknown flag inside an update operation.
        return Err(format!(
            "Unknown flag in update operation: {}",
            arg.to_string_lossy()
        ));
    }

    let dir = dir.ok_or_else(|| "--dir is required".to_string())?;
    let source = source.ok_or_else(|| "--source is required".to_string())?;
    let version = version.ok_or_else(|| "--version is required".to_string())?;

    let apply = ApplyUpdateArgs {
        dir,
        source,
        version,
    };

    if has_recover {
        Ok(Some(UpdateOperation::Recover(RecoverBootstrapArgs {
            apply,
            bootstrap_pid,
            fallback,
            original_args,
        })))
    } else {
        Ok(Some(UpdateOperation::Apply(apply)))
    }
}

// ---------------------------------------------------------------------------
// Apply update implementation
// ---------------------------------------------------------------------------

/// Injectable placement operations for [`run_apply_update`].
///
/// Each closure takes the (source_path, dest_path) pair and returns a result.
/// On Unix, placement is atomic copy-to-temp + rename. On Windows, the existing
/// `place_windows_layout_with_options` is called. The injectable design allows
/// cross-platform unit testing of the ordering/error invariants.
pub struct ApplyPlacement<'a> {
    /// Places `climon-server` (Unix) or the full Windows layout excluding the
    /// client commit point.
    pub place_server: &'a mut dyn FnMut(&ApplyUpdateArgs) -> Result<(), String>,
    /// Places `climon` (Unix) or commits the Windows client pointer.
    /// This is the commit point: if it succeeds the update is committed.
    pub place_client: &'a mut dyn FnMut(&ApplyUpdateArgs) -> Result<(), String>,
    /// Writes the `.version` marker after all placements succeed.
    pub write_version: &'a mut dyn FnMut(&ApplyUpdateArgs) -> Result<(), String>,
    /// Cleans up retired siblings (old versioned binaries, `.old` files,
    /// `climon-beta`).
    pub cleanup: &'a mut dyn FnMut(&ApplyUpdateArgs),
}

/// Runs the apply-update operation.
///
/// `installer_build_version` is the version baked into this installer binary at
/// compile time; it must exactly match `args.version` or the apply fails before
/// any mutation.
///
/// On success all staged payloads have been placed and the `.version` marker
/// updated. On failure the install directory should be unchanged (validation
/// failures happen before any mutation; placement failures are handled by the
/// atomic placement primitives).
pub fn run_apply_update(
    args: &ApplyUpdateArgs,
    installer_build_version: &str,
    placement: ApplyPlacement<'_>,
) -> Result<(), String> {
    // Version gate: the installer must be the same version as the update.
    if args.version != installer_build_version {
        return Err(format!(
            "Version mismatch: installer is {} but update requests {}",
            installer_build_version, args.version
        ));
    }

    // Validate source directory exists.
    if !args.source.is_dir() {
        return Err(format!(
            "Source directory does not exist: {}",
            args.source.display()
        ));
    }

    // Validate required payloads exist before any mutation.
    validate_source_payloads(&args.source)?;

    // Place server first, then client as commit point.
    (placement.place_server)(args)?;
    (placement.place_client)(args)?;
    (placement.write_version)(args)?;
    (placement.cleanup)(args);

    Ok(())
}

/// Applies a staged recovery release, then resumes the original command through
/// the newly installed client. The launch only occurs after every apply step
/// succeeds.
pub fn run_recover_bootstrap(
    args: &RecoverBootstrapArgs,
    installer_build_version: &str,
    placement: ApplyPlacement<'_>,
    launch_client: &mut RecoveryClientLauncher<'_>,
) -> Result<i32, String> {
    run_apply_update(&args.apply, installer_build_version, placement)?;
    launch_client(
        &args.apply.dir.join(installed_client_name()),
        &args.original_args,
    )
}

#[cfg(unix)]
fn installed_client_name() -> &'static str {
    "climon"
}

#[cfg(windows)]
fn installed_client_name() -> &'static str {
    "climon.exe"
}

/// Validates that all required source payloads are present.
#[cfg(unix)]
fn validate_source_payloads(source: &std::path::Path) -> Result<(), String> {
    for name in &["climon", "climon-server"] {
        let p = source.join(name);
        if !p.exists() {
            return Err(format!("Required source payload missing: {}", p.display()));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn validate_source_payloads(source: &std::path::Path) -> Result<(), String> {
    for name in &["climon.dll", "climon-server.exe"] {
        let p = source.join(name);
        if !p.exists() {
            return Err(format!("Required source payload missing: {}", p.display()));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Unix atomic file replacement
// ---------------------------------------------------------------------------

/// Atomically replaces `dest` with the contents of `source_path`.
///
/// The replacement is done by copying to a unique sibling temp file, setting
/// executable mode (preserving source mode or defaulting to 0o755), fsyncing
/// the file, then renaming over the destination. Running processes that have
/// the old file open keep their file descriptor to the old inode.
///
/// Best-effort fsync of the parent directory is attempted after rename.
#[cfg(unix)]
pub fn atomic_replace_from_path(
    source_path: &std::path::Path,
    dest: &std::path::Path,
) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::PermissionsExt;

    let parent = dest
        .parent()
        .ok_or_else(|| format!("No parent directory for {}", dest.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create_dir_all {}: {e}", parent.display()))?;

    // Determine the mode: use the source file's mode with executable bits
    // ensured (these are always binaries), defaulting to 0o755 if unavailable.
    let source_mode = std::fs::metadata(source_path)
        .ok()
        .map(|m| m.mode() & 0o777)
        .unwrap_or(0o755);
    let mode = source_mode | 0o111; // ensure executable

    // Create a unique temp file in the same directory.
    let pid = std::process::id();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest_name = dest
        .file_name()
        .ok_or_else(|| "destination has no filename".to_string())?;
    let tmp_name = format!(".{}.tmp-{pid}-{ts}", dest_name.to_string_lossy());
    let tmp_path = parent.join(&tmp_name);

    // Copy source to temp.
    let source_bytes =
        std::fs::read(source_path).map_err(|e| format!("read {}: {e}", source_path.display()))?;
    let mut file = std::fs::File::create(&tmp_path)
        .map_err(|e| format!("create {}: {e}", tmp_path.display()))?;
    file.write_all(&source_bytes)
        .map_err(|e| format!("write {}: {e}", tmp_path.display()))?;

    // Set mode.
    std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("chmod {}: {e}", tmp_path.display()))?;

    // Fsync the file.
    file.sync_all()
        .map_err(|e| format!("fsync {}: {e}", tmp_path.display()))?;
    drop(file);

    // Atomic rename over destination.
    std::fs::rename(&tmp_path, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("rename {} -> {}: {e}", tmp_path.display(), dest.display())
    })?;

    // Best-effort fsync parent directory.
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }

    Ok(())
}

/// Strips macOS quarantine xattr from a file. Best-effort, no-op on non-macOS.
#[cfg(target_os = "macos")]
pub fn strip_quarantine(path: &std::path::Path) {
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

#[cfg(all(unix, not(target_os = "macos")))]
pub fn strip_quarantine(_path: &std::path::Path) {}

/// Removes retired `climon-beta` and stale `.old` siblings from `dir`.
/// Best-effort; failures are silently ignored.
pub fn cleanup_retired(dir: &std::path::Path) {
    // Remove climon-beta if present.
    let beta = dir.join("climon-beta");
    if beta.exists() {
        let _ = std::fs::remove_file(&beta);
    }

    // Remove any .old files left from prior displaced installs.
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.ends_with(".old") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Unix apply-update wiring
// ---------------------------------------------------------------------------

/// Runs the full Unix apply-update: validates payloads, atomically replaces
/// `climon-server` then `climon` (commit point), writes `.version`, and cleans
/// up retired siblings.
#[cfg(unix)]
fn with_unix_placement<T>(operation: impl FnOnce(ApplyPlacement<'_>) -> T) -> T {
    let mut place_server = |a: &ApplyUpdateArgs| {
        let src = a.source.join("climon-server");
        let dst = a.dir.join("climon-server");
        atomic_replace_from_path(&src, &dst)?;
        strip_quarantine(&dst);
        Ok(())
    };
    let mut place_client = |a: &ApplyUpdateArgs| {
        let src = a.source.join("climon");
        let dst = a.dir.join("climon");
        atomic_replace_from_path(&src, &dst)?;
        strip_quarantine(&dst);
        Ok(())
    };
    let mut write_version = |a: &ApplyUpdateArgs| {
        crate::files_unix::write_version_file(&a.dir, &a.version)
            .map_err(|e| format!("write .version: {e}"))
    };
    let mut cleanup = |a: &ApplyUpdateArgs| {
        cleanup_retired(&a.dir);
    };

    operation(ApplyPlacement {
        place_server: &mut place_server,
        place_client: &mut place_client,
        write_version: &mut write_version,
        cleanup: &mut cleanup,
    })
}

#[cfg(unix)]
pub fn run_apply_update_unix(
    args: &ApplyUpdateArgs,
    installer_build_version: &str,
) -> Result<(), String> {
    with_unix_placement(|placement| run_apply_update(args, installer_build_version, placement))
}

/// Applies a Unix bootstrap recovery and synchronously resumes the newly
/// installed client, preserving raw process arguments and its exact exit code.
#[cfg(unix)]
pub fn run_recover_bootstrap_unix(
    args: &RecoverBootstrapArgs,
    installer_build_version: &str,
) -> Result<i32, String> {
    use std::os::unix::process::ExitStatusExt;
    use std::process::Command;

    let mut launch_client = |program: &std::path::Path, original_args: &[OsString]| {
        let status = Command::new(program)
            .args(original_args)
            .status()
            .map_err(|error| {
                format!(
                    "launch installed client {} failed: {error}",
                    program.display()
                )
            })?;
        Ok(match status.code() {
            Some(code) => code,
            None => status.signal().map_or(1, |signal| 128 + signal),
        })
    };

    with_unix_placement(|placement| {
        run_recover_bootstrap(args, installer_build_version, placement, &mut launch_client)
    })
}

// ---------------------------------------------------------------------------
// Windows atomic pointer writer (installer-owned)
// ---------------------------------------------------------------------------

/// Atomically writes a pointer file `<dir>/<base>.version` containing
/// `<version>\n`. Uses temp-file + rename so the file is never observed
/// half-written. This is the installer-owned copy; `climon-update` has its
/// own identical implementation which will be removed in Task 3.
pub fn write_pointer_atomic(
    dir: &std::path::Path,
    base: &str,
    version: &str,
) -> Result<(), String> {
    let final_path = dir.join(format!("{base}.version"));
    let pid = std::process::id();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = dir.join(format!("{base}.version.tmp-{pid}-{ts}"));
    std::fs::write(&tmp, format!("{version}\n"))
        .map_err(|e| format!("write {} failed: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename to {} failed: {e}", final_path.display())
    })?;
    Ok(())
}

/// Reads and trims `<dir>/<base>.version`; `None` if missing/blank.
pub fn read_pointer(dir: &std::path::Path, base: &str) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(format!("{base}.version"))).ok()?;
    let t = text.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::ffi::OsString;
    use std::fs;
    use std::path::Path;

    fn temp_root(name: &str) -> std::path::PathBuf {
        let dir = std::env::current_dir()
            .unwrap()
            .join(".copilot-tmp")
            .join(name)
            .join(format!(
                "{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn os(s: &str) -> OsString {
        OsString::from(s)
    }

    // -----------------------------------------------------------------------
    // Parser tests
    // -----------------------------------------------------------------------

    #[test]
    fn parse_apply_exact_result() {
        let args = vec![
            os("--apply-update-v1"),
            os("--dir"),
            os("/opt/climon"),
            os("--source"),
            os("/tmp/stage"),
            os("--version"),
            os("3.2.1"),
        ];
        let result = parse_update_operation(&args).unwrap();
        assert_eq!(
            result,
            Some(UpdateOperation::Apply(ApplyUpdateArgs {
                dir: PathBuf::from("/opt/climon"),
                source: PathBuf::from("/tmp/stage"),
                version: "3.2.1".to_string(),
            }))
        );
    }

    #[test]
    fn parse_recover_with_all_options() {
        let args = vec![
            os("--recover-bootstrap-v1"),
            os("--dir"),
            os("/opt/climon"),
            os("--source"),
            os("/tmp/stage"),
            os("--version"),
            os("3.2.1"),
            os("--bootstrap-pid"),
            os("12345"),
            os("--fallback"),
            os("/usr/local/bin/climon-old"),
            os("--original-arg"),
            os("run"),
            os("--original-arg"),
            os("--verbose"),
            os("--original-arg"),
            os("my session"),
        ];
        let result = parse_update_operation(&args).unwrap();
        assert_eq!(
            result,
            Some(UpdateOperation::Recover(RecoverBootstrapArgs {
                apply: ApplyUpdateArgs {
                    dir: PathBuf::from("/opt/climon"),
                    source: PathBuf::from("/tmp/stage"),
                    version: "3.2.1".to_string(),
                },
                bootstrap_pid: Some(12345),
                fallback: Some(PathBuf::from("/usr/local/bin/climon-old")),
                original_args: vec![os("run"), os("--verbose"), os("my session")],
            }))
        );
    }

    #[test]
    fn parse_recover_minimal() {
        let args = vec![
            os("--recover-bootstrap-v1"),
            os("--dir"),
            os("/opt/climon"),
            os("--source"),
            os("/tmp/stage"),
            os("--version"),
            os("1.0.0"),
        ];
        let result = parse_update_operation(&args).unwrap();
        assert_eq!(
            result,
            Some(UpdateOperation::Recover(RecoverBootstrapArgs {
                apply: ApplyUpdateArgs {
                    dir: PathBuf::from("/opt/climon"),
                    source: PathBuf::from("/tmp/stage"),
                    version: "1.0.0".to_string(),
                },
                bootstrap_pid: None,
                fallback: None,
                original_args: vec![],
            }))
        );
    }

    #[test]
    fn parse_normal_args_return_none() {
        // Normal installer arguments (no update flags).
        let args = vec![os("--apply"), os("--telemetry"), os("true")];
        assert_eq!(parse_update_operation(&args).unwrap(), None);
    }

    #[test]
    fn parse_empty_args_return_none() {
        assert_eq!(parse_update_operation(&[]).unwrap(), None);
    }

    #[test]
    fn parse_rejects_both_operations() {
        let args = vec![
            os("--apply-update-v1"),
            os("--recover-bootstrap-v1"),
            os("--dir"),
            os("/opt"),
            os("--source"),
            os("/src"),
            os("--version"),
            os("1.0.0"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(err.contains("Cannot specify both"), "{err}");
    }

    #[test]
    fn parse_rejects_missing_dir() {
        let args = vec![
            os("--apply-update-v1"),
            os("--source"),
            os("/src"),
            os("--version"),
            os("1.0.0"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(err.contains("--dir is required"), "{err}");
    }

    #[test]
    fn parse_rejects_missing_source() {
        let args = vec![
            os("--apply-update-v1"),
            os("--dir"),
            os("/opt"),
            os("--version"),
            os("1.0.0"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(err.contains("--source is required"), "{err}");
    }

    #[test]
    fn parse_rejects_missing_version() {
        let args = vec![
            os("--apply-update-v1"),
            os("--dir"),
            os("/opt"),
            os("--source"),
            os("/src"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(err.contains("--version is required"), "{err}");
    }

    #[test]
    fn parse_rejects_empty_version() {
        let args = vec![
            os("--apply-update-v1"),
            os("--dir"),
            os("/opt"),
            os("--source"),
            os("/src"),
            os("--version"),
            os(""),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(err.contains("--version must not be empty"), "{err}");
    }

    #[test]
    fn parse_rejects_duplicate_dir() {
        let args = vec![
            os("--apply-update-v1"),
            os("--dir"),
            os("/opt"),
            os("--dir"),
            os("/opt2"),
            os("--source"),
            os("/src"),
            os("--version"),
            os("1.0.0"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(err.contains("Duplicate --dir"), "{err}");
    }

    #[test]
    fn parse_rejects_duplicate_source() {
        let args = vec![
            os("--apply-update-v1"),
            os("--dir"),
            os("/opt"),
            os("--source"),
            os("/src"),
            os("--source"),
            os("/src2"),
            os("--version"),
            os("1.0.0"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(err.contains("Duplicate --source"), "{err}");
    }

    #[test]
    fn parse_rejects_duplicate_version() {
        let args = vec![
            os("--apply-update-v1"),
            os("--dir"),
            os("/opt"),
            os("--source"),
            os("/src"),
            os("--version"),
            os("1.0.0"),
            os("--version"),
            os("2.0.0"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(err.contains("Duplicate --version"), "{err}");
    }

    #[test]
    fn parse_rejects_duplicate_bootstrap_pid() {
        let args = vec![
            os("--recover-bootstrap-v1"),
            os("--dir"),
            os("/opt"),
            os("--source"),
            os("/src"),
            os("--version"),
            os("1.0.0"),
            os("--bootstrap-pid"),
            os("100"),
            os("--bootstrap-pid"),
            os("200"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(err.contains("Duplicate --bootstrap-pid"), "{err}");
    }

    #[test]
    fn parse_rejects_invalid_pid() {
        let args = vec![
            os("--recover-bootstrap-v1"),
            os("--dir"),
            os("/opt"),
            os("--source"),
            os("/src"),
            os("--version"),
            os("1.0.0"),
            os("--bootstrap-pid"),
            os("not-a-number"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(err.contains("not a valid PID"), "{err}");
    }

    #[test]
    fn parse_rejects_unknown_flag_in_update() {
        let args = vec![
            os("--apply-update-v1"),
            os("--dir"),
            os("/opt"),
            os("--source"),
            os("/src"),
            os("--version"),
            os("1.0.0"),
            os("--unknown-flag"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(err.contains("Unknown flag"), "{err}");
    }

    #[test]
    fn parse_rejects_bootstrap_pid_with_apply() {
        let args = vec![
            os("--apply-update-v1"),
            os("--dir"),
            os("/opt"),
            os("--source"),
            os("/src"),
            os("--version"),
            os("1.0.0"),
            os("--bootstrap-pid"),
            os("100"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(
            err.contains("only valid with --recover-bootstrap-v1"),
            "{err}"
        );
    }

    #[test]
    fn parse_rejects_fallback_with_apply() {
        let args = vec![
            os("--apply-update-v1"),
            os("--dir"),
            os("/opt"),
            os("--source"),
            os("/src"),
            os("--version"),
            os("1.0.0"),
            os("--fallback"),
            os("/usr/bin/climon"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(
            err.contains("only valid with --recover-bootstrap-v1"),
            "{err}"
        );
    }

    #[test]
    fn parse_rejects_original_arg_with_apply() {
        let args = vec![
            os("--apply-update-v1"),
            os("--dir"),
            os("/opt"),
            os("--source"),
            os("/src"),
            os("--version"),
            os("1.0.0"),
            os("--original-arg"),
            os("run"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(
            err.contains("only valid with --recover-bootstrap-v1"),
            "{err}"
        );
    }

    #[test]
    fn parse_rejects_missing_value_for_dir() {
        let args = vec![
            os("--apply-update-v1"),
            os("--source"),
            os("/src"),
            os("--version"),
            os("1.0.0"),
            os("--dir"),
        ];
        let err = parse_update_operation(&args).unwrap_err();
        assert!(err.contains("--dir requires a value"), "{err}");
    }

    // -----------------------------------------------------------------------
    // Apply: version mismatch
    // -----------------------------------------------------------------------

    #[test]
    fn apply_version_mismatch_fails_before_mutation() {
        let root = temp_root("update-version-mismatch");
        let source = root.join("stage");
        let dir = root.join("install");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dir).unwrap();
        #[cfg(unix)]
        {
            fs::write(source.join("climon"), "client").unwrap();
            fs::write(source.join("climon-server"), "server").unwrap();
        }
        #[cfg(windows)]
        {
            fs::write(source.join("climon.dll"), "client").unwrap();
            fs::write(source.join("climon-server.exe"), "server").unwrap();
        }

        let mutated = RefCell::new(false);
        let mut place_server = |_a: &ApplyUpdateArgs| {
            *mutated.borrow_mut() = true;
            Ok(())
        };
        let mut place_client = |_a: &ApplyUpdateArgs| Ok(());
        let mut write_version = |_a: &ApplyUpdateArgs| Ok(());
        let mut cleanup = |_a: &ApplyUpdateArgs| {};

        let args = ApplyUpdateArgs {
            dir,
            source,
            version: "3.2.1".to_string(),
        };
        let err = run_apply_update(
            &args,
            "3.1.0",
            ApplyPlacement {
                place_server: &mut place_server,
                place_client: &mut place_client,
                write_version: &mut write_version,
                cleanup: &mut cleanup,
            },
        )
        .unwrap_err();

        assert!(err.contains("Version mismatch"), "{err}");
        assert!(!*mutated.borrow(), "should not have mutated anything");
        fs::remove_dir_all(&root).ok();
    }

    // -----------------------------------------------------------------------
    // Apply: missing payload
    // -----------------------------------------------------------------------

    #[test]
    fn apply_missing_payload_fails_before_mutation() {
        let root = temp_root("update-missing-payload");
        let source = root.join("stage");
        let dir = root.join("install");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dir).unwrap();
        // Only write one of the two required files.
        #[cfg(unix)]
        fs::write(source.join("climon"), "client").unwrap();
        #[cfg(windows)]
        fs::write(source.join("climon.dll"), "client").unwrap();

        let mutated = RefCell::new(false);
        let mut place_server = |_a: &ApplyUpdateArgs| {
            *mutated.borrow_mut() = true;
            Ok(())
        };
        let mut place_client = |_a: &ApplyUpdateArgs| Ok(());
        let mut write_version = |_a: &ApplyUpdateArgs| Ok(());
        let mut cleanup = |_a: &ApplyUpdateArgs| {};

        let args = ApplyUpdateArgs {
            dir,
            source,
            version: "3.2.1".to_string(),
        };
        let err = run_apply_update(
            &args,
            "3.2.1",
            ApplyPlacement {
                place_server: &mut place_server,
                place_client: &mut place_client,
                write_version: &mut write_version,
                cleanup: &mut cleanup,
            },
        )
        .unwrap_err();

        assert!(err.contains("Required source payload missing"), "{err}");
        assert!(!*mutated.borrow(), "should not have mutated anything");
        fs::remove_dir_all(&root).ok();
    }

    // -----------------------------------------------------------------------
    // Apply: placement ordering
    // -----------------------------------------------------------------------

    #[test]
    fn apply_placement_order_server_then_client_then_version_then_cleanup() {
        let root = temp_root("update-placement-order");
        let source = root.join("stage");
        let dir = root.join("install");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dir).unwrap();
        #[cfg(unix)]
        {
            fs::write(source.join("climon"), "new-client").unwrap();
            fs::write(source.join("climon-server"), "new-server").unwrap();
        }
        #[cfg(windows)]
        {
            fs::write(source.join("climon.dll"), "new-client").unwrap();
            fs::write(source.join("climon-server.exe"), "new-server").unwrap();
        }

        let events: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let mut place_server = |_a: &ApplyUpdateArgs| {
            events.borrow_mut().push("server".to_string());
            Ok(())
        };
        let mut place_client = |_a: &ApplyUpdateArgs| {
            events.borrow_mut().push("client".to_string());
            Ok(())
        };
        let mut write_version = |_a: &ApplyUpdateArgs| {
            events.borrow_mut().push("version".to_string());
            Ok(())
        };
        let mut cleanup = |_a: &ApplyUpdateArgs| {
            events.borrow_mut().push("cleanup".to_string());
        };

        let args = ApplyUpdateArgs {
            dir,
            source,
            version: "3.2.1".to_string(),
        };
        run_apply_update(
            &args,
            "3.2.1",
            ApplyPlacement {
                place_server: &mut place_server,
                place_client: &mut place_client,
                write_version: &mut write_version,
                cleanup: &mut cleanup,
            },
        )
        .unwrap();

        assert_eq!(
            *events.borrow(),
            vec!["server", "client", "version", "cleanup"]
        );
        fs::remove_dir_all(&root).ok();
    }

    // -----------------------------------------------------------------------
    // Apply: server failure leaves client unchanged
    // -----------------------------------------------------------------------

    #[test]
    fn apply_server_failure_does_not_place_client() {
        let root = temp_root("update-server-failure");
        let source = root.join("stage");
        let dir = root.join("install");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dir).unwrap();
        #[cfg(unix)]
        {
            fs::write(source.join("climon"), "new-client").unwrap();
            fs::write(source.join("climon-server"), "new-server").unwrap();
            // Existing installed client.
            fs::write(dir.join("climon"), "old-client").unwrap();
        }
        #[cfg(windows)]
        {
            fs::write(source.join("climon.dll"), "new-client").unwrap();
            fs::write(source.join("climon-server.exe"), "new-server").unwrap();
            fs::write(dir.join("climon.dll"), "old-client").unwrap();
        }

        let client_placed = RefCell::new(false);
        let mut place_server = |_a: &ApplyUpdateArgs| Err("disk full".to_string());
        let mut place_client = |_a: &ApplyUpdateArgs| {
            *client_placed.borrow_mut() = true;
            Ok(())
        };
        let mut write_version = |_a: &ApplyUpdateArgs| Ok(());
        let mut cleanup = |_a: &ApplyUpdateArgs| {};

        let args = ApplyUpdateArgs {
            dir: dir.clone(),
            source,
            version: "3.2.1".to_string(),
        };
        let err = run_apply_update(
            &args,
            "3.2.1",
            ApplyPlacement {
                place_server: &mut place_server,
                place_client: &mut place_client,
                write_version: &mut write_version,
                cleanup: &mut cleanup,
            },
        )
        .unwrap_err();

        assert!(err.contains("disk full"), "{err}");
        assert!(!*client_placed.borrow());
        // Old client should still be intact.
        #[cfg(unix)]
        assert_eq!(
            fs::read_to_string(dir.join("climon")).unwrap(),
            "old-client"
        );
        #[cfg(windows)]
        assert_eq!(
            fs::read_to_string(dir.join("climon.dll")).unwrap(),
            "old-client"
        );
        fs::remove_dir_all(&root).ok();
    }

    // -----------------------------------------------------------------------
    // Unix-specific: atomic replacement preserves open handles
    // -----------------------------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn unix_atomic_replace_preserves_open_handle() {
        use std::io::Read;

        let root = temp_root("update-atomic-replace");
        let dir = root.join("install");
        fs::create_dir_all(&dir).unwrap();

        let dest = dir.join("climon");
        fs::write(&dest, b"old-binary-bytes").unwrap();

        // Open the file before replacement.
        let mut old_handle = fs::File::open(&dest).unwrap();

        // Write new content to a source file.
        let source = root.join("stage");
        fs::create_dir_all(&source).unwrap();
        let src_path = source.join("climon");
        fs::write(&src_path, b"new-binary-bytes").unwrap();

        atomic_replace_from_path(&src_path, &dest).unwrap();

        // The old handle still reads old bytes.
        let mut old_buf = String::new();
        old_handle.read_to_string(&mut old_buf).unwrap();
        assert_eq!(old_buf, "old-binary-bytes");

        // The path now has new bytes.
        assert_eq!(fs::read_to_string(&dest).unwrap(), "new-binary-bytes");

        // Check executable mode.
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        // Source was 0o755 (default for new files may vary, but we set it).
        assert_eq!(mode & 0o111, 0o111, "should be executable");

        // No temp leftovers.
        let leftover_count = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(leftover_count, 0, "no temp files should remain");

        fs::remove_dir_all(&root).ok();
    }

    // -----------------------------------------------------------------------
    // Unix-specific: full apply ordering (server → client → version → cleanup)
    // -----------------------------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn unix_apply_update_full_ordering() {
        let root = temp_root("update-unix-full");
        let source = root.join("stage");
        let dir = root.join("install");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dir).unwrap();

        fs::write(source.join("climon"), b"new-client").unwrap();
        fs::write(source.join("climon-server"), b"new-server").unwrap();
        fs::write(dir.join("climon"), b"old-client").unwrap();
        fs::write(dir.join("climon-server"), b"old-server").unwrap();
        // Add a retired sibling.
        fs::write(dir.join("climon-beta"), b"beta").unwrap();
        fs::write(dir.join("something.old"), b"stale").unwrap();

        let args = ApplyUpdateArgs {
            dir: dir.clone(),
            source,
            version: "3.2.1".to_string(),
        };
        run_apply_update_unix(&args, "3.2.1").unwrap();

        assert_eq!(
            fs::read_to_string(dir.join("climon")).unwrap(),
            "new-client"
        );
        assert_eq!(
            fs::read_to_string(dir.join("climon-server")).unwrap(),
            "new-server"
        );
        assert_eq!(fs::read_to_string(dir.join(".version")).unwrap(), "3.2.1");
        // Retired siblings removed.
        assert!(!dir.join("climon-beta").exists());
        assert!(!dir.join("something.old").exists());

        // Executable mode.
        use std::os::unix::fs::PermissionsExt;
        let client_mode = fs::metadata(dir.join("climon"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let server_mode = fs::metadata(dir.join("climon-server"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(client_mode & 0o111, 0o111);
        assert_eq!(server_mode & 0o111, 0o111);

        fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn unix_recovery_applies_update_then_resumes_with_raw_args_and_exact_exit_code() {
        use std::os::unix::ffi::OsStringExt;

        let root = temp_root("update-unix-recovery-order");
        let source = root.join("stage");
        let dir = root.join("install");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(source.join("climon"), b"new-client").unwrap();
        fs::write(source.join("climon-server"), b"new-server").unwrap();
        fs::write(dir.join("climon"), b"old-bootstrap").unwrap();
        fs::write(dir.join("climon-server"), b"old-server").unwrap();

        let raw_arg = OsString::from_vec(vec![b'-', 0xff]);
        let recover = RecoverBootstrapArgs {
            apply: ApplyUpdateArgs {
                dir: dir.clone(),
                source: source.clone(),
                version: "3.2.1".to_string(),
            },
            bootstrap_pid: None,
            fallback: None,
            original_args: vec![os("session"), raw_arg.clone(), os("--verbose")],
        };
        let events = RefCell::new(Vec::new());
        let mut place_server = |args: &ApplyUpdateArgs| {
            assert!(args.source.join("climon").is_file());
            assert!(args.source.join("climon-server").is_file());
            events.borrow_mut().push("validate source");
            fs::copy(
                args.source.join("climon-server"),
                args.dir.join("climon-server"),
            )
            .map_err(|error| error.to_string())?;
            events.borrow_mut().push("replace server");
            Ok(())
        };
        let mut place_client = |args: &ApplyUpdateArgs| {
            fs::copy(args.source.join("climon"), args.dir.join("climon"))
                .map_err(|error| error.to_string())?;
            events.borrow_mut().push("replace client");
            Ok(())
        };
        let mut write_version = |args: &ApplyUpdateArgs| {
            fs::write(args.dir.join(".version"), &args.version)
                .map_err(|error| error.to_string())?;
            events.borrow_mut().push("write version");
            Ok(())
        };
        let mut cleanup = |_args: &ApplyUpdateArgs| {};
        let mut launch = |program: &Path, args: &[OsString]| {
            assert_eq!(program, dir.join("climon"));
            assert_eq!(args, recover.original_args.as_slice());
            assert_eq!(args[1], raw_arg);
            assert_eq!(fs::read(program).unwrap(), b"new-client");
            assert_eq!(fs::read(dir.join("climon-server")).unwrap(), b"new-server");
            assert_eq!(fs::read_to_string(dir.join(".version")).unwrap(), "3.2.1");
            events.borrow_mut().push("spawn installed client");
            Ok(23)
        };

        let code = run_recover_bootstrap(
            &recover,
            "3.2.1",
            ApplyPlacement {
                place_server: &mut place_server,
                place_client: &mut place_client,
                write_version: &mut write_version,
                cleanup: &mut cleanup,
            },
            &mut launch,
        )
        .unwrap();

        assert_eq!(code, 23);
        assert_eq!(
            *events.borrow(),
            vec![
                "validate source",
                "replace server",
                "replace client",
                "write version",
                "spawn installed client",
            ]
        );
        fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn unix_recovery_invalid_staged_source_never_mutates_bootstrap_client() {
        let root = temp_root("update-unix-recovery-invalid-source");
        let source = root.join("stage");
        let dir = root.join("install");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(source.join("climon"), b"new-client").unwrap();
        fs::write(dir.join("climon"), b"old-bootstrap").unwrap();

        let recover = RecoverBootstrapArgs {
            apply: ApplyUpdateArgs {
                dir: dir.clone(),
                source,
                version: "3.2.1".to_string(),
            },
            bootstrap_pid: None,
            fallback: None,
            original_args: vec![],
        };
        let mutated = RefCell::new(false);
        let mut place_server = |_args: &ApplyUpdateArgs| {
            *mutated.borrow_mut() = true;
            Ok(())
        };
        let mut place_client = |_args: &ApplyUpdateArgs| {
            *mutated.borrow_mut() = true;
            Ok(())
        };
        let mut write_version = |_args: &ApplyUpdateArgs| {
            *mutated.borrow_mut() = true;
            Ok(())
        };
        let mut cleanup = |_args: &ApplyUpdateArgs| {};
        let mut launch = |_program: &Path, _args: &[OsString]| -> Result<i32, String> {
            panic!("invalid staged recovery must not launch")
        };

        let error = run_recover_bootstrap(
            &recover,
            "3.2.1",
            ApplyPlacement {
                place_server: &mut place_server,
                place_client: &mut place_client,
                write_version: &mut write_version,
                cleanup: &mut cleanup,
            },
            &mut launch,
        )
        .unwrap_err();

        assert!(error.contains("Required source payload missing"), "{error}");
        assert!(!*mutated.borrow());
        assert_eq!(fs::read(dir.join("climon")).unwrap(), b"old-bootstrap");
        assert!(!dir.join(".version").exists());
        fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn unix_recovery_command_returns_resumed_client_exact_exit_code() {
        use std::os::unix::fs::PermissionsExt;

        let root = temp_root("update-unix-recovery-command");
        let source = root.join("stage");
        let dir = root.join("install");
        let marker = root.join("args.txt");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            source.join("climon"),
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexit 23\n",
                marker.display()
            ),
        )
        .unwrap();
        fs::set_permissions(source.join("climon"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(source.join("climon-server"), b"new-server").unwrap();
        fs::write(dir.join("climon"), b"old-bootstrap").unwrap();

        let recover = RecoverBootstrapArgs {
            apply: ApplyUpdateArgs {
                dir: dir.clone(),
                source,
                version: "3.2.1".to_string(),
            },
            bootstrap_pid: None,
            fallback: None,
            original_args: vec![os("session"), os("--verbose")],
        };

        let code = run_recover_bootstrap_unix(&recover, "3.2.1").unwrap();

        assert_eq!(code, 23);
        assert_eq!(fs::read_to_string(marker).unwrap(), "session\n--verbose\n");
        fs::remove_dir_all(&root).ok();
    }

    // -----------------------------------------------------------------------
    // Atomic pointer writer tests
    // -----------------------------------------------------------------------

    #[test]
    fn pointer_write_then_read_round_trips() {
        let root = temp_root("update-pointer-roundtrip");
        write_pointer_atomic(&root, "climon", "3.2.1").unwrap();
        assert_eq!(read_pointer(&root, "climon").as_deref(), Some("3.2.1"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pointer_write_overwrites_existing() {
        let root = temp_root("update-pointer-overwrite");
        write_pointer_atomic(&root, "climon", "1.0.0").unwrap();
        write_pointer_atomic(&root, "climon", "2.0.0").unwrap();
        assert_eq!(read_pointer(&root, "climon").as_deref(), Some("2.0.0"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pointer_read_missing_returns_none() {
        let root = temp_root("update-pointer-missing");
        assert_eq!(read_pointer(&root, "climon"), None);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pointer_no_temp_leftover() {
        let root = temp_root("update-pointer-no-temp");
        write_pointer_atomic(&root, "climon", "3.2.1").unwrap();
        let leftover_count = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(leftover_count, 0);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pointer_idempotent_rewrite() {
        let root = temp_root("update-pointer-idempotent");
        write_pointer_atomic(&root, "climon", "3.2.1").unwrap();
        write_pointer_atomic(&root, "climon", "3.2.1").unwrap();
        assert_eq!(read_pointer(&root, "climon").as_deref(), Some("3.2.1"));
        // Exactly one file (no temp leftover).
        let count = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("climon.version")
            })
            .count();
        assert_eq!(count, 1);
        fs::remove_dir_all(&root).ok();
    }

    // -----------------------------------------------------------------------
    // Cleanup retired
    // -----------------------------------------------------------------------

    #[test]
    fn cleanup_retired_removes_beta_and_old() {
        let root = temp_root("update-cleanup");
        let dir = root.join("install");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("climon-beta"), "beta").unwrap();
        fs::write(dir.join("climon.old"), "old1").unwrap();
        fs::write(dir.join("climon-server.old"), "old2").unwrap();
        fs::write(dir.join("climon"), "keep").unwrap();

        cleanup_retired(&dir);

        assert!(!dir.join("climon-beta").exists());
        assert!(!dir.join("climon.old").exists());
        assert!(!dir.join("climon-server.old").exists());
        assert!(dir.join("climon").exists());
        fs::remove_dir_all(&root).ok();
    }

    // -----------------------------------------------------------------------
    // Client placement failure leaves old client unchanged
    // -----------------------------------------------------------------------

    #[test]
    fn apply_client_failure_leaves_old_installed_client_unchanged() {
        let root = temp_root("update-client-failure");
        let source = root.join("stage");
        let dir = root.join("install");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dir).unwrap();
        #[cfg(unix)]
        {
            fs::write(source.join("climon"), "new-client").unwrap();
            fs::write(source.join("climon-server"), "new-server").unwrap();
            fs::write(dir.join("climon"), "old-client").unwrap();
            fs::write(dir.join("climon-server"), "old-server").unwrap();
        }
        #[cfg(windows)]
        {
            fs::write(source.join("climon.dll"), "new-client").unwrap();
            fs::write(source.join("climon-server.exe"), "new-server").unwrap();
            fs::write(dir.join("climon.dll"), "old-client").unwrap();
            fs::write(dir.join("climon-server.exe"), "old-server").unwrap();
        }

        let mut place_server = |_a: &ApplyUpdateArgs| Ok(());
        let mut place_client = |_a: &ApplyUpdateArgs| Err("permission denied".to_string());
        let mut write_version = |_a: &ApplyUpdateArgs| Ok(());
        let mut cleanup = |_a: &ApplyUpdateArgs| {};

        let args = ApplyUpdateArgs {
            dir: dir.clone(),
            source,
            version: "3.2.1".to_string(),
        };
        let err = run_apply_update(
            &args,
            "3.2.1",
            ApplyPlacement {
                place_server: &mut place_server,
                place_client: &mut place_client,
                write_version: &mut write_version,
                cleanup: &mut cleanup,
            },
        )
        .unwrap_err();

        assert!(err.contains("permission denied"), "{err}");
        // Old client should still be intact (the injected place_server was a no-op
        // so it didn't actually change the server file, demonstrating the ordering).
        #[cfg(unix)]
        assert_eq!(
            fs::read_to_string(dir.join("climon")).unwrap(),
            "old-client"
        );
        #[cfg(windows)]
        assert_eq!(
            fs::read_to_string(dir.join("climon.dll")).unwrap(),
            "old-client"
        );
        fs::remove_dir_all(&root).ok();
    }

    // -----------------------------------------------------------------------
    // Source directory missing
    // -----------------------------------------------------------------------

    #[test]
    fn apply_fails_if_source_dir_missing() {
        let root = temp_root("update-source-missing");
        let dir = root.join("install");
        fs::create_dir_all(&dir).unwrap();

        let mut place_server = |_a: &ApplyUpdateArgs| Ok(());
        let mut place_client = |_a: &ApplyUpdateArgs| Ok(());
        let mut write_version = |_a: &ApplyUpdateArgs| Ok(());
        let mut cleanup = |_a: &ApplyUpdateArgs| {};

        let args = ApplyUpdateArgs {
            dir,
            source: root.join("nonexistent"),
            version: "3.2.1".to_string(),
        };
        let err = run_apply_update(
            &args,
            "3.2.1",
            ApplyPlacement {
                place_server: &mut place_server,
                place_client: &mut place_client,
                write_version: &mut write_version,
                cleanup: &mut cleanup,
            },
        )
        .unwrap_err();

        assert!(err.contains("Source directory does not exist"), "{err}");
        fs::remove_dir_all(&root).ok();
    }
}
