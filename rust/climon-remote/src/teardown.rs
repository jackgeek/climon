//! Full local teardown of the dashboard stack. Ports `src/remote/teardown.ts`:
//! stops the dashboard server (graceful HTTP shutdown, then signals), the ingest
//! and uplink daemons (via pidfiles), and removes their beacons only after the
//! owning process is confirmed dead.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use climon_config::config::{get_climon_home, Env as ConfigEnv};
use climon_store::server_state::read_server_state_from_dir;

use crate::ingest_state::get_ingest_state_path;
use crate::process::{is_process_alive, kill_process};
use crate::shutdown_request::get_shutdown_request_path;

/// Path to the uplink pidfile. Mirrors `getUplinkPidPath`.
pub fn get_uplink_pid_path(env: &ConfigEnv) -> PathBuf {
    get_climon_home(env).join("uplink.pid")
}

fn get_ingest_pid_path(env: &ConfigEnv) -> PathBuf {
    get_climon_home(env).join("ingest.pid")
}

fn read_pid(path: &Path) -> Option<u32> {
    let raw = std::fs::read_to_string(path).ok()?;
    let pid: i64 = raw.trim().parse().ok()?;
    if pid > 0 {
        Some(pid as u32)
    } else {
        None
    }
}

/// A daemon that could not be stopped. Mirrors `KillFailure`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillFailure {
    pub component: String,
    pub pid: u32,
    pub reason: String,
    pub advice: Option<String>,
}

/// A beacon retained because its owner is still alive. Mirrors `StaleFile`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleFile {
    pub path: String,
    pub pid: u32,
}

/// The outcome of a teardown. Mirrors `TeardownReport`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TeardownReport {
    pub server_stopped: bool,
    pub ingest_stopped: bool,
    pub uplink_stopped: bool,
    pub removed: Vec<String>,
    pub failures: Vec<KillFailure>,
    pub stale_files: Vec<StaleFile>,
}

type IsAliveFn<'a> = Box<dyn Fn(u32) -> bool + 'a>;
type KillFn<'a> = Box<dyn Fn(u32, bool) -> bool + 'a>;
type RemoveFileFn<'a> = Box<dyn Fn(&Path) + 'a>;
type RequestShutdownFn<'a> = Box<dyn Fn(u16) -> bool + 'a>;

/// Injectable dependencies for teardown. Mirrors the TS `options`.
pub struct TeardownDeps<'a> {
    pub is_process_alive: IsAliveFn<'a>,
    pub kill_process: KillFn<'a>,
    pub remove_file: RemoveFileFn<'a>,
    /// Sends the graceful `POST /__internal/shutdown` to the dashboard server on
    /// the given port. Injectable so tests never perform real network I/O: the
    /// default hits the loopback dashboard port, which would otherwise shut down
    /// a developer's live server if a test seeds a `server.json` on that port.
    pub request_shutdown: RequestShutdownFn<'a>,
    pub wait_timeout_ms: u64,
}

impl Default for TeardownDeps<'_> {
    fn default() -> Self {
        TeardownDeps {
            is_process_alive: Box::new(is_process_alive),
            kill_process: Box::new(kill_process),
            remove_file: Box::new(|path: &Path| {
                let _ = std::fs::remove_file(path);
            }),
            request_shutdown: Box::new(http_shutdown),
            wait_timeout_ms: 3000,
        }
    }
}

fn is_windows() -> bool {
    cfg!(windows)
}

fn kill_advice(pid: u32) -> String {
    if is_windows() {
        format!("Stop-Process -Id {pid} -Force")
    } else {
        format!("kill -9 {pid}")
    }
}

fn wait_for_death(pid: u32, is_alive: &IsAliveFn, timeout_ms: u64, poll_ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        if !is_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(poll_ms));
    }
    !is_alive(pid)
}

