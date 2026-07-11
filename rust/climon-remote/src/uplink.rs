//! Devbox uplink client. Ports `src/remote/uplink.ts`: resolves the uplink
//! target from config, runs the mux bridge over a TCP channel to a remote
//! ingest daemon, and supervises reconnection (direct host, dev tunnel, or
//! same-machine WSL<->Windows peer discovery).
//!
//! The CLI is thread-based; this module runs on a tokio runtime created by the
//! `run_uplink` entry point (see `climon-cli`). The mux wire format and the
//! hello/attach/detach/data protocol MUST match the Bun side byte-for-byte.

// Task 8: this module returns the large typed `DevtunnelFailure` error surface
// from the centralized gateway; allow the lint crate-consistent with gateway.rs.
#![allow(clippy::result_large_err)]

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpStream as StdTcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use climon_config::config::{
    get_climon_home, resolve_config_setting, write_config_setting, Env as ConfigEnv, WriteScope,
};
use climon_proto::meta::SessionMetaPatch;
use climon_proto::meta::{Origin, PriorityReason, SessionStatus};
use climon_store::meta::{list_sessions, read_session_meta};
use climon_store::patch::patch_session_meta;
use climon_store::paths::Env as StoreEnv;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use crate::client_id::default_client_id;
use crate::devtunnel::{
    DevtunnelErrorCode, DevtunnelFailure, DevtunnelGateway, DevtunnelHealth, DevtunnelOperation,
    DevtunnelRetryClass, DevtunnelState, RetryController,
};
use crate::discovery::{discover_dashboard, DashboardLocation, DiscoveryDeps};
use crate::keepalive::mux_idle_timeout_ms;
use crate::mux::{encode_control, encode_data, ControlMessage, MuxDecoder, MuxMessage};
use crate::process::is_process_alive;
use crate::singleton::{acquire_singleton_detailed, SingletonResult};
use crate::spawn_auth::{
    sign_now, verify_signed_control, RejectReason, ReplayGuard, DEFAULT_FRESHNESS_WINDOW_MS,
};
use crate::target_set::UplinkTargetSpec;
use climon_session::socket::{parse_session_socket_ref, ParsedRef};

/// Default keepalive interval in seconds. Mirrors `DEFAULT_KEEPALIVE_SECONDS`.
pub const DEFAULT_KEEPALIVE_SECONDS: f64 = 60.0;

/// The resolved uplink target. Mirrors `UplinkConfig`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UplinkConfig {
    pub enabled: bool,
    pub host: Option<String>,
    pub tunnel_id: Option<String>,
    pub port: Option<u16>,
}

fn as_string(v: Option<Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

fn as_number(v: Option<Value>) -> Option<u16> {
    match v {
        Some(Value::Number(n)) => {
            let f = n.as_f64()?;
            if f.fract() == 0.0 && (0.0..=65535.0).contains(&f) {
                Some(f as u16)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Why an inbound control frame could not be dispatched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundError {
    /// The frame failed signature/replay/parse verification.
    Rejected(RejectReason),
}

/// Resolves an inbound control frame to the message to dispatch. When a secret
/// is configured, the frame MUST be a verified `Signed` envelope; otherwise the
/// frame is used as-is (legacy behavior; `Spawn` is ignored downstream).
fn unwrap_inbound(
    secret: Option<&str>,
    guard: &mut ReplayGuard,
    message: ControlMessage,
    now_ms: i64,
) -> Result<ControlMessage, InboundError> {
    match secret {
        Some(secret) => {
            verify_signed_control(secret, &message, guard, now_ms).map_err(InboundError::Rejected)
        }
        None => Ok(message),
    }
}

/// Builds the `climon __spawn …` argv (after the program name) for a Spawn.
fn build_spawn_argv(spawn: &ControlMessage) -> Vec<String> {
    let ControlMessage::Spawn {
        command,
        cwd,
        cols,
        rows,
        name,
        priority,
        color,
        headless,
        ..
    } = spawn
    else {
        return Vec::new();
    };
    let mut argv = vec!["__spawn".to_string()];
    if *headless {
        argv.push("--headless".into());
    }
    argv.push("--cwd".into());
    argv.push(cwd.clone());
    argv.push("--cols".into());
    argv.push(cols.to_string());
    argv.push("--rows".into());
    argv.push(rows.to_string());
    if let Some(priority) = priority {
        argv.push("--priority".into());
        argv.push(priority.to_string());
    }
    if let Some(color) = color {
        argv.push("--color".into());
        argv.push(color.clone());
    }
    if let Some(name) = name {
        argv.push("--name".into());
        argv.push(name.clone());
    }
    argv.extend(command.iter().cloned());
    argv
}

/// Runs `climon __spawn …` by re-executing the current binary, returning the
/// parsed (id, warning, error) outcome. Mirrors Plan A's SpawnOutcome JSON line.
fn run_spawn(spawn: &ControlMessage) -> (Option<String>, Option<String>, Option<String>) {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            return (
                None,
                None,
                Some(format!("cannot locate climon binary: {e}")),
            )
        }
    };
    let output = std::process::Command::new(exe)
        .args(build_spawn_argv(spawn))
        .output();
    match output {
        Ok(out) if out.status.success() => {
            let line = String::from_utf8_lossy(&out.stdout);
            let trimmed = line.trim().lines().last().unwrap_or("{}");
            match serde_json::from_str::<serde_json::Value>(trimmed) {
                Ok(v) => (
                    v.get("id").and_then(|x| x.as_str()).map(String::from),
                    v.get("warning").and_then(|x| x.as_str()).map(String::from),
                    None,
                ),
                Err(_) => (None, None, Some("invalid spawn outcome".into())),
            }
        }
        Ok(out) => (
            None,
            None,
            Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        ),
        Err(e) => (None, None, Some(format!("failed to run spawn: {e}"))),
    }
}

/// Current wall-clock time in milliseconds since the Unix epoch.
fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Resolves the devbox uplink config from the cascade. Remote is only considered
/// enabled when a direct host+port or tunnel id are present. Mirrors
/// `resolveUplinkConfig`.
pub fn resolve_uplink_config(env: &ConfigEnv, cwd: &Path) -> UplinkConfig {
    let enabled_flag =
        resolve_config_setting("remote.enabled", env, cwd) == Some(Value::Bool(true));
    let host = as_string(resolve_config_setting("remote.host", env, cwd));
    let tunnel_id = as_string(resolve_config_setting("remote.tunnelId", env, cwd));
    let port = as_number(resolve_config_setting("remote.port", env, cwd));
    let has_direct_target = host.is_some() && port.is_some();
    let has_tunnel_target = tunnel_id.is_some();
    UplinkConfig {
        enabled: enabled_flag && (has_direct_target || has_tunnel_target),
        host,
        tunnel_id,
        port,
    }
}

/// Returns the stable devbox client id, generating + persisting it globally if
/// absent. Mirrors `ensureClientId`.
pub fn ensure_client_id(env: &ConfigEnv, cwd: &Path) -> String {
    if let Some(existing) = as_string(resolve_config_setting("remote.clientId", env, cwd)) {
        return existing;
    }
    let id = default_client_id();
    let _ = write_config_setting("remote.clientId", &id, WriteScope::Global, env, cwd);
    id
}

fn resolve_keep_alive(env: &ConfigEnv, cwd: &Path) -> f64 {
    match resolve_config_setting("remote.keepAlive", env, cwd) {
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f >= 0.0 => f,
            _ => DEFAULT_KEEPALIVE_SECONDS,
        },
        _ => DEFAULT_KEEPALIVE_SECONDS,
    }
}

const LIVE_STATUSES: &[SessionStatus] = &[
    SessionStatus::Running,
    SessionStatus::Acknowledged,
    SessionStatus::NeedsAttention,
    SessionStatus::Paused,
];

/// Options for [`run_uplink_bridge`].
pub struct UplinkBridgeOptions {
    pub store_env: StoreEnv,
    pub client_id: String,
    pub keep_alive_seconds: Option<f64>,
    pub peer: bool,
    pub target: Option<crate::uplink_status::UplinkTarget>,
    pub connected_at: Option<u64>,
    pub config_env: ConfigEnv,
}

/// An attached local session socket: a writer channel feeding the blocking
/// session-socket writer thread, plus an active flag the reader thread polls so
/// it can exit on detach.
struct Attached {
    writer_tx: std::sync::mpsc::Sender<Vec<u8>>,
    active: Arc<std::sync::atomic::AtomicBool>,
}

type AttachedMap = Arc<AsyncMutex<HashMap<String, Attached>>>;

/// Connects to a local daemon session socket, returning two clones (one for the
/// reader thread, one for the writer thread) with a short read timeout so the
/// reader can poll the active flag and exit on detach.
fn connect_session_pair(
    reference: &str,
) -> std::io::Result<(Box<dyn ReadWrite>, Box<dyn ReadWrite>)> {
    match parse_session_socket_ref(reference)? {
        ParsedRef::Tcp { host, port } => {
            let stream = StdTcpStream::connect((host.as_str(), port))?;
            stream.set_read_timeout(Some(Duration::from_millis(200)))?;
            let clone = stream.try_clone()?;
            Ok((Box::new(stream), Box::new(clone)))
        }
        #[cfg(unix)]
        ParsedRef::Path(path) => {
            use std::os::unix::net::UnixStream;
            let stream = UnixStream::connect(&path)?;
            stream.set_read_timeout(Some(Duration::from_millis(200)))?;
            let clone = stream.try_clone()?;
            Ok((Box::new(stream), Box::new(clone)))
        }
        #[cfg(not(unix))]
        ParsedRef::Path(_) => Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "unix socket unsupported on this platform",
        )),
    }
}

