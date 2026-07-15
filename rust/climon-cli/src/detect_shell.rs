//! Parent-shell detection. Port of `src/detect-shell.ts`.
//!
//! The pure helpers ([`is_blocked`], [`build_shell_argv`]) and the `$SHELL`/
//! `$ComSpec` fallback are unit-tested; the per-OS process-tree walkers are
//! integration-only (they read live `/proc`, `ps`, or PowerShell CIM output).

#[cfg(all(unix, not(target_os = "linux")))]
use crate::pathenv::which;

/// Executables that are never a useful shell to re-launch. If the parent process
/// matches one of these, fall back to environment-based detection. Matches
/// `BLOCKED_PARENTS`.
const BLOCKED_PARENTS: &[&str] = &[
    "explorer.exe",
    "finder",
    "code",
    "cursor",
    "node",
    "bun",
    "deno",
    "cargo",
    "rustc",
    "rustup",
    "sshd",
    "login",
    "init",
    "systemd",
    "launchd",
    "conhost.exe",
    "windowsterminal.exe",
    "wt.exe",
    "copilot",
];

/// Returns whether `exe` is a blocked parent (matched by basename, with and
/// without a `.exe` suffix). Mirrors `isBlocked`.
pub fn is_blocked(exe: &str) -> bool {
    let base = exe
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let name = base.strip_suffix(".exe").unwrap_or(&base).to_string();
    BLOCKED_PARENTS.contains(&base.as_str()) || BLOCKED_PARENTS.contains(&name.as_str())
}

/// Builds the full argv for launching the detected shell. Mirrors
/// `buildShellArgv`.
pub fn build_shell_argv(shell: &str) -> Vec<String> {
    vec![shell.to_string()]
}

#[cfg(unix)]
fn parent_pid() -> i32 {
    unsafe { libc::getppid() }
}

/// Linux: walk up `/proc/<pid>/exe` + `/proc/<pid>/stat` until a non-blocked
/// executable is found (max 5 levels). Mirrors `detectLinuxParent`.
#[cfg(target_os = "linux")]
fn detect_linux_parent(start_pid: i32) -> Option<String> {
    let mut pid = start_pid;
    for _ in 0..5 {
        if pid <= 1 {
            break;
        }
        let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
        let exe = exe.to_string_lossy().into_owned();
        if !is_blocked(&exe) {
            return Some(exe);
        }
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // Format: "<pid> (<comm>) <state> <ppid> ..." — comm may contain spaces
        // and parens, so split on the last ')'.
        let after = stat.rsplit_once(')').map(|(_, rest)| rest)?;
        let mut fields = after.split_whitespace();
        let _state = fields.next()?;
        let ppid: i32 = fields.next()?.parse().ok()?;
        pid = ppid;
    }
    None
}