/// Best-effort graceful HTTP shutdown of the dashboard server. Mirrors the
/// `fetch(.../__internal/shutdown)` call with a 1s timeout. Returns whether the
/// request was sent without an immediate connection error.
fn http_shutdown(port: u16) -> bool {
    let addr = (std::net::Ipv4Addr::LOCALHOST, port);
    let mut stream = match TcpStream::connect_timeout(
        &std::net::SocketAddr::from(addr),
        Duration::from_millis(1000),
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1000)));
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1000)));
    let req = format!(
        "POST /__internal/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    let _ = stream.read(&mut buf);
    true
}

/// Stops the detached uplink daemon by its pidfile. Returns true if a live
/// uplink was signalled. Mirrors `stopUplinkDaemon`.
pub fn stop_uplink_daemon(env: &ConfigEnv, deps: &TeardownDeps) -> bool {
    let pid = match read_pid(&get_uplink_pid_path(env)) {
        Some(p) => p,
        None => return false,
    };
    if !(deps.is_process_alive)(pid) {
        return false;
    }
    (deps.kill_process)(pid, false)
}

struct DaemonOutcome {
    stopped: bool,
    dead: bool,
}

/// Kills a daemon by pid with the force-first / escalate logic shared by the
/// ingest and uplink branches. Mirrors the TS inline blocks.
fn stop_daemon(
    component: &str,
    pid: u32,
    deps: &TeardownDeps,
    failures: &mut Vec<KillFailure>,
) -> DaemonOutcome {
    let force_first = is_windows();
    let killed = (deps.kill_process)(pid, force_first);
    if !killed {
        failures.push(KillFailure {
            component: component.to_string(),
            pid,
            reason: "kill signal could not be sent".to_string(),
            advice: Some(kill_advice(pid)),
        });
        return DaemonOutcome {
            stopped: false,
            dead: false,
        };
    }
    if wait_for_death(pid, &deps.is_process_alive, deps.wait_timeout_ms, 100) {
        return DaemonOutcome {
            stopped: true,
            dead: true,
        };
    }
    if !force_first {
        (deps.kill_process)(pid, true);
    }
    if wait_for_death(
        pid,
        &deps.is_process_alive,
        deps.wait_timeout_ms.min(2000),
        100,
    ) {
        return DaemonOutcome {
            stopped: true,
            dead: true,
        };
    }
    failures.push(KillFailure {
        component: component.to_string(),
        pid,
        reason: "process did not terminate after force kill".to_string(),
        advice: Some(kill_advice(pid)),
    });
    DaemonOutcome {
        stopped: false,
        dead: false,
    }
}