trait ReadWrite: Read + Write + Send {}
impl<T: Read + Write + Send> ReadWrite for T {}

struct Bridge {
    send_tx: mpsc::UnboundedSender<Vec<u8>>,
    attached: AttachedMap,
    advertised: HashSet<String>,
    store_env: Arc<StoreEnv>,
    spawn_secret: Option<String>,
    target: Option<crate::uplink_status::UplinkTarget>,
    connected_at: Option<u64>,
    config_env: ConfigEnv,
}

impl Bridge {
    fn write(&self, buf: Vec<u8>) {
        let _ = self.send_tx.send(buf);
    }
}

async fn reconcile(bridge: &mut Bridge) {
    let mut current: HashSet<String> = HashSet::new();
    let sessions = list_sessions(&bridge.store_env).unwrap_or_default();
    for mut meta in sessions {
        if meta.origin == Some(Origin::Remote) {
            continue;
        }
        current.insert(meta.id.clone());
        if LIVE_STATUSES.contains(&meta.status) {
            if let Some(pid) = meta.daemon_pid {
                if !is_process_alive(pid) {
                    meta.status = SessionStatus::Disconnected;
                    meta.priority_reason = PriorityReason::Disconnected;
                    let _ = patch_session_meta(
                        &bridge.store_env,
                        &meta.id,
                        SessionMetaPatch {
                            status: Some(SessionStatus::Disconnected),
                            priority_reason: Some(PriorityReason::Disconnected),
                            ..Default::default()
                        },
                    );
                }
            }
        }
        bridge.write(encode_control(&ControlMessage::SessionAdded {
            meta: Box::new(meta),
        }));
    }
    for id in &bridge.advertised {
        if !current.contains(id) {
            bridge.write(encode_control(&ControlMessage::SessionRemoved {
                id: id.clone(),
            }));
        }
    }
    let ids: Vec<String> = current.iter().cloned().collect();
    let snapshot = ControlMessage::SessionList { ids };
    // When a spawn secret is configured, the destructive snapshot must be a
    // verified Signed envelope so a clientId spoofer cannot delete sessions.
    let frame = match &bridge.spawn_secret {
        Some(secret) => {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            encode_control(&crate::spawn_auth::sign_now(secret, &snapshot, now_ms))
        }
        None => encode_control(&snapshot),
    };
    bridge.write(frame);
    bridge.advertised = current;

    // Refresh the status beacon's session count + updatedAt while connected so
    // `climon remotes` reflects live counts and can detect a stalled uplink.
    let status = crate::uplink_status::UplinkStatus {
        pid: std::process::id(),
        updated_at: crate::time::now_ms(),
        target: bridge.target.clone(),
        state: "connected".into(),
        connected_at: bridge.connected_at,
        session_count: bridge.advertised.len() as u32,
        last_error: None,
        devtunnel: Some(DevtunnelHealth::healthy(
            DevtunnelState::Running,
            None,
            climon_store::paths::now_iso(),
        )),
    };
    let _ = crate::uplink_status::write_uplink_status(&status, &bridge.config_env);
}

async fn attach(bridge: &Bridge, session_id: &str) {
    {
        let map = bridge.attached.lock().await;
        if map.contains_key(session_id) {
            return;
        }
    }
    let meta = match read_session_meta(&bridge.store_env, session_id) {
        Ok(Some(m)) => m,
        _ => return,
    };
    let (reader, writer) = match connect_session_pair(&meta.socket_path) {
        Ok(pair) => pair,
        Err(_) => return,
    };
    let active = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let (writer_tx, writer_rx) = std::sync::mpsc::channel::<Vec<u8>>();

    // Writer thread: drains inbound data frames to the session socket.
    {
        let mut writer = writer;
        std::thread::spawn(move || {
            while let Ok(buf) = writer_rx.recv() {
                if writer.write_all(&buf).is_err() {
                    break;
                }
            }
        });
    }

    // Reader thread: forwards session output as mux data frames until detached.
    {
        let send_tx = bridge.send_tx.clone();
        let active_reader = active.clone();
        let attached = bridge.attached.clone();
        let id = session_id.to_string();
        let mut reader = reader;
        std::thread::spawn(move || {
            let mut buf = [0u8; 64 * 1024];
            loop {
                if !active_reader.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Ok(frame) = encode_data(&id, &buf[..n]) {
                            if send_tx.send(frame).is_err() {
                                break;
                            }
                        }
                    }
                    Err(ref e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut =>
                    {
                        continue;
                    }
                    Err(_) => break,
                }
            }
            // Best-effort removal so a future attach can reconnect.
            if let Ok(mut map) = attached.try_lock() {
                map.remove(&id);
            }
        });
    }

    let mut map = bridge.attached.lock().await;
    map.insert(session_id.to_string(), Attached { writer_tx, active });
}

