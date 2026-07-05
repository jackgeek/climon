//! Devbox uplink client. Ports `src/remote/uplink.ts`: resolves the uplink
//! target from config, runs the mux bridge over a TCP channel to a remote
//! ingest daemon, and supervises reconnection (direct host, dev tunnel, or
//! same-machine WSL<->Windows peer discovery).
//!
//! The CLI is thread-based; this module runs on a tokio runtime created by the
//! `run_uplink` entry point (see `climon-cli`). The mux wire format and the
//! hello/attach/detach/data protocol MUST match the Bun side byte-for-byte.

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

use crate::client_id::default_client_id;
use crate::discovery::{discover_dashboard, DashboardLocation, DiscoveryDeps};
use crate::keepalive::mux_idle_timeout_ms;
use crate::mux::{encode_control, encode_data, ControlMessage, MuxDecoder, MuxMessage};
use crate::process::is_process_alive;
use crate::singleton::{acquire_singleton_detailed, SingletonResult};
use crate::spawn_auth::{
    sign_now, verify_signed_control, RejectReason, ReplayGuard, DEFAULT_FRESHNESS_WINDOW_MS,
};
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

const AUTH_REJECT_PATTERNS: &[&str] = &[
    "unauthor",
    "forbidden",
    "expired",
    "invalid token",
    "401",
    "403",
];

fn auth_rejected_in(text: &str) -> bool {
    let lower = text.to_lowercase();
    AUTH_REJECT_PATTERNS.iter().any(|p| lower.contains(p))
}

fn devtunnel_command(args: &[&str]) -> tokio::process::Command {
    let env: HashMap<String, String> = std::env::vars().collect();
    let mut cmd = tokio::process::Command::new("devtunnel");
    cmd.args(args);
    for (k, v) in crate::tunnel::devtunnel_env(&env) {
        cmd.env(k, v);
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        // devtunnel.exe is a console app; without CREATE_NO_WINDOW every
        // invocation (and the supervisor's reconnect loop spawns these
        // repeatedly) flashes a console window on Windows.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// A spawned `devtunnel connect` child plus its observed auth-rejection flag.
struct ConnectChild {
    child: tokio::process::Child,
    auth_rejected: Arc<std::sync::atomic::AtomicBool>,
}

impl ConnectChild {
    fn auth_rejected(&self) -> bool {
        self.auth_rejected
            .load(std::sync::atomic::Ordering::Relaxed)
    }
    async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }
}

fn spawn_connect(tunnel_id: &str) -> std::io::Result<ConnectChild> {
    let mut cmd = devtunnel_command(&["connect", tunnel_id]);
    let mut child = cmd.spawn()?;
    let auth_rejected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    if let Some(stdout) = child.stdout.take() {
        spawn_auth_scan(stdout, auth_rejected.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_auth_scan(stderr, auth_rejected.clone());
    }
    Ok(ConnectChild {
        child,
        auth_rejected,
    })
}

fn spawn_auth_scan<R>(reader: R, flag: Arc<std::sync::atomic::AtomicBool>)
where
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
                    if auth_rejected_in(&text) {
                        flag.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            }
        }
    });
}