/// macOS / generic unix: walk up the tree via `ps -o comm=,ppid=` until a
/// non-blocked executable is found. Mirrors `detectDarwinParent`.
#[cfg(all(unix, not(target_os = "linux")))]
fn detect_darwin_parent(start_pid: i32) -> Option<String> {
    let mut pid = start_pid;
    for _ in 0..5 {
        if pid <= 1 {
            break;
        }
        let output = std::process::Command::new("ps")
            .args(["-o", "comm=,ppid=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let line = text.trim();
        if line.is_empty() {
            break;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            break;
        }
        let parent_pid: i32 = parts[parts.len() - 1].parse().ok()?;
        let mut comm = parts[..parts.len() - 1].join(" ");
        if let Some(stripped) = comm.strip_prefix('-') {
            comm = stripped.to_string();
        }
        if comm.is_empty() {
            break;
        }
        let resolved = which(&comm).unwrap_or_else(|| comm.clone());
        if !is_blocked(&resolved) {
            return Some(resolved);
        }
        pid = parent_pid;
    }
    None
}

/// Detects the shell that invoked the current process by inspecting the parent
/// process. Falls back to `$SHELL` (unix) or `$ComSpec` (Windows). Mirrors
/// `detectParentShell`.
pub fn detect_parent_shell() -> String {
    #[cfg(target_os = "linux")]
    let detected = detect_linux_parent(parent_pid());
    #[cfg(all(unix, not(target_os = "linux")))]
    let detected = detect_darwin_parent(parent_pid());
    #[cfg(windows)]
    let detected = detect_windows_parent();
    #[cfg(not(any(unix, windows)))]
    let detected: Option<String> = None;

    if let Some(shell) = detected {
        if !is_blocked(&shell) {
            return shell;
        }
    }

    if cfg!(windows) {
        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

/// Windows: walk up the process tree via `Get-CimInstance Win32_Process` until a
/// non-blocked executable is found (max 5 levels). Mirrors `detectWindowsParent`.
#[cfg(windows)]
fn detect_windows_parent() -> Option<String> {
    fn query_process(pid: u32) -> (Option<String>, Option<u32>) {
        let script = format!(
            "$p = Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\" -ErrorAction Stop; \
             if($p){{$p.ExecutablePath + '|' + $p.ParentProcessId}}else{{'|'}}"
        );
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NoLogo", "-Command", &script])
            .output();
        let output = match output {
            Ok(o) if o.status.success() => o,
            _ => return (None, None),
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stdout = stdout.trim();
        if stdout.is_empty() {
            return (None, None);
        }
        match stdout.rfind('|') {
            None => (Some(stdout.to_string()), None),
            Some(idx) => {
                let exe = &stdout[..idx];
                let ppid = stdout[idx + 1..].trim().parse::<u32>().ok();
                (
                    if exe.is_empty() {
                        None
                    } else {
                        Some(exe.to_string())
                    },
                    ppid,
                )
            }
        }
    }

    // Seed the walk at the *parent* process, matching the TS `process.ppid`.
    // Windows has no `getppid`, so query the current process once to obtain its
    // ParentProcessId. Seeding at the current process would return climon's own
    // executable (not in BLOCKED_PARENTS) as the "detected shell", recursively
    // spawning nested climon sessions.
    let (_self_exe, parent) = query_process(std::process::id());
    let mut pid = parent;
    for _ in 0..5 {
        let current = pid?;
        if current == 0 {
            break;
        }
        let (exe, parent) = query_process(current);
        match exe {
            Some(exe) if !is_blocked(&exe) => return Some(exe),
            Some(_) => pid = parent,
            None => break,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_shell_argv_returns_single_element() {
        assert_eq!(
            build_shell_argv("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
            vec!["C:\\Program Files\\PowerShell\\7\\pwsh.exe".to_string()]
        );
        assert_eq!(build_shell_argv("/bin/bash"), vec!["/bin/bash".to_string()]);
        assert_eq!(
            build_shell_argv("C:\\Windows\\System32\\cmd.exe"),
            vec!["C:\\Windows\\System32\\cmd.exe".to_string()]
        );
    }

    #[test]
    fn is_blocked_matches_basename_with_and_without_exe() {
        assert!(is_blocked("/usr/bin/node"));
        assert!(is_blocked("C:\\Program Files\\nodejs\\node.exe"));
        assert!(is_blocked("bun"));
        assert!(is_blocked("C:\\Users\\me\\.cargo\\bin\\cargo.exe"));
        assert!(is_blocked("/home/me/.rustup/toolchains/stable/bin/cargo"));
        assert!(is_blocked("/sbin/init"));
        assert!(!is_blocked("/bin/bash"));
        assert!(!is_blocked("C:\\Windows\\System32\\cmd.exe"));
    }

    #[test]
    fn detect_parent_shell_returns_non_empty() {
        // The OS process-tree walk is environment-dependent (under `cargo test`
        // the parent is the test harness, not a shell), so we only assert that
        // detection returns a non-empty path and never panics. The pure helpers
        // (`is_blocked` / `build_shell_argv`) carry the ported behavioral checks.
        let shell = detect_parent_shell();
        assert!(!shell.is_empty());
    }
}