async fn detach(bridge: &Bridge, session_id: &str) {
    let mut map = bridge.attached.lock().await;
    if let Some(att) = map.remove(session_id) {
        att.active
            .store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Runs the mux bridge over an already-connected channel to an ingest daemon.
/// Sends `hello` first, advertises local sessions, and bridges attach/detach/data
/// until the channel closes. Mirrors `runUplinkBridge`.
pub async fn run_uplink_bridge(channel: TcpStream, options: UplinkBridgeOptions) {
    let keep_alive_ms = (options
        .keep_alive_seconds
        .unwrap_or(DEFAULT_KEEPALIVE_SECONDS)
        .max(0.0)
        * 1000.0) as u64;
    let idle_timeout_ms = mux_idle_timeout_ms(keep_alive_ms as f64);

    let (mut read_half, write_half) = channel.into_split();
    let (send_tx, mut send_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let writer = tokio::spawn(async move {
        let mut write_half = write_half;
        while let Some(buf) = send_rx.recv().await {
            if write_half.write_all(&buf).await.is_err() {
                break;
            }
        }
        let _ = write_half.shutdown().await;
    });

    // Resolve the spawn secret + feature gate once. When a secret is present,
    // every inbound control frame MUST be a verified Signed envelope, a Spawn is
    // only honored when feature.remoteSpawn is enabled, and the outbound
    // session-list snapshot is signed (see reconcile).
    let config_env = options.config_env.clone();
    let spawn_secret: Option<String> = as_string(resolve_config_setting(
        "remote.spawnSecret",
        &config_env,
        Path::new("."),
    ));
    let remote_spawn_enabled = climon_config::config::load_config(&config_env)
        .map(|cfg| climon_config::features::is_feature_enabled(&cfg, "remoteSpawn"))
        .unwrap_or(false);

    let mut bridge = Bridge {
        send_tx: send_tx.clone(),
        attached: Arc::new(AsyncMutex::new(HashMap::new())),
        advertised: HashSet::new(),
        store_env: Arc::new(options.store_env),
        spawn_secret: spawn_secret.clone(),
        target: options.target.clone(),
        connected_at: options.connected_at,
        config_env: config_env.clone(),
    };

    bridge.write(encode_control(&ControlMessage::Hello {
        client_id: options.client_id.clone(),
        peer: options.peer,
        hostname: Some(climon_store::paths::hostname()).filter(|h| !h.is_empty()),
        os: Some(climon_store::paths::node_platform().to_string()),
    }));
    reconcile(&mut bridge).await;

    // Sessions-dir watcher: re-advertise local sessions whenever the metadata on
    // disk changes so sessions created (or updated) AFTER the channel connects
    // reach the remote dashboard without waiting for a reconnect. Mirrors the TS
    // `watch(getSessionsDir(env), () => reconcile(bridge))`; this port uses the
    // workspace's polling primitive (`shutdown_watch::spawn_poll`) as the fs.watch
    // equivalent and only fires when the set of `*.json` files or their
    // mtime/size changes, so a quiet channel does not re-send frames.
    let reconcile_signal = Arc::new(tokio::sync::Notify::new());
    let _sessions_watcher = {
        let sessions_dir = bridge.store_env.sessions_dir();
        let signal = reconcile_signal.clone();
        let mut last = sessions_signature(&sessions_dir);
        crate::shutdown_watch::spawn_poll(crate::shutdown_watch::DEFAULT_POLL_MS, move || {
            let current = sessions_signature(&sessions_dir);
            if current != last {
                last = current;
                signal.notify_one();
            }
        })
    };

    let last_activity = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));

    // Keepalive ping timer.
    let mut keepalive_task: Option<tokio::task::JoinHandle<()>> = None;
    if keep_alive_ms > 0 {
        let ka_tx = send_tx.clone();
        keepalive_task = Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(keep_alive_ms));
            interval.tick().await;
            loop {
                interval.tick().await;
                if ka_tx.send(encode_control(&ControlMessage::Ping)).is_err() {
                    break;
                }
            }
        }));
    }

    // Status heartbeat: refresh uplink-status.json's updatedAt + session count
    // every 10s while connected, so the reader-derived staleness does not flip a
    // healthy uplink to stale between the (infrequent) supervisor state
    // transitions. Mirrors the ingest's status heartbeat.
    let status_task = {
        let store_env = bridge.store_env.clone();
        let cfg = config_env.clone();
        let target = bridge.target.clone();
        let connected_at = bridge.connected_at;
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(10));
            tick.tick().await;
            loop {
                tick.tick().await;
                let status = crate::uplink_status::UplinkStatus {
                    pid: std::process::id(),
                    updated_at: crate::time::now_ms(),
                    target: target.clone(),
                    state: "connected".into(),
                    connected_at,
                    session_count: live_session_count(&store_env),
                    last_error: None,
                    devtunnel: Some(DevtunnelHealth::healthy(
                        DevtunnelState::Running,
                        None,
                        climon_store::paths::now_iso(),
                    )),
                };
                let _ = crate::uplink_status::write_uplink_status(&status, &cfg);
            }
        })
    };

    // Idle teardown: destroy the channel if no inbound frames arrive in time.
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let mut idle_task: Option<tokio::task::JoinHandle<()>> = None;
    if keep_alive_ms > 0 && idle_timeout_ms > 0 {
        let idle = Duration::from_millis(idle_timeout_ms);
        let last = last_activity.clone();
        let sd = shutdown.clone();
        idle_task = Some(tokio::spawn(async move {
            loop {
                let deadline = *last.lock().unwrap() + idle;
                let now = std::time::Instant::now();
                if now >= deadline {
                    sd.notify_one();
                    break;
                }
                tokio::time::sleep(deadline - now).await;
            }
        }));
    }

    let mut decoder = MuxDecoder::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut replay_guard = ReplayGuard::new(DEFAULT_FRESHNESS_WINDOW_MS);
    loop {
        tokio::select! {
            _ = shutdown.notified() => break,
            _ = reconcile_signal.notified() => {
                // Sessions dir changed: re-advertise so new/updated local sessions
                // (and any that disappeared) are pushed to the remote dashboard.
                reconcile(&mut bridge).await;
            }
            read = read_half.read(&mut buf) => {
                let n = match read {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                *last_activity.lock().unwrap() = std::time::Instant::now();
                let messages = match decoder.push(&buf[..n]) {
                    Ok(m) => m,
                    Err(_) => break, // oversized/torn frame: tear the channel down.
                };
                for msg in messages {
                    match msg {
                        MuxMessage::Control(control) => {
                            let now_ms = unix_millis();
                            let inner = match unwrap_inbound(
                                spawn_secret.as_deref(),
                                &mut replay_guard,
                                control,
                                now_ms,
                            ) {
                                Ok(inner) => inner,
                                // Reject unsigned/forged/replayed when a secret is present.
                                Err(_) => continue,
                            };
                            match inner {
                                ControlMessage::Attach { id } => attach(&bridge, &id).await,
                                ControlMessage::Detach { id } => detach(&bridge, &id).await,
                                ControlMessage::Ping => {
                                    bridge.write(encode_control(&ControlMessage::Pong));
                                }
                                ControlMessage::Spawn { ref request_id, .. } => {
                                    if let (Some(secret), true) =
                                        (spawn_secret.as_deref(), remote_spawn_enabled)
                                    {
                                        let request_id = request_id.clone();
                                        let (id, warning, error) = run_spawn(&inner);
                                        let result = ControlMessage::SpawnResult {
                                            request_id,
                                            id,
                                            warning,
                                            error,
                                        };
                                        bridge.write(encode_control(&sign_now(
                                            secret,
                                            &result,
                                            unix_millis(),
                                        )));
                                    }
                                }
                                _ => {}
                            }
                        }
                        MuxMessage::Data { session_id, data } => {
                            let map = bridge.attached.lock().await;
                            if let Some(att) = map.get(&session_id) {
                                let _ = att.writer_tx.send(data);
                            }
                        }
                    }
                }
            }
        }
    }

    // Teardown.
    status_task.abort();
    if let Some(t) = keepalive_task.take() {
        t.abort();
    }
    if let Some(t) = idle_task.take() {
        t.abort();
    }
    {
        let mut map = bridge.attached.lock().await;
        for (_, att) in map.drain() {
            att.active
                .store(false, std::sync::atomic::Ordering::Relaxed);
        }
    }
    drop(send_tx);
    drop(bridge);
    let _ = writer.await;
}

// ---------------------------------------------------------------------------
// Supervisor (devtunnel / direct / peer discovery). Faithful port of runUplink.
// These paths shell out to `devtunnel`; they are behaviour-ported and exercised
// by manual tests, mirroring the TS (which has no unit test for runUplink).
// ---------------------------------------------------------------------------

const DISCOVERY_POLL_SECS: u64 = 30;

/// The outcome of feeding a classified [`DevtunnelFailure`] to a tunnel target's
/// [`RetryController`]: either wait `delay_ms` and reconnect (transient) or park
/// until the target changes (actionable/permanent).
#[derive(Debug, Clone, PartialEq, Eq)]
enum ReconnectAction {
    Backoff {
        delay_ms: u64,
        health: DevtunnelHealth,
    },
    Pause {
        reason: String,
        health: DevtunnelHealth,
    },
}

