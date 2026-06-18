//! Command resolution, `setsid` controlling-terminal wrapping, and the resize
//! clamp/de-dupe helper — the pure, testable pieces of `src/pty.ts`.

use std::sync::OnceLock;

use crate::error::{PtyError, PtyResult};

/// Splits a command vector into the executable plus its arguments.
///
/// Mirrors `resolveCommand` in `src/pty.ts`: returns `(file, args)` or errors
/// on an empty command.
pub fn resolve_command(command: &[String]) -> PtyResult<(String, Vec<String>)> {
    match command.split_first() {
        Some((file, args)) => Ok((file.clone(), args.to_vec())),
        None => Err(PtyError::EmptyCommand),
    }
}

/// Builds the argv used to spawn the child. When a `setsid` binary is supplied
/// (Unix only), the command is wrapped in `setsid -c <cmd> <args...>` so the
/// child starts a new session and adopts the PTY as its controlling terminal,
/// restoring job control. Without `setsid` (or on Windows, where the caller
/// passes `None`), the command runs unwrapped.
///
/// This is the pure core of `buildSpawnArgv` from `src/pty.ts`; the `setsid`
/// path is injected so the logic is testable without a host `setsid`.
pub fn build_spawn_argv(setsid: Option<&str>, command: &str, args: &[String]) -> Vec<String> {
    let mut argv = Vec::with_capacity(args.len() + 3);
    if let Some(setsid) = setsid {
        argv.push(setsid.to_string());
        argv.push("-c".to_string());
    }
    argv.push(command.to_string());
    argv.extend(args.iter().cloned());
    argv
}

static CACHED_SETSID: OnceLock<Option<String>> = OnceLock::new();

/// Returns the path to a `setsid` binary on `PATH`, or `None` when unavailable.
/// Always `None` on Windows. The result is cached for the process lifetime,
/// matching `findSetsid` in `src/pty.ts`.
pub fn find_setsid() -> Option<&'static str> {
    CACHED_SETSID
        .get_or_init(|| {
            if cfg!(windows) {
                None
            } else {
                which_on_path("setsid")
            }
        })
        .as_deref()
}

/// Minimal `PATH` scan for an executable file named `name`. Avoids pulling in a
/// `which` dependency for the single binary (`setsid`) we look up.
#[cfg(unix)]
fn which_on_path(name: &str) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(name);
        if let Ok(meta) = std::fs::metadata(&candidate) {
            if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(not(unix))]
fn which_on_path(_name: &str) -> Option<String> {
    None
}

/// Clamps a requested terminal size to `>= 1` and reports whether it differs
/// from the last applied size. Returns `(cols, rows, changed)`.
///
/// This is the pure core of the resize de-dupe in `src/pty.ts`: callers apply
/// the new size (and signal descendants) only when `changed` is `true`.
pub fn next_size(cols: u16, rows: u16, last: (u16, u16)) -> (u16, u16, bool) {
    let cols = cols.max(1);
    let rows = rows.max(1);
    let changed = (cols, rows) != last;
    (cols, rows, changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn resolve_splits_file_and_args() {
        let (file, args) = resolve_command(&s(&["zsh", "-l", "-c", "echo hi"])).unwrap();
        assert_eq!(file, "zsh");
        assert_eq!(args, s(&["-l", "-c", "echo hi"]));
    }

    #[test]
    fn resolve_single_element_has_no_args() {
        let (file, args) = resolve_command(&s(&["bash"])).unwrap();
        assert_eq!(file, "bash");
        assert!(args.is_empty());
    }

    #[test]
    fn resolve_errors_on_empty() {
        let err = resolve_command(&[]).unwrap_err();
        assert!(matches!(err, PtyError::EmptyCommand));
    }

    #[test]
    fn build_argv_wraps_with_setsid() {
        let argv = build_spawn_argv(Some("/usr/bin/setsid"), "zsh", &s(&["-l"]));
        assert_eq!(argv, s(&["/usr/bin/setsid", "-c", "zsh", "-l"]));
    }

    #[test]
    fn build_argv_without_setsid_is_unwrapped() {
        let argv = build_spawn_argv(None, "zsh", &s(&["-l"]));
        assert_eq!(argv, s(&["zsh", "-l"]));
    }

    #[test]
    fn build_argv_no_args() {
        assert_eq!(build_spawn_argv(None, "bash", &[]), s(&["bash"]));
        assert_eq!(
            build_spawn_argv(Some("setsid"), "bash", &[]),
            s(&["setsid", "-c", "bash"])
        );
    }

    #[test]
    fn next_size_clamps_to_at_least_one() {
        let (c, r, changed) = next_size(0, 0, (80, 24));
        assert_eq!((c, r), (1, 1));
        assert!(changed);
    }

    #[test]
    fn next_size_reports_no_change_when_equal() {
        let (c, r, changed) = next_size(120, 40, (120, 40));
        assert_eq!((c, r), (120, 40));
        assert!(!changed);
    }

    #[test]
    fn next_size_dedupes_after_clamp() {
        // Requesting (0,0) when (1,1) is already applied is a no-op.
        let (_, _, changed) = next_size(0, 0, (1, 1));
        assert!(!changed);
    }

    #[test]
    fn next_size_reports_change() {
        let (c, r, changed) = next_size(100, 50, (80, 24));
        assert_eq!((c, r), (100, 50));
        assert!(changed);
    }
}
