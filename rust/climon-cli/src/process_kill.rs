//! Cross-platform best-effort process termination. Port of `src/process-kill.ts`.

/// Terminates a process, best-effort. On unix sends `SIGKILL` (force) or
/// `SIGTERM` (graceful) and reports whether the signal was issued without error
/// (a process that is already gone reports `false`/ESRCH). On Windows uses
/// `taskkill /T` (whole tree) plus `/F` when forcing. Mirrors `killProcess`
/// (with `tree: true`).
pub fn kill_process(pid: u32, force: bool) -> bool {
    #[cfg(unix)]
    {
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        unsafe { libc::kill(pid as libc::pid_t, signal) == 0 }
    }
    #[cfg(windows)]
    {
        let mut args: Vec<String> = vec!["/PID".to_string(), pid.to_string(), "/T".to_string()];
        if force {
            args.push("/F".to_string());
        }
        std::process::Command::new("taskkill")
            .args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (pid, force);
        false
    }
}

/// Returns whether a process with the given pid currently exists. Mirrors
/// `isProcessAlive`.
pub fn is_process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
    #[cfg(windows)]
    {
        // `tasklist` filtered to the pid prints a header + row when alive and a
        // "no tasks" notice otherwise.
        match std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
        {
            Ok(out) => {
                let text = String::from_utf8_lossy(&out.stdout);
                text.contains(&pid.to_string())
            }
            Err(_) => false,
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_is_alive() {
        let pid = std::process::id();
        assert!(is_process_alive(pid));
    }

    #[test]
    fn unlikely_pid_is_not_alive() {
        // A very high pid is almost certainly free.
        assert!(!is_process_alive(4_000_000_000));
    }
}