/// Records a failure against the controller and decides whether to reconnect
/// with capped backoff or pause. Jitter is fixed at `0.5` (multiplier `1.0`) so
/// the sequence is deterministic; the controller pauses non-transient failures.
/// The classified failure + retry state are captured once into a
/// [`DevtunnelHealth`] snapshot so the beacon never rebuilds failure strings.
fn plan_reconnect(controller: &mut RetryController, failure: &DevtunnelFailure) -> ReconnectAction {
    let now_ms = crate::time::now_ms();
    let state = controller.fail(failure, now_ms, 0.5);
    let probed_at = climon_store::paths::now_iso();
    if state.paused {
        let health = DevtunnelHealth::from_failure(
            DevtunnelState::Paused,
            failure.clone(),
            Some(state),
            probed_at,
        );
        ReconnectAction::Pause {
            reason: failure.summary.clone(),
            health,
        }
    } else {
        let delay_ms = controller.backoff_delay_ms(state.attempt, failure.retry_after_ms, 0.5);
        let health = DevtunnelHealth::from_failure(
            DevtunnelState::Retrying,
            failure.clone(),
            Some(state),
            probed_at,
        );
        ReconnectAction::Backoff { delay_ms, health }
    }
}

/// A synthetic transient failure for direct-host (non-tunnel) reconnects, which
/// never involve Dev Tunnels: the capped-exponential backoff still applies, but
/// no classification of `devtunnel` output is performed.
fn direct_reconnect_failure() -> DevtunnelFailure {
    DevtunnelFailure {
        code: DevtunnelErrorCode::NetworkUnavailable,
        operation: DevtunnelOperation::ConnectTunnel,
        summary: "The remote ingest is not reachable yet.".to_string(),
        remediation: "Climon will retry automatically.".to_string(),
        technical_detail: "direct-host reconnect".to_string(),
        occurred_at: climon_store::paths::now_iso(),
        retry_class: DevtunnelRetryClass::Transient,
        retryable: true,
        retry_after_ms: None,
        status: None,
    }
}

/// A long-running `devtunnel connect <id>` child spawned through the shared
/// [`DevtunnelGateway`]. stdout/stderr are streamed into a shared buffer so the
/// eventual exit can be classified into a typed [`DevtunnelFailure`].
struct ConnectProcess {
    child: tokio::process::Child,
    operation: DevtunnelOperation,
    output: Arc<std::sync::Mutex<(String, String)>>,
}

impl ConnectProcess {
    fn spawn(gateway: &DevtunnelGateway, tunnel_id: &str) -> Result<Self, DevtunnelFailure> {
        let spawned = gateway.spawn_connect(tunnel_id)?;
        let output = Arc::new(std::sync::Mutex::new((String::new(), String::new())));
        spawn_output_reader(spawned.stdout, output.clone(), true);
        spawn_output_reader(spawned.stderr, output.clone(), false);
        Ok(Self {
            child: spawned.child,
            operation: spawned.operation,
            output,
        })
    }

    /// Awaits the connect process exit and classifies it. A clean exit is still
    /// treated as an unexpected (transient) process exit so the supervisor
    /// reconnects.
    async fn wait_exit(&mut self) -> DevtunnelFailure {
        let status = self.child.wait().await;
        self.classify_exit(status.ok().and_then(|s| s.code()))
    }

    /// Non-blocking exit classification. Returns `None` while still running.
    fn try_exit(&mut self) -> Option<DevtunnelFailure> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(self.classify_exit(status.code())),
            _ => None,
        }
    }

    fn classify_exit(&self, code: Option<i32>) -> DevtunnelFailure {
        let code = code.unwrap_or(1);
        let (stdout, stderr) = self.output.lock().unwrap().clone();
        crate::devtunnel::classify_devtunnel_exit(
            self.operation.clone(),
            if code == 0 { 1 } else { code },
            &stdout,
            &stderr,
            None,
            &climon_store::paths::now_iso(),
        )
        .unwrap_or_else(direct_reconnect_failure)
    }

    async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }
}

fn spawn_output_reader<R>(
    reader: R,
    output: Arc<std::sync::Mutex<(String, String)>>,
    is_stdout: bool,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]);
                    let mut guard = output.lock().unwrap();
                    if is_stdout {
                        guard.0.push_str(&text);
                    } else {
                        guard.1.push_str(&text);
                    }
                }
            }
        }
    });
}

/// Discovers the forwarded port for a tunnel via the gateway `port list`.
/// Mirrors `discoverTunnelPort`. Returns `Err` with the classified failure when
/// the gateway op fails so callers can pause on actionable failures.
async fn discover_tunnel_port(
    gateway: &DevtunnelGateway,
    tunnel_id: &str,
) -> Result<Option<u16>, DevtunnelFailure> {
    let result = gateway.list_ports(tunnel_id).await?;
    Ok(parse_tunnel_port(&result.stdout))
}

/// Extracts the first usable forwarded port from `devtunnel port list --json`
/// output, tolerating both array and object shapes and falling back to the first
/// 2-5 digit run. Pure so it is unit-testable without shelling out.
fn parse_tunnel_port(stdout: &str) -> Option<u16> {
    if let Ok(parsed) = serde_json::from_str::<Value>(stdout) {
        let ports = if parsed.is_array() {
            parsed.as_array().cloned().unwrap_or_default()
        } else {
            parsed
                .get("ports")
                .or_else(|| parsed.get("value"))
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
        };
        for entry in ports {
            let p = entry
                .get("portNumber")
                .or_else(|| entry.get("port"))
                .or_else(|| entry.get("Port"))
                .and_then(|v| v.as_u64());
            if let Some(p) = p {
                if p > 0 && p <= 65535 {
                    return Some(p as u16);
                }
            }
        }
        return None;
    }
    // Line-based fallback: first 2-5 digit run.
    let mut digits = String::new();
    for ch in stdout.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else if !digits.is_empty() {
            if (2..=5).contains(&digits.len()) {
                return digits.parse().ok();
            }
            digits.clear();
        }
    }
    if (2..=5).contains(&digits.len()) {
        return digits.parse().ok();
    }
    None
}

async fn wait_for_port(port: u16, host: &str, timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if TcpStream::connect((host, port)).await.is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    false
}

fn resolve_peer_uplink_target(config_env: &ConfigEnv, cwd: &Path) -> Option<(String, u16)> {
    let peer_home = as_string(resolve_config_setting("remote.peerHome", config_env, cwd))?;
    let _ = peer_home;
    let target = discover_dashboard(config_env, cwd, &DiscoveryDeps::default())?;
    if target.location == DashboardLocation::Peer {
        if let Some(ingest) = target.ingest {
            return Some((target.host, ingest));
        }
    }
    None
}

/// Devbox uplink supervisor. Singleton. Mirrors `runUplink`. Returns the process
/// exit code.
/// Classifies the uplink target for the status beacon. A peer connection is a
/// same-machine WSL<->Windows bridge; a tunnel has a tunnelId; otherwise direct.
fn build_uplink_target(
    is_peer: bool,
    host: &str,
    port: u16,
    tunnel_id: Option<&str>,
) -> crate::uplink_status::UplinkTarget {
    let kind = if is_peer {
        "peer"
    } else if tunnel_id.is_some() {
        "tunnel"
    } else {
        "direct"
    };
    crate::uplink_status::UplinkTarget {
        kind: kind.to_string(),
        host: Some(host.to_string()),
        port: Some(port),
        tunnel_id: tunnel_id.map(String::from),
        url: None,
    }
}

/// Computes a cheap change signature for the sessions directory from the set of
/// `*.json` metadata files and their (size, mtime). Used by the sessions-dir
/// watcher to trigger a re-advertise only when session metadata actually changes.
fn sessions_signature(sessions_dir: &Path) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut entries: Vec<(String, u64, u128)> = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(sessions_dir) {
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".json") {
                continue;
            }
            let (len, mtime) = entry
                .metadata()
                .map(|m| {
                    let mtime = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_nanos())
                        .unwrap_or(0);
                    (m.len(), mtime)
                })
                .unwrap_or((0, 0));
            entries.push((name, len, mtime));
        }
    }
    entries.sort();
    let mut hasher = DefaultHasher::new();
    entries.hash(&mut hasher);
    hasher.finish()
}

/// Counts local (non-remote) sessions advertised by this uplink.
fn live_session_count(store_env: &StoreEnv) -> u32 {
    list_sessions(store_env)
        .map(|s| {
            s.iter()
                .filter(|m| m.origin != Some(Origin::Remote))
                .count() as u32
        })
        .unwrap_or(0)
}

