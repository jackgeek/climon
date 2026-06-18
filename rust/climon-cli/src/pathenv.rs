//! Minimal `PATH` executable lookup, replacing the TS client's `Bun.which`.

use std::path::{Path, PathBuf};

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(meta) => meta.is_file() && (meta.permissions().mode() & 0o111) != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Windows executable extensions to probe when the command has no extension.
#[cfg(windows)]
fn path_extensions() -> Vec<String> {
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_start_matches('.').to_ascii_lowercase())
        .collect()
}

/// Resolves a bare command name to an absolute executable path by scanning
/// `PATH`, or returns the path unchanged if it already contains a separator and
/// is executable. Returns `None` when nothing is found. Mirrors `Bun.which`.
pub fn which(cmd: &str) -> Option<String> {
    if cmd.is_empty() {
        return None;
    }

    let has_sep = cmd.contains('/') || (cfg!(windows) && cmd.contains('\\'));
    if has_sep {
        let p = Path::new(cmd);
        return if is_executable(p) {
            Some(cmd.to_string())
        } else {
            None
        };
    }

    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let direct: PathBuf = dir.join(cmd);
        if is_executable(&direct) {
            return Some(direct.to_string_lossy().into_owned());
        }
        #[cfg(windows)]
        {
            // Only auto-append an extension when the command lacks one.
            if Path::new(cmd).extension().is_none() {
                for ext in path_extensions() {
                    let candidate = dir.join(format!("{cmd}.{ext}"));
                    if is_executable(&candidate) {
                        return Some(candidate.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    None
}
