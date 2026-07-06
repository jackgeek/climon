//! `climon cleanup` command wrapper. Port of `src/cli/cleanup-cmd.ts`.

use std::path::Path;

use climon_config::config::Env as ConfigEnv;
use climon_remote::teardown::{teardown_local_server_stack, TeardownDeps};

/// Injectable IO + process hooks for [`run_cleanup_command`].
pub struct CleanupCommandIo<'a> {
    pub stdout: &'a mut dyn FnMut(&str),
    pub stderr: &'a mut dyn FnMut(&str),
}

fn is_windows() -> bool {
    cfg!(windows)
}

fn platform_kill_advice(pid: u32) -> String {
    if is_windows() {
        format!("Stop-Process -Id {pid} -Force")
    } else {
        format!("kill -9 {pid}")
    }
}

/// `climon cleanup`: stop this OS's dashboard server, ingest, and uplink, and
/// remove their beacons. Mirrors `runCleanupCommand`.
pub fn run_cleanup_command(env: &ConfigEnv, deps: TeardownDeps, io: &mut CleanupCommandIo) -> i32 {
    let report = teardown_local_server_stack(env, &deps);

    // After teardown, reap superseded versioned binaries (Windows only). Files
    // still held by a running process are kept and reported, never force-killed.
    #[cfg(windows)]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let reaped = climon_update::reaper::reap_superseded(dir);
                for name in &reaped.removed {
                    (io.stdout)(&format!("Removed {name}\n"));
                }
                for name in &reaped.skipped_locked {
                    (io.stderr)(&format!(
                        "Kept {name}: still in use by a running process.\n"
                    ));
                }
            }
        }
    }

    let mut had_problems = false;
    let mut lines: Vec<String> = Vec::new();

    if report.server_stopped {
        lines.push("Stopped dashboard server.".to_string());
    }
    if report.ingest_stopped {
        lines.push("Stopped ingest daemon.".to_string());
    }
    if report.uplink_stopped {
        lines.push("Stopped uplink daemon.".to_string());
    }
    for path in &report.removed {
        lines.push(format!("Removed {path}"));
    }

    for failure in &report.failures {
        had_problems = true;
        (io.stderr)(&format!(
            "WARNING: {} (pid {}): {}\n",
            failure.component, failure.pid, failure.reason
        ));
        if let Some(advice) = &failure.advice {
            (io.stderr)(&format!("  \u{2192} {advice}\n"));
        }
    }

    for stale in &report.stale_files {
        had_problems = true;
        (io.stderr)(&format!(
            "WARNING: Cannot remove {} \u{2014} process {} is still running.\n",
            stale.path, stale.pid
        ));
        (io.stderr)(&format!(
            "  \u{2192} Kill it manually: {}\n",
            platform_kill_advice(stale.pid)
        ));
    }

    if lines.is_empty() && !had_problems {
        (io.stdout)("Nothing to clean up \u{2014} no local climon daemons were running.\n");
        return 0;
    }
    for line in &lines {
        (io.stdout)(&format!("{line}\n"));
    }
    if had_problems {
        1
    } else {
        0
    }
}

/// Builds [`TeardownDeps`] from `is_process_alive`/`kill_process` hooks plus a
/// `wait_timeout_ms`. Used by the CLI (real hooks) and tests (mocked hooks).
pub fn cleanup_deps<'a>(
    is_process_alive: Box<dyn Fn(u32) -> bool + 'a>,
    kill_process: Box<dyn Fn(u32, bool) -> bool + 'a>,
    wait_timeout_ms: u64,
) -> TeardownDeps<'a> {
    TeardownDeps {
        is_process_alive,
        kill_process,
        remove_file: Box::new(|path: &Path| {
            let _ = std::fs::remove_file(path);
        }),
        wait_timeout_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    fn temp_home() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let base = std::env::current_dir().unwrap().join(".copilot-tmp");
        std::fs::create_dir_all(&base).unwrap();
        let dir = base.join(format!(
            "climon-cli-cleanup-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn env_for(home: &Path) -> ConfigEnv {
        let os_home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        ConfigEnv::new(Some(home.to_str().unwrap()), &os_home)
    }

    fn seed_stack(home: &Path) {
        std::fs::write(
            home.join("server.json"),
            serde_json::json!({"pid": 111, "port": 3131, "ingest": 3132}).to_string(),
        )
        .unwrap();
        std::fs::write(
            home.join("ingest.json"),
            serde_json::json!({"pid": 222, "port": 3132}).to_string(),
        )
        .unwrap();
        std::fs::write(home.join("ingest.pid"), "222\n").unwrap();
        std::fs::write(home.join("uplink.pid"), "333\n").unwrap();
    }

    fn kill_succeeds() -> TeardownDeps<'static> {
        let killed: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
        let alive = killed.clone();
        let kill = killed.clone();
        cleanup_deps(
            Box::new(move |pid| !alive.lock().unwrap().contains(&pid)),
            Box::new(move |pid, _f| {
                kill.lock().unwrap().push(pid);
                true
            }),
            3000,
        )
    }

    #[test]
    fn reports_what_it_stopped_and_removed() {
        let home = temp_home();
        seed_stack(&home);
        let env = env_for(&home);
        let mut out: Vec<String> = Vec::new();
        let mut err: Vec<String> = Vec::new();
        let code = {
            let mut io = CleanupCommandIo {
                stdout: &mut |t: &str| out.push(t.to_string()),
                stderr: &mut |t: &str| err.push(t.to_string()),
            };
            run_cleanup_command(&env, kill_succeeds(), &mut io)
        };
        assert_eq!(code, 0);
        let text = out.join("");
        assert!(text.contains("Stopped dashboard server"));
        assert!(text.contains("Stopped ingest"));
        assert!(text.contains("Stopped uplink"));
        assert!(text.contains("Removed"));
        assert!(text.contains("server.json"));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn clean_state_when_nothing_running() {
        let home = temp_home();
        let env = env_for(&home);
        let mut out: Vec<String> = Vec::new();
        let mut err: Vec<String> = Vec::new();
        let code = {
            let mut io = CleanupCommandIo {
                stdout: &mut |t: &str| out.push(t.to_string()),
                stderr: &mut |t: &str| err.push(t.to_string()),
            };
            run_cleanup_command(
                &env,
                cleanup_deps(Box::new(|_| false), Box::new(|_, _| false), 200),
                &mut io,
            )
        };
        assert_eq!(code, 0);
        assert!(out.join("").contains("Nothing to clean up"));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn exit_one_and_warnings_when_kills_fail() {
        let home = temp_home();
        seed_stack(&home);
        let env = env_for(&home);
        let mut out: Vec<String> = Vec::new();
        let mut err: Vec<String> = Vec::new();
        let code = {
            let mut io = CleanupCommandIo {
                stdout: &mut |t: &str| out.push(t.to_string()),
                stderr: &mut |t: &str| err.push(t.to_string()),
            };
            run_cleanup_command(
                &env,
                cleanup_deps(Box::new(|_| true), Box::new(|_, _| true), 200),
                &mut io,
            )
        };
        assert_eq!(code, 1);
        let err_text = err.join("");
        assert!(err_text.contains("WARNING"));
        assert!(err_text.contains("dashboard server"));
        assert!(err_text.contains("Cannot remove"));
        std::fs::remove_dir_all(&home).ok();
    }
}