/// Full local teardown of the dashboard stack. Mirrors `teardownLocalServerStack`.
pub fn teardown_local_server_stack(env: &ConfigEnv, deps: &TeardownDeps) -> TeardownReport {
    let mut failures: Vec<KillFailure> = Vec::new();
    let mut stale_files: Vec<StaleFile> = Vec::new();

    let home = get_climon_home(env);
    let server_state = read_server_state_from_dir(&home);
    let mut server_stopped = false;
    let mut server_dead = true;
    let mut server_pid: Option<u32> = None;
    if let Some(state) = &server_state {
        server_pid = Some(state.pid);
        if (deps.is_process_alive)(state.pid) {
            // Try graceful HTTP shutdown first.
            (deps.request_shutdown)(state.port);
            server_dead =
                wait_for_death(state.pid, &deps.is_process_alive, deps.wait_timeout_ms, 100);
            if server_dead {
                server_stopped = true;
            } else {
                let killed = (deps.kill_process)(state.pid, is_windows());
                if killed {
                    server_dead = wait_for_death(
                        state.pid,
                        &deps.is_process_alive,
                        deps.wait_timeout_ms,
                        100,
                    );
                    if server_dead {
                        server_stopped = true;
                    } else {
                        (deps.kill_process)(state.pid, true);
                        server_dead = wait_for_death(
                            state.pid,
                            &deps.is_process_alive,
                            deps.wait_timeout_ms.min(2000),
                            100,
                        );
                        if server_dead {
                            server_stopped = true;
                        } else {
                            failures.push(KillFailure {
                                component: "dashboard server".to_string(),
                                pid: state.pid,
                                reason: "process did not terminate after force kill".to_string(),
                                advice: Some(kill_advice(state.pid)),
                            });
                        }
                    }
                } else {
                    server_dead = false;
                    failures.push(KillFailure {
                        component: "dashboard server".to_string(),
                        pid: state.pid,
                        reason: "kill signal could not be sent".to_string(),
                        advice: Some(kill_advice(state.pid)),
                    });
                }
            }
        }
    }

    let ingest_pid = read_pid(&get_ingest_pid_path(env));
    let mut ingest_stopped = false;
    let mut ingest_dead = true;
    if let Some(pid) = ingest_pid {
        if (deps.is_process_alive)(pid) {
            let outcome = stop_daemon("ingest daemon", pid, deps, &mut failures);
            ingest_stopped = outcome.stopped;
            ingest_dead = outcome.dead;
        }
    }

    let uplink_pid = read_pid(&get_uplink_pid_path(env));
    let mut uplink_stopped = false;
    let mut uplink_dead = true;
    if let Some(pid) = uplink_pid {
        if (deps.is_process_alive)(pid) {
            let outcome = stop_daemon("uplink daemon", pid, deps, &mut failures);
            uplink_stopped = outcome.stopped;
            uplink_dead = outcome.dead;
        }
    }

    let mut removed: Vec<String> = Vec::new();
    let beacon_owners: Vec<(PathBuf, Option<u32>, bool)> = vec![
        (home.join("server.json"), server_pid, server_dead),
        (get_ingest_state_path(env), ingest_pid, ingest_dead),
        (get_ingest_pid_path(env), ingest_pid, ingest_dead),
        (get_uplink_pid_path(env), uplink_pid, uplink_dead),
        (get_shutdown_request_path(env), None, true),
    ];

    for (path, pid, dead) in beacon_owners {
        if !path.exists() {
            continue;
        }
        match (dead, pid) {
            (false, Some(pid)) => {
                stale_files.push(StaleFile {
                    path: path.to_string_lossy().into_owned(),
                    pid,
                });
            }
            _ => {
                (deps.remove_file)(&path);
                removed.push(path.to_string_lossy().into_owned());
            }
        }
    }

    TeardownReport {
        server_stopped,
        ingest_stopped,
        uplink_stopped,
        removed,
        failures,
        stale_files,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn temp_home() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let base = std::env::current_dir().unwrap().join(".copilot-tmp");
        std::fs::create_dir_all(&base).unwrap();
        let dir = base.join(format!(
            "climon-cleanup-{}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn config_env_for(home: &Path) -> ConfigEnv {
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
        std::fs::write(
            home.join("shutdown-request.json"),
            format!(
                "{}\n",
                serde_json::json!({"requestedBy": "Windows", "ts": 1})
            ),
        )
        .unwrap();
    }

    #[allow(clippy::type_complexity)]
    fn kill_succeeds() -> (
        Arc<Mutex<Vec<u32>>>,
        Arc<Mutex<Vec<u16>>>,
        TeardownDeps<'static>,
    ) {
        let killed: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
        let shutdowns: Arc<Mutex<Vec<u16>>> = Arc::new(Mutex::new(Vec::new()));
        let killed_alive = killed.clone();
        let killed_kill = killed.clone();
        let shutdown_ports = shutdowns.clone();
        let deps = TeardownDeps {
            is_process_alive: Box::new(move |pid| !killed_alive.lock().unwrap().contains(&pid)),
            kill_process: Box::new(move |pid, _force| {
                killed_kill.lock().unwrap().push(pid);
                true
            }),
            remove_file: Box::new(|path: &Path| {
                let _ = std::fs::remove_file(path);
            }),
            // Record the requested shutdown port instead of touching the network,
            // so this test never POSTs to a developer's live dashboard server.
            request_shutdown: Box::new(move |port| {
                shutdown_ports.lock().unwrap().push(port);
                true
            }),
            wait_timeout_ms: 3000,
        };
        (killed, shutdowns, deps)
    }

    #[test]
    fn kills_server_ingest_uplink_and_removes_beacons() {
        let home = temp_home();
        seed_stack(&home);
        let env = config_env_for(&home);
        let (killed, shutdowns, deps) = kill_succeeds();
        let report = teardown_local_server_stack(&env, &deps);
        // The graceful shutdown must go through the injected hook (never the real
        // network), targeting the port recorded in server.json.
        assert_eq!(*shutdowns.lock().unwrap(), vec![3131]);
        let mut k = killed.lock().unwrap().clone();
        k.sort_unstable();
        assert_eq!(k, vec![111, 222, 333]);
        assert!(report.server_stopped);
        assert!(report.ingest_stopped);
        assert!(report.uplink_stopped);
        assert!(report.failures.is_empty());
        assert!(report.stale_files.is_empty());
        assert!(!home.join("server.json").exists());
        assert!(!home.join("ingest.json").exists());
        assert!(!home.join("ingest.pid").exists());
        assert!(!home.join("uplink.pid").exists());
        assert!(!home.join("shutdown-request.json").exists());
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn idempotent_when_nothing_running() {
        let home = temp_home();
        let env = config_env_for(&home);
        let deps = TeardownDeps {
            is_process_alive: Box::new(|_| false),
            kill_process: Box::new(|_, _| false),
            remove_file: Box::new(|path: &Path| {
                let _ = std::fs::remove_file(path);
            }),
            request_shutdown: Box::new(|_| true),
            wait_timeout_ms: 3000,
        };
        let report = teardown_local_server_stack(&env, &deps);
        assert!(!report.server_stopped);
        assert!(!report.ingest_stopped);
        assert!(!report.uplink_stopped);
        assert!(report.removed.is_empty());
        assert!(report.failures.is_empty());
        assert!(report.stale_files.is_empty());
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn reports_failures_and_stale_files_when_kill_does_not_terminate() {
        let home = temp_home();
        seed_stack(&home);
        let env = config_env_for(&home);
        let deps = TeardownDeps {
            is_process_alive: Box::new(|_| true),
            kill_process: Box::new(|_, _| true),
            remove_file: Box::new(|path: &Path| {
                let _ = std::fs::remove_file(path);
            }),
            request_shutdown: Box::new(|_| true),
            wait_timeout_ms: 200,
        };
        let report = teardown_local_server_stack(&env, &deps);
        assert!(!report.server_stopped);
        assert!(!report.ingest_stopped);
        assert!(!report.uplink_stopped);
        assert_eq!(report.failures.len(), 3);
        assert_eq!(report.failures[0].component, "dashboard server");
        assert_eq!(report.failures[0].pid, 111);
        assert!(!report.stale_files.is_empty());
        assert!(home.join("server.json").exists());
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn does_not_remove_beacon_when_kill_signal_cannot_be_sent() {
        let home = temp_home();
        seed_stack(&home);
        let env = config_env_for(&home);
        let deps = TeardownDeps {
            is_process_alive: Box::new(|_| true),
            kill_process: Box::new(|_, _| false),
            remove_file: Box::new(|path: &Path| {
                let _ = std::fs::remove_file(path);
            }),
            request_shutdown: Box::new(|_| true),
            wait_timeout_ms: 200,
        };
        let report = teardown_local_server_stack(&env, &deps);
        assert!(!report.server_stopped);
        assert!(!report.ingest_stopped);
        assert!(!report.uplink_stopped);
        assert_eq!(report.failures.len(), 3);
        assert!(home.join("server.json").exists());
        assert!(home.join("ingest.pid").exists());
        assert!(home.join("uplink.pid").exists());
        assert!(!report.stale_files.is_empty());
        std::fs::remove_dir_all(&home).ok();
    }
}
