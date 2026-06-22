//! Best-effort process liveness/termination, scoped to climon-remote to avoid a
//! cli<->remote dependency cycle. Mirrors the relevant parts of
//! `src/process-kill.ts` (and matches `climon-cli`'s `process_kill`).

/// Returns whether a process with the given pid currently exists. Mirrors
/// `isProcessAlive`.
pub fn is_process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: avoid flashing a console window for the liveness probe.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        match std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(out) => String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()),
            Err(_) => false,
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

/// Terminates a process, best-effort. On unix sends `SIGKILL` (force) or
/// `SIGTERM` (graceful). On Windows uses `taskkill /T` plus `/F` when forcing.
/// Mirrors `killProcess` with `tree: true`.
pub fn kill_process(pid: u32, force: bool) -> bool {
    #[cfg(unix)]
    {
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        unsafe { libc::kill(pid as libc::pid_t, signal) == 0 }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: avoid flashing a console window for the kill.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut args: Vec<String> = vec!["/PID".to_string(), pid.to_string(), "/T".to_string()];
        if force {
            args.push("/F".to_string());
        }
        std::process::Command::new("taskkill")
            .args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_is_alive() {
        assert!(is_process_alive(std::process::id()));
    }

    #[test]
    fn unlikely_pid_is_not_alive() {
        assert!(!is_process_alive(4_000_000_000));
    }
}