fn write_supervisor_status(
    config_env: &ConfigEnv,
    state: &str,
    target: Option<crate::uplink_status::UplinkTarget>,
    connected_at: Option<u64>,
    session_count: u32,
    last_error: Option<String>,
    devtunnel: Option<DevtunnelHealth>,
) {
    // Keep `last_error` populated for pre-devtunnel readers: fall back to the
    // health snapshot's failure summary when the caller did not pass one.
    let last_error = last_error.or_else(|| {
        devtunnel
            .as_ref()
            .and_then(|h| h.last_failure.as_ref().map(|f| f.summary.clone()))
    });
    let status = crate::uplink_status::UplinkStatus {
        pid: std::process::id(),
        updated_at: crate::time::now_ms(),
        target,
        state: state.to_string(),
        connected_at,
        session_count,
        last_error,
        devtunnel,
    };
    let _ = crate::uplink_status::write_uplink_status(&status, config_env);
}

pub fn target_key(spec: &UplinkTargetSpec) -> String {
    match spec {
        UplinkTargetSpec::Tunnel { tunnel_id } => format!("tunnel:{tunnel_id}"),
        UplinkTargetSpec::Direct { host, port } => format!("direct:{host}:{port}"),
    }
}

pub struct TargetHandle {
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
    #[cfg(test)]
    fake: Option<(String, std::rc::Rc<std::cell::RefCell<Vec<String>>>)>,
}

#[derive(Default)]
pub struct TargetSupervisor {
    pub active: std::collections::HashMap<String, TargetHandle>,
}

impl TargetHandle {
    pub fn new(cancel: CancellationToken, task: tokio::task::JoinHandle<()>) -> Self {
        Self {
            cancel,
            task: Some(task),
            #[cfg(test)]
            fake: None,
        }
    }

    #[cfg(test)]
    pub fn fake(key: String, cancelled: std::rc::Rc<std::cell::RefCell<Vec<String>>>) -> Self {
        Self {
            cancel: CancellationToken::new(),
            task: None,
            fake: Some((key, cancelled)),
        }
    }

    fn cancel(&self) {
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
        #[cfg(test)]
        if let Some((key, log)) = &self.fake {
            log.borrow_mut().push(key.clone());
        }
    }
}

/// Spawns bridge tasks for newly-desired targets and cancels tasks for targets no
/// longer desired. Pure w.r.t. the injected `spawn`; no async here.
pub fn reconcile_targets(
    active: &mut std::collections::HashMap<String, TargetHandle>,
    desired: &[UplinkTargetSpec],
    spawn: &mut dyn FnMut(&UplinkTargetSpec) -> TargetHandle,
) {
    let desired_keys: std::collections::HashSet<String> = desired.iter().map(target_key).collect();
    let stale: Vec<String> = active
        .keys()
        .filter(|k| !desired_keys.contains(*k))
        .cloned()
        .collect();
    for key in stale {
        if let Some(handle) = active.remove(&key) {
            handle.cancel();
        }
    }
    for spec in desired {
        let key = target_key(spec);
        if let std::collections::hash_map::Entry::Vacant(entry) = active.entry(key) {
            entry.insert(spawn(spec));
        }
    }
}

fn remote_enabled(config_env: &ConfigEnv, cwd: &Path) -> bool {
    resolve_config_setting("remote.enabled", config_env, cwd) == Some(Value::Bool(true))
}

async fn sleep_backoff_or_cancel(cancel: &CancellationToken, backoff_ms: u64) -> bool {
    tokio::select! {
        _ = cancel.cancelled() => true,
        _ = tokio::time::sleep(Duration::from_millis(backoff_ms)) => false,
    }
}

async fn run_target_bridge(
    spec: UplinkTargetSpec,
    config_env: ConfigEnv,
    store_env: StoreEnv,
    client_id: String,
    cwd: std::path::PathBuf,
    cancel: CancellationToken,
) {
    // A tunnel target's classified failures drive a shared retry controller so
    // transient errors back off with capped exponential jitter and actionable
    // errors (auth/quota) pause instead of hammering. Direct-host targets never
    // touch Dev Tunnels but reuse the same backoff for reachability retries.
    let gateway = DevtunnelGateway::new();
    let mut retry = RetryController::new();
    loop {
        if cancel.is_cancelled() {
            return;
        }
        let started_at = std::time::Instant::now();
        let mut conn: Option<ConnectProcess> = None;

        let (host, port, tunnel_id, is_peer_connection) = match &spec {
            UplinkTargetSpec::Direct { host, port } => {
                let is_peer = resolve_peer_uplink_target(&config_env, &cwd)
                    .map(|(peer_host, peer_port)| peer_host == *host && peer_port == *port)
                    .unwrap_or(false);
                (host.clone(), *port, None, is_peer)
            }
            UplinkTargetSpec::Tunnel { tunnel_id } => {
                let config = resolve_uplink_config(&config_env, &cwd);
                let configured_port = if config.tunnel_id.as_deref() == Some(tunnel_id.as_str()) {
                    config.port
                } else {
                    None
                };
                let tunnel_port = match configured_port {
                    Some(p) => Some(p),
                    None => {
                        let discovered = tokio::select! {
                            _ = cancel.cancelled() => return,
                            d = discover_tunnel_port(&gateway, tunnel_id) => d,
                        };
                        match discovered {
                            Ok(p) => p,
                            Err(failure) => {
                                let action = plan_reconnect(&mut retry, &failure);
                                if apply_reconnect(action, &cancel, &config_env, None).await {
                                    return;
                                }
                                continue;
                            }
                        }
                    }
                };
                let Some(tunnel_port) = tunnel_port else {
                    // The list succeeded but exposed no usable port yet; retry.
                    let action = plan_reconnect(&mut retry, &direct_reconnect_failure());
                    if apply_reconnect(action, &cancel, &config_env, None).await {
                        return;
                    }
                    continue;
                };
                match ConnectProcess::spawn(&gateway, tunnel_id) {
                    Ok(c) => {
                        conn = Some(c);
                        (
                            "127.0.0.1".to_string(),
                            tunnel_port,
                            Some(tunnel_id.clone()),
                            false,
                        )
                    }
                    Err(failure) => {
                        let action = plan_reconnect(&mut retry, &failure);
                        if apply_reconnect(action, &cancel, &config_env, None).await {
                            return;
                        }
                        continue;
                    }
                }
            }
        };

        let target = build_uplink_target(is_peer_connection, &host, port, tunnel_id.as_deref());
        write_supervisor_status(
            &config_env,
            "connecting",
            Some(target.clone()),
            None,
            0,
            None,
            Some(DevtunnelHealth::healthy(
                DevtunnelState::Starting,
                None,
                climon_store::paths::now_iso(),
            )),
        );

        // Wait for the forwarded port to become reachable while also watching for
        // an early connect-process exit (e.g. an auth rejection surfaces as the
        // `devtunnel connect` child exiting with an actionable failure).
        let reachable = if let Some(c) = conn.as_mut() {
            tokio::select! {
                _ = cancel.cancelled() => { conn_kill(&mut conn).await; return; }
                failure = c.wait_exit() => {
                    conn_kill(&mut conn).await;
                    let action = plan_reconnect(&mut retry, &failure);
                    if apply_reconnect(action, &cancel, &config_env, Some(target.clone())).await {
                        return;
                    }
                    continue;
                }
                reachable = wait_for_port(port, &host, 15_000) => reachable,
            }
        } else {
            tokio::select! {
                _ = cancel.cancelled() => return,
                reachable = wait_for_port(port, &host, 15_000) => reachable,
            }
        };

        if !reachable {
            // The connect child may have exited with a classified cause; prefer
            // it over the synthetic transient reachability failure.
            let failure = conn
                .as_mut()
                .and_then(|c| c.try_exit())
                .unwrap_or_else(direct_reconnect_failure);
            conn_kill(&mut conn).await;
            let action = plan_reconnect(&mut retry, &failure);
            if apply_reconnect(action, &cancel, &config_env, Some(target.clone())).await {
                return;
            }
            continue;
        }

        let mut connected = false;
        if let Ok(channel) = TcpStream::connect((host.as_str(), port)).await {
            connected = true;
            let connected_at = crate::time::now_ms();
            write_supervisor_status(
                &config_env,
                "connected",
                Some(target.clone()),
                Some(connected_at),
                live_session_count(&store_env),
                None,
                Some(DevtunnelHealth::healthy(
                    DevtunnelState::Running,
                    Some(climon_store::paths::now_iso()),
                    climon_store::paths::now_iso(),
                )),
            );
            let bridge = run_uplink_bridge(
                channel,
                UplinkBridgeOptions {
                    store_env: store_env.clone(),
                    client_id: client_id.clone(),
                    keep_alive_seconds: Some(resolve_keep_alive(&config_env, &cwd)),
                    peer: is_peer_connection,
                    target: Some(target.clone()),
                    connected_at: Some(connected_at),
                    config_env: config_env.clone(),
                },
            );
            tokio::select! {
                _ = cancel.cancelled() => { conn_kill(&mut conn).await; return; }
                _ = bridge => {}
            }
        }

        // Unified reconnect decision: classify the connect exit if it stopped;
        // otherwise treat the drop as transient. Reset the controller after a
        // stable session so a long-lived connection restarts from base backoff.
        let stable = connected && started_at.elapsed() > Duration::from_secs(30);
        let failure = conn
            .as_mut()
            .and_then(|c| c.try_exit())
            .unwrap_or_else(direct_reconnect_failure);
        conn_kill(&mut conn).await;
        if stable {
            retry.success();
        }
        let action = plan_reconnect(&mut retry, &failure);
        if apply_reconnect(action, &cancel, &config_env, Some(target.clone())).await {
            return;
        }
    }
}