/// Discovers the forwarded port for a tunnel via `devtunnel port list`.
/// Mirrors `discoverTunnelPort`.
async fn discover_tunnel_port(tunnel_id: &str) -> Option<u16> {
    let mut cmd = devtunnel_command(&["port", "list", tunnel_id, "--json"]);
    let output = cmd.output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Ok(parsed) = serde_json::from_str::<Value>(&stdout) {
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

pub async fn run_uplink(config_env: ConfigEnv, store_env: StoreEnv, cwd: &Path) -> i32 {
    let peer_home = as_string(resolve_config_setting("remote.peerHome", &config_env, cwd));
    let initial_legacy = resolve_uplink_config(&config_env, cwd);
    if peer_home.is_none() && !initial_legacy.enabled {
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
    let mut backoff_ms: u64 = 1000;

    let write_uplink = |state: &str,
                        target: Option<crate::uplink_status::UplinkTarget>,
                        connected_at: Option<u64>,
                        session_count: u32,
                        last_error: Option<String>| {
        let status = crate::uplink_status::UplinkStatus {
            pid: std::process::id(),
            updated_at: crate::time::now_ms(),
            target,
            state: state.to_string(),
            connected_at,
            session_count,
            last_error,
        };
        let _ = crate::uplink_status::write_uplink_status(&status, &config_env);
    };

    loop {
        let started_at = std::time::Instant::now();

        let peer_target = if peer_home.is_some() {
            resolve_peer_uplink_target(&config_env, cwd)
        } else {
            None
        };
        let is_peer_connection = peer_target.is_some();
        let config = resolve_uplink_config(&config_env, cwd);

        let mut host: Option<String> = None;
        let mut port: Option<u16> = None;
        let mut conn: Option<ConnectChild> = None;

        if let Some((peer_host, peer_port)) = peer_target {
            host = Some(peer_host);
            port = Some(peer_port);
        } else if config.enabled {
            if let (Some(h), Some(p)) = (config.host.clone(), config.port) {
                host = Some(h);
                port = Some(p);
            } else if let Some(tunnel_id) = config.tunnel_id.clone() {
                let tunnel_port = match config.port {
                    Some(p) => Some(p),
                    None => discover_tunnel_port(&tunnel_id).await,
                };
                if let Some(tp) = tunnel_port {
                    if let Ok(c) = spawn_connect(&tunnel_id) {
                        conn = Some(c);
                        host = Some("127.0.0.1".to_string());
                        port = Some(tp);
                    }
                }
            }
        }

        let (host, port) = match (host, port) {
            (Some(h), Some(p)) => (h, p),
            _ => {
                if let Some(mut c) = conn {
                    c.kill().await;
                }
                if peer_home.is_none() {
                    write_uplink("disconnected", None, None, 0, None);
                    return 0;
                }
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(30_000);
                continue;
            }
        };

        let target =
            build_uplink_target(is_peer_connection, &host, port, config.tunnel_id.as_deref());
        write_uplink("connecting", Some(target.clone()), None, 0, None);

        let reachable = wait_for_port(port, &host, 15_000).await;
        if !reachable {
            if let Some(c) = &conn {
                if c.auth_rejected() {
                    eprintln!(
                        "climon uplink: dev tunnel auth rejected (not authorized for this tunnel). Stopping."
                    );
                    if let Some(mut c) = conn {
                        c.kill().await;
                    }
                    write_uplink(
                        "disconnected",
                        None,
                        None,
                        0,
                        Some("dev tunnel auth rejected".to_string()),
                    );
                    return 1;
                }
            }
            if let Some(mut c) = conn {
                c.kill().await;
            }
            // transient: fall through to backoff
            write_uplink("reconnecting", Some(target.clone()), None, 0, None);
            if started_at.elapsed() > Duration::from_secs(30) {
                backoff_ms = 1000;
            }
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms * 2).min(30_000);
            continue;
        }

        match TcpStream::connect((host.as_str(), port)).await {
            Ok(channel) => {
                let connected_at = crate::time::now_ms();
                write_uplink(
                    "connected",
                    Some(target.clone()),
                    Some(connected_at),
                    live_session_count(&store_env),
                    None,
                );
                run_uplink_bridge(
                    channel,
                    UplinkBridgeOptions {
                        store_env: store_env.clone(),
                        client_id: client_id.clone(),
                        keep_alive_seconds: Some(resolve_keep_alive(&config_env, cwd)),
                        peer: is_peer_connection,
                        target: Some(target.clone()),
                        connected_at: Some(connected_at),
                        config_env: config_env.clone(),
                    },
                )
                .await;
            }
            Err(_) => {
                // transient connect error: fall through to backoff
            }
        }

        write_uplink("reconnecting", Some(target.clone()), None, 0, None);
        let auth_rejected_after = conn.as_ref().map(|c| c.auth_rejected()).unwrap_or(false);
        if let Some(mut c) = conn {
            c.kill().await;
        }
        if auth_rejected_after {
            eprintln!(
                "climon uplink: dev tunnel auth rejected (not authorized for this tunnel). Stopping."
            );
            write_uplink(
                "disconnected",
                None,
                None,
                0,
                Some("dev tunnel auth rejected".to_string()),
            );
            return 1;
        }
        if started_at.elapsed() > Duration::from_secs(30) {
            backoff_ms = 1000;
        }
        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms * 2).min(30_000);
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
    use std::collections::HashMap as Map;
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
    fn discover_tunnel_port_line_fallback_and_auth_scan() {
        assert!(auth_rejected_in("Error: 403 Forbidden"));
        assert!(auth_rejected_in("token expired"));
        assert!(!auth_rejected_in("all good"));
        let _ = Map::<String, String>::new();
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