/// Kills and drops the connect child, if any.
async fn conn_kill(conn: &mut Option<ConnectProcess>) {
    if let Some(mut c) = conn.take() {
        c.kill().await;
    }
}

/// Applies a [`ReconnectAction`]: a pause writes a `paused` status and parks
/// until the target is cancelled; a backoff writes `reconnecting` and sleeps.
/// Returns `true` when the bridge task should stop looping (cancelled or paused).
async fn apply_reconnect(
    action: ReconnectAction,
    cancel: &CancellationToken,
    config_env: &ConfigEnv,
    target: Option<crate::uplink_status::UplinkTarget>,
) -> bool {
    match action {
        ReconnectAction::Pause { reason, health } => {
            write_supervisor_status(
                config_env,
                "paused",
                target,
                None,
                0,
                Some(reason),
                Some(health),
            );
            cancel.cancelled().await;
            true
        }
        ReconnectAction::Backoff { delay_ms, health } => {
            write_supervisor_status(
                config_env,
                "reconnecting",
                target,
                None,
                0,
                None,
                Some(health),
            );
            sleep_backoff_or_cancel(cancel, delay_ms).await
        }
    }
}

pub async fn run_uplink(config_env: ConfigEnv, store_env: StoreEnv, cwd: &Path) -> i32 {
    let peer_home = as_string(resolve_config_setting("remote.peerHome", &config_env, cwd));
    if peer_home.is_none() && !remote_enabled(&config_env, cwd) {
        return 0;
    }

    let pid_file = get_climon_home(&config_env).join("uplink.pid");
    // Hold the singleton guard for the whole supervisor loop: the OS lock is
    // released only when this process exits, so a crashed uplink (or a recycled
    // PID) can never block a fresh one from taking over.
    let _singleton_guard = match acquire_singleton_detailed(&pid_file) {
        SingletonResult {
            acquired: true,
            guard: Some(guard),
            ..
        } => guard,
        _ => return 0,
    };

    let client_id = ensure_client_id(&config_env, cwd);
    let mut supervisor = TargetSupervisor::default();
    let discovery_gateway = DevtunnelGateway::new();

    loop {
        let enabled = remote_enabled(&config_env, cwd);
        let peer_target = if peer_home.is_some() {
            resolve_peer_uplink_target(&config_env, cwd)
        } else {
            None
        };
        let config = resolve_uplink_config(&config_env, cwd);
        if !enabled && peer_home.is_none() {
            reconcile_targets(&mut supervisor.active, &[], &mut |_| unreachable!());
            write_supervisor_status(
                &config_env,
                "disconnected",
                None,
                None,
                0,
                None,
                Some(DevtunnelHealth::healthy(
                    DevtunnelState::Stopped,
                    None,
                    climon_store::paths::now_iso(),
                )),
            );
            return 0;
        }

        let discover_enabled =
            resolve_config_setting("remote.discover", &config_env, cwd) != Some(Value::Bool(false));
        let own_install_id = as_string(resolve_config_setting("install.id", &config_env, cwd));
        let discovered = if enabled && discover_enabled {
            match crate::discovery::list_climon_ingest_tunnels(&discovery_gateway).await {
                Ok(hosts) => hosts,
                Err(failure) => {
                    // Record the discovery failure separately instead of treating
                    // it as "no hosts": explicit host/tunnel targets below are
                    // still retained so a misconfigured or logged-out discovery
                    // never silently drops a configured uplink.
                    eprintln!(
                        "climon uplink: dev tunnel discovery failed: {} ({})",
                        failure.summary, failure.technical_detail
                    );
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        let explicit_host = if config.enabled {
            config.host.clone().zip(config.port)
        } else {
            None
        };
        let explicit_tunnel_id = if config.enabled {
            config.tunnel_id.clone()
        } else {
            None
        };
        let mut desired = Vec::new();
        if let Some((host, port)) = peer_target {
            desired.push(UplinkTargetSpec::Direct { host, port });
        }
        desired.extend(crate::target_set::compute_targets(
            crate::target_set::ComputeTargetsInput {
                discover_enabled,
                own_install_id,
                explicit_host,
                explicit_tunnel_id,
                discovered,
            },
        ));

        let ce = config_env.clone();
        let se = store_env.clone();
        let cid = client_id.clone();
        let cwd_buf = cwd.to_path_buf();
        let mut spawn = |spec: &UplinkTargetSpec| {
            let cancel = CancellationToken::new();
            let task = tokio::spawn(run_target_bridge(
                spec.clone(),
                ce.clone(),
                se.clone(),
                cid.clone(),
                cwd_buf.clone(),
                cancel.clone(),
            ));
            TargetHandle::new(cancel, task)
        };
        reconcile_targets(&mut supervisor.active, &desired, &mut spawn);
        if supervisor.active.is_empty() {
            write_supervisor_status(
                &config_env,
                "disconnected",
                None,
                None,
                0,
                None,
                Some(DevtunnelHealth::healthy(
                    DevtunnelState::Stopped,
                    None,
                    climon_store::paths::now_iso(),
                )),
            );
        }
        tokio::time::sleep(Duration::from_secs(DISCOVERY_POLL_SECS)).await;
    }
}

/// Resolves a socket address for the given host:port. Helper for tests.
#[allow(dead_code)]
fn resolve_addr(host: &str, port: u16) -> Option<std::net::SocketAddr> {
    (host, port).to_socket_addrs().ok()?.next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use climon_proto::meta::SessionMeta;
    use climon_store::meta::write_session_meta;
    use tokio::net::TcpListener;

    #[test]
    fn builds_target_descriptor_for_each_kind() {
        use crate::uplink_status::UplinkTarget;
        assert_eq!(
            build_uplink_target(true, "172.30.192.1", 3132, None),
            UplinkTarget {
                kind: "peer".into(),
                host: Some("172.30.192.1".into()),
                port: Some(3132),
                tunnel_id: None,
                url: None
            }
        );
        assert_eq!(
            build_uplink_target(false, "127.0.0.1", 3132, Some("abc")),
            UplinkTarget {
                kind: "tunnel".into(),
                host: Some("127.0.0.1".into()),
                port: Some(3132),
                tunnel_id: Some("abc".into()),
                url: None
            }
        );
        assert_eq!(
            build_uplink_target(false, "10.0.0.2", 3132, None),
            UplinkTarget {
                kind: "direct".into(),
                host: Some("10.0.0.2".into()),
                port: Some(3132),
                tunnel_id: None,
                url: None
            }
        );
    }

    fn temp_home() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let base = std::env::current_dir().unwrap().join(".copilot-tmp");
        std::fs::create_dir_all(&base).unwrap();
        let dir = base.join(format!(
            "climon-uplink-{}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        dir
    }

    fn config_env_for(home: &Path) -> ConfigEnv {
        let os_home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        ConfigEnv::new(Some(home.to_str().unwrap()), &os_home)
    }

    fn store_env_for(home: &Path) -> StoreEnv {
        StoreEnv::with_home(home.to_path_buf())
    }

    fn sample_meta(home: &Path, id: &str, origin: Option<Origin>) -> SessionMeta {
        let now = climon_store::paths::now_iso();
        SessionMeta {
            id: id.to_string(),
            command: vec!["bash".into()],
            display_command: "bash".into(),
            cwd: "/x".into(),
            status: SessionStatus::Running,
            priority_reason: PriorityReason::Running,
            daemon_pid: None,
            cols: 80,
            rows: 24,
            headless: None,
            socket_path: home.join("nope.sock").to_string_lossy().into_owned(),
            client_version: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_activity_at: now,
            attention_matched_at: None,
            attention_reason: None,
            completed_at: None,
            exit_code: None,
            error: None,
            origin,
            client_label: origin.map(|_| "remote".to_string()),
            name: None,
            priority: None,
            color: None,
            theme: None,
            user_paused: None,
            terminal_title: None,
            attention_snippet: None,
            progress: None,
        }
    }

    #[test]
    fn resolve_uplink_config_disabled_without_target() {
        let home = temp_home();
        let env = config_env_for(&home);
        assert!(!resolve_uplink_config(&env, &home).enabled);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn resolve_uplink_config_direct_mode() {
        let home = temp_home();
        std::fs::write(
            home.join("config.json"),
            serde_json::json!({"remote": {"enabled": true, "host": "172.30.192.1", "port": 3132}})
                .to_string(),
        )
        .unwrap();
        let env = config_env_for(&home);
        let cfg = resolve_uplink_config(&env, &home);
        assert!(cfg.enabled);
        assert_eq!(cfg.host.as_deref(), Some("172.30.192.1"));
        assert_eq!(cfg.port, Some(3132));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn ensure_client_id_is_stable() {
        let home = temp_home();
        let env = config_env_for(&home);
        let a = ensure_client_id(&env, &home);
        let b = ensure_client_id(&env, &home);
        assert_eq!(a, b);
        assert!(a.len() <= 64 && !a.is_empty());
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn mux_idle_timeout_matches_ts() {
        assert_eq!(mux_idle_timeout_ms(0.0), 0);
        assert_eq!(mux_idle_timeout_ms(50.0), 150);
        assert_eq!(mux_idle_timeout_ms(50.2), 151);
    }

    async fn collect_control_kinds(listener: TcpListener, out: Arc<std::sync::Mutex<Vec<String>>>) {
        if let Ok((stream, _)) = listener.accept().await {
            let mut stream = stream;
            let mut decoder = MuxDecoder::new();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(messages) = decoder.push(&buf[..n]) {
                            for msg in messages {
                                if let MuxMessage::Control(c) = msg {
                                    out.lock().unwrap().push(control_kind(&c));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    fn control_kind(c: &ControlMessage) -> String {
        match c {
            ControlMessage::Hello { .. } => "hello",
            ControlMessage::SessionAdded { .. } => "session-added",
            ControlMessage::SessionUpdated { .. } => "session-updated",
            ControlMessage::SessionRemoved { .. } => "session-removed",
            ControlMessage::SessionList { .. } => "session-list",
            ControlMessage::Attach { .. } => "attach",
            ControlMessage::Detach { .. } => "detach",
            ControlMessage::Spawn { .. } => "spawn",
            ControlMessage::SpawnResult { .. } => "spawn-result",
            ControlMessage::Signed { .. } => "signed",
            ControlMessage::Ping => "ping",
            ControlMessage::Pong => "pong",
        }
        .to_string()
    }

    #[tokio::test]
    async fn bridge_sends_hello_then_advertises_local_sessions() {
        let home = temp_home();
        let store_env = store_env_for(&home);
        write_session_meta(&store_env, &sample_meta(&home, "s1", None)).unwrap();

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let received = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let server = tokio::spawn(collect_control_kinds(listener, received.clone()));

        let client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let bridge = tokio::spawn(run_uplink_bridge(
            client,
            UplinkBridgeOptions {
                store_env,
                client_id: "dev1".into(),
                keep_alive_seconds: Some(0.0),
                peer: false,
                target: None,
                connected_at: None,
                config_env: config_env_for(&home),
            },
        ));
        tokio::time::sleep(Duration::from_millis(200)).await;
        bridge.abort();
        let _ = bridge.await;
        let _ = server.await;

        let kinds = received.lock().unwrap().clone();
        assert_eq!(kinds.first().map(String::as_str), Some("hello"));
        assert!(kinds.iter().any(|k| k == "session-added"));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn sessions_signature_changes_when_a_session_appears() {
        let home = temp_home();
        let sessions_dir = home.join("sessions");
        let empty = sessions_signature(&sessions_dir);
        // Stable for an unchanged directory.
        assert_eq!(empty, sessions_signature(&sessions_dir));
        // Non-`.json` files (locks, scrollback, tmp) do not affect the signature.
        std::fs::write(sessions_dir.join("s1.json.lock"), "").unwrap();
        std::fs::write(sessions_dir.join("s1.scrollback"), "x").unwrap();
        assert_eq!(empty, sessions_signature(&sessions_dir));
        // A new metadata file changes the signature.
        std::fs::write(sessions_dir.join("s1.json"), "{}").unwrap();
        assert_ne!(empty, sessions_signature(&sessions_dir));
        std::fs::remove_dir_all(&home).ok();
    }

    #[tokio::test]
    async fn bridge_advertises_sessions_created_after_connect() {
        let home = temp_home();
        let store_env = store_env_for(&home);
        // No sessions exist at connect time.

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let received = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let server = tokio::spawn(collect_control_kinds(listener, received.clone()));

        let client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let bridge = tokio::spawn(run_uplink_bridge(
            client,
            UplinkBridgeOptions {
                store_env: store_env_for(&home),
                client_id: "dev1".into(),
                keep_alive_seconds: Some(0.0),
                peer: false,
                target: None,
                connected_at: None,
                config_env: config_env_for(&home),
            },
        ));

        // Initial reconcile has no sessions to advertise.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            !received
                .lock()
                .unwrap()
                .iter()
                .any(|k| k == "session-added"),
            "no session should be advertised before one is created"
        );

        // Create a session after the channel connected; the sessions-dir watcher
        // must re-advertise it without waiting for a reconnect.
        write_session_meta(&store_env, &sample_meta(&home, "late", None)).unwrap();
        tokio::time::sleep(Duration::from_millis(1600)).await;
        assert!(
            received
                .lock()
                .unwrap()
                .iter()
                .any(|k| k == "session-added"),
            "session created after connect should be advertised by the watcher"
        );

        bridge.abort();
        let _ = bridge.await;
        let _ = server.await;
        std::fs::remove_dir_all(&home).ok();
    }

    #[tokio::test]
    async fn bridge_does_not_advertise_remote_origin_sessions() {
        let home = temp_home();
        let store_env = store_env_for(&home);
        write_session_meta(
            &store_env,
            &sample_meta(&home, "remote~s1", Some(Origin::Remote)),
        )
        .unwrap();

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let received = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let server = tokio::spawn(collect_control_kinds(listener, received.clone()));

        let client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let bridge = tokio::spawn(run_uplink_bridge(
            client,
            UplinkBridgeOptions {
                store_env,
                client_id: "dev1".into(),
                keep_alive_seconds: Some(0.0),
                peer: false,
                target: None,
                connected_at: None,
                config_env: config_env_for(&home),
            },
        ));
        tokio::time::sleep(Duration::from_millis(200)).await;
        bridge.abort();
        let _ = bridge.await;
        let _ = server.await;

        let kinds = received.lock().unwrap().clone();
        assert_eq!(kinds, vec!["hello".to_string(), "session-list".to_string()]);
        std::fs::remove_dir_all(&home).ok();
    }

    #[tokio::test]
    async fn bridge_closes_idle_channel_when_keepalive_unanswered() {
        let home = temp_home();
        let store_env = store_env_for(&home);

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // Server accepts but never writes mux frames back.
        let server = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                // Hold the connection until the client tears down.
                let mut stream = stream;
                let mut buf = [0u8; 1024];
                loop {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
            }
        });

        let client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        // keepAlive 0.05s -> idle timeout 150ms; bridge should self-destruct.
        let started = std::time::Instant::now();
        run_uplink_bridge(
            client,
            UplinkBridgeOptions {
                store_env,
                client_id: "dev1".into(),
                keep_alive_seconds: Some(0.05),
                peer: false,
                target: None,
                connected_at: None,
                config_env: config_env_for(&home),
            },
        )
        .await;
        assert!(started.elapsed() < Duration::from_secs(5));
        let _ = server.await;
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn parse_tunnel_port_handles_json_and_line_fallback() {
        assert_eq!(
            parse_tunnel_port(r#"{"ports":[{"portNumber":3132}]}"#),
            Some(3132)
        );
        assert_eq!(parse_tunnel_port(r#"[{"port":8080}]"#), Some(8080));
        assert_eq!(parse_tunnel_port("forwarding 4200 ->"), Some(4200));
        assert_eq!(parse_tunnel_port("no digits here"), None);
    }

    #[test]
    fn plan_reconnect_pauses_actionable_and_backs_off_transient() {
        use crate::devtunnel::classify_failure;
        use crate::devtunnel::{DevtunnelFailureInput, DevtunnelOperation};

        let mut controller = RetryController::new();
        let not_auth = classify_failure(
            &DevtunnelFailureInput {
                operation: DevtunnelOperation::ConnectTunnel,
                status: 1,
                stdout: String::new(),
                stderr: "not logged in".to_string(),
                spawn_error: None,
                parse_failed: None,
            },
            "2026-07-11T13:00:00.000Z",
        );
        assert_eq!(not_auth.code, DevtunnelErrorCode::NotAuthenticated);
        match plan_reconnect(&mut controller, &not_auth) {
            ReconnectAction::Pause { .. } => {}
            other => panic!("expected pause for actionable failure, got {other:?}"),
        }

        let mut controller = RetryController::new();
        let network = classify_failure(
            &DevtunnelFailureInput {
                operation: DevtunnelOperation::ConnectTunnel,
                status: 1,
                stdout: String::new(),
                stderr: "connection refused".to_string(),
                spawn_error: None,
                parse_failed: None,
            },
            "2026-07-11T13:00:00.000Z",
        );
        assert_eq!(network.code, DevtunnelErrorCode::NetworkUnavailable);
        match plan_reconnect(&mut controller, &network) {
            ReconnectAction::Backoff { delay_ms, .. } => assert_eq!(delay_ms, 1000),
            other => panic!("expected backoff for transient failure, got {other:?}"),
        }
        // Second transient failure escalates the capped-exponential delay.
        match plan_reconnect(&mut controller, &network) {
            ReconnectAction::Backoff { delay_ms, .. } => assert_eq!(delay_ms, 2000),
            other => panic!("expected escalated backoff, got {other:?}"),
        }
    }

    #[test]
    fn direct_reconnect_failure_is_transient() {
        let failure = direct_reconnect_failure();
        assert_eq!(failure.retry_class, DevtunnelRetryClass::Transient);
        assert!(failure.retryable);
    }
}

#[cfg(test)]
mod spawn_dispatch_tests {
    use super::*;
    use crate::mux::ControlMessage;
    use crate::spawn_auth::{sign_control, RejectReason};

    fn spawn_msg() -> ControlMessage {
        ControlMessage::Spawn {
            request_id: "r1".into(),
            command: vec!["bash".into()],
            cwd: "/w".into(),
            cols: 80,
            rows: 24,
            name: Some("build".into()),
            priority: Some(700),
            color: Some("red".into()),
            headless: true,
        }
    }

    #[cfg(test)]
    mod fanout_tests {
        use super::*;
        use crate::target_set::UplinkTargetSpec;
        use std::collections::HashMap;

        #[test]
        fn target_key_is_stable_and_distinct() {
            assert_eq!(
                target_key(&UplinkTargetSpec::Tunnel {
                    tunnel_id: "t1".into()
                }),
                "tunnel:t1"
            );
            assert_eq!(
                target_key(&UplinkTargetSpec::Direct {
                    host: "h".into(),
                    port: 9
                }),
                "direct:h:9"
            );
        }

        #[test]
        fn reconcile_adds_new_and_removes_stale() {
            let spawned = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
            let cancelled = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));

            let mut active: HashMap<String, TargetHandle> = HashMap::new();

            let s2 = spawned.clone();
            let c2 = cancelled.clone();
            let mut spawn = move |spec: &UplinkTargetSpec| {
                s2.borrow_mut().push(target_key(spec));
                TargetHandle::fake(target_key(spec), c2.clone())
            };

            let a = UplinkTargetSpec::Tunnel {
                tunnel_id: "A".into(),
            };
            let b = UplinkTargetSpec::Tunnel {
                tunnel_id: "B".into(),
            };
            reconcile_targets(&mut active, &[a.clone(), b.clone()], &mut spawn);
            assert_eq!(*spawned.borrow(), vec!["tunnel:A", "tunnel:B"]);
            assert_eq!(active.len(), 2);

            let c = UplinkTargetSpec::Tunnel {
                tunnel_id: "C".into(),
            };
            reconcile_targets(&mut active, &[b.clone(), c.clone()], &mut spawn);
            assert!(cancelled.borrow().contains(&"tunnel:A".to_string()));
            assert!(spawned.borrow().contains(&"tunnel:C".to_string()));
            assert!(active.contains_key("tunnel:B"));
            assert!(active.contains_key("tunnel:C"));
            assert!(!active.contains_key("tunnel:A"));
        }
    }

    #[test]
    fn unsigned_control_rejected_when_secret_present() {
        let mut guard = ReplayGuard::new(30_000);
        let got = unwrap_inbound(Some("sekret"), &mut guard, ControlMessage::Ping, 0);
        assert_eq!(got, Err(InboundError::Rejected(RejectReason::NotSigned)));
    }

    #[test]
    fn signed_control_unwrapped_when_secret_present() {
        let mut guard = ReplayGuard::new(30_000);
        let env = sign_control("sekret", &ControlMessage::Ping, "n1", 1000);
        let got = unwrap_inbound(Some("sekret"), &mut guard, env, 1000);
        assert_eq!(got, Ok(ControlMessage::Ping));
    }

    #[test]
    fn plain_control_passes_through_when_no_secret() {
        let mut guard = ReplayGuard::new(30_000);
        let got = unwrap_inbound(None, &mut guard, ControlMessage::Ping, 0);
        assert_eq!(got, Ok(ControlMessage::Ping));
    }

    #[test]
    fn spawn_argv_includes_flags_cwd_and_command() {
        let argv = build_spawn_argv(&spawn_msg());
        assert!(argv.contains(&"__spawn".to_string()));
        assert!(argv.contains(&"--headless".to_string()));
        assert!(argv.windows(2).any(|w| w[0] == "--cwd" && w[1] == "/w"));
        assert!(argv.windows(2).any(|w| w[0] == "--cols" && w[1] == "80"));
        assert!(argv.windows(2).any(|w| w[0] == "--name" && w[1] == "build"));
        assert!(argv
            .windows(2)
            .any(|w| w[0] == "--priority" && w[1] == "700"));
        assert!(argv.windows(2).any(|w| w[0] == "--color" && w[1] == "red"));
        assert_eq!(argv.last().unwrap(), "bash");
    }
}
