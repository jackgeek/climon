//! Remote ingest: accepts uplink mux connections and demultiplexes remote
//! sessions into namespaced local metadata, bridging session data to/from local
//! daemon session sockets. Port of `src/remote/ingest.ts`.
//!
//! All remote input is UNTRUSTED (see `docs/security.md`): the advertised meta
//! is parsed leniently from JSON, every server-controlled field is set locally,
//! remote ids are validated against path traversal, and patches are allow-listed.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use climon_config::config::{resolve_config_setting, Env as ConfigEnv};
use climon_proto::meta::{
    AnsiColor, Origin, PriorityReason, SessionMeta, SessionMetaPatch, SessionStatus,
};
use climon_session::socket::format_session_socket_ref;
use climon_store::meta::{
    list_sessions, read_session_meta, remove_session_meta, write_session_meta,
};
use climon_store::patch::patch_session_meta;
use climon_store::paths::{now_iso, Env as StoreEnv};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify};

use crate::ingest_state::IngestState;
use crate::keepalive::mux_idle_timeout_ms;
use crate::mux::{encode_control, encode_data, ControlMessage, MuxDecoder, RawFrame};

const MAX_STR: usize = 4096;
const DEFAULT_MAX_SESSIONS: usize = 256;
const DEFAULT_KEEPALIVE_SECONDS: f64 = 60.0;
const INGEST_PORT_RETRY_ATTEMPTS: u32 = 100;

/// Loopback control-socket spawn timeout (ms). Mirrors the Bun control server.
pub const DEFAULT_SPAWN_TIMEOUT_MS: u64 = 10_000;

/// A spawn request received on the loopback control socket. Mirrors the Bun
/// `SpawnControlRequest` (the dashboard server's `requestRemoteSpawn` sends this
/// JSON verbatim).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnControlRequest {
    pub request_id: String,
    pub client_id: String,
    pub command: Vec<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub headless: bool,
}

/// The response written back on the loopback control socket. Mirrors the Bun
/// `SpawnControlResponse`. `type` is always `"spawn-result"`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnControlResponse {
    #[serde(rename = "type")]
    pub kind: SpawnResultTag,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum SpawnResultTag {
    #[serde(rename = "spawn-result")]
    SpawnResult,
}

impl SpawnControlResponse {
    fn error(request_id: &str, message: &str) -> Self {
        Self {
            kind: SpawnResultTag::SpawnResult,
            request_id: request_id.to_string(),
            id: None,
            warning: None,
            error: Some(message.to_string()),
        }
    }
}

/// Validates a remote session/client id against the strict allow-list
/// `^[A-Za-z0-9._-]{1,64}$`. Mirrors `isValidRemoteId`.
pub fn is_valid_remote_id(id: &str) -> bool {
    let len = id.len();
    if !(1..=64).contains(&len) {
        return false;
    }
    id.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

/// Builds a namespaced local id `label~remoteId`. Mirrors `namespacedId`.
pub fn namespaced_id(label: &str, remote_id: &str) -> String {
    format!("{label}~{remote_id}")
}

/// Returns the `<clientId>~<remoteId>` local id if `filename` is a namespaced
/// remote-session meta file, else `None`. Mirrors the Bun `NAMESPACED_RE`.
fn match_namespaced_session_file(filename: &str) -> Option<String> {
    let stem = filename.strip_suffix(".json")?;
    let (left, right) = stem.split_once('~')?;
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    if ok(left) && ok(right) {
        Some(stem.to_string())
    } else {
        None
    }
}

/// Scans `dir` for namespaced remote-session meta files, returning their local
/// ids. Missing/unreadable dirs yield an empty set.
fn scan_namespaced_session_files(dir: &std::path::Path) -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if let Some(local_id) = match_namespaced_session_file(name) {
                    set.insert(local_id);
                }
            }
        }
    }
    set
}

fn bounded_string(value: &Value, fallback: &str) -> String {
    match value.as_str() {
        None => fallback.to_string(),
        Some(s) => bound_str(s),
    }
}

fn bound_str(s: &str) -> String {
    if s.chars().count() > MAX_STR {
        s.chars().take(MAX_STR).collect()
    } else {
        s.to_string()
    }
}

fn parse_status(value: &Value) -> Option<SessionStatus> {
    value
        .as_str()
        .and_then(|s| serde_json::from_value(Value::String(s.to_string())).ok())
}

fn parse_priority_reason(value: &Value) -> Option<PriorityReason> {
    value
        .as_str()
        .and_then(|s| serde_json::from_value(Value::String(s.to_string())).ok())
}

fn parse_color(value: &Value) -> Option<AnsiColor> {
    // Exact lowercase match, mirroring the TS `ANSI_COLORS` Set membership test.
    value
        .as_str()
        .and_then(|s| AnsiColor::ALL.into_iter().find(|c| c.name() == s))
}

fn as_integer(value: &Value) -> Option<i64> {
    let n = value.as_f64()?;
    if n.is_finite() && n.fract() == 0.0 {
        Some(n as i64)
    } else {
        None
    }
}

/// Builds an allow-listed patch from an untrusted advertised patch. Mirrors
/// `sanitizeRemotePatch`: every field is type-checked and string fields bounded;
/// server-controlled fields (socketPath, origin, clientLabel, ...) are dropped.
pub fn sanitize_remote_patch(input: &Value) -> SessionMetaPatch {
    let mut clean = SessionMetaPatch::default();
    let obj = match input.as_object() {
        Some(obj) => obj,
        None => return clean,
    };
    if let Some(status) = obj.get("status").and_then(parse_status) {
        clean.status = Some(status);
    }
    if let Some(reason) = obj.get("priorityReason").and_then(parse_priority_reason) {
        clean.priority_reason = Some(reason);
    }
    if let Some(v) = obj.get("lastActivityAt").filter(|v| v.is_string()) {
        clean.last_activity_at = Some(bounded_string(v, ""));
    }
    if let Some(v) = obj.get("attentionMatchedAt").filter(|v| v.is_string()) {
        clean.attention_matched_at = Some(Some(bounded_string(v, "")));
    }
    if let Some(v) = obj.get("attentionReason").filter(|v| v.is_string()) {
        clean.attention_reason = Some(Some(bounded_string(v, "")));
    }
    if let Some(v) = obj.get("completedAt").filter(|v| v.is_string()) {
        clean.completed_at = Some(bounded_string(v, ""));
    }
    if let Some(v) = obj.get("exitCode").and_then(|v| v.as_i64()) {
        clean.exit_code = Some(v as i32);
    }
    if let Some(v) = obj.get("error").filter(|v| v.is_string()) {
        clean.error = Some(bounded_string(v, ""));
    }
    if let Some(v) = obj.get("cols").and_then(as_integer) {
        clean.cols = Some(v as u16);
    }
    if let Some(v) = obj.get("rows").and_then(as_integer) {
        clean.rows = Some(v as u16);
    }
    if let Some(v) = obj.get("name").filter(|v| v.is_string()) {
        clean.name = Some(bounded_string(v, ""));
    }
    if let Some(v) = obj.get("priority").and_then(|v| v.as_f64()) {
        clean.priority = Some(v as u16);
    }
    if let Some(color) = obj.get("color") {
        if color.is_null() {
            clean.color = Some(None);
        } else if let Some(c) = parse_color(color) {
            clean.color = Some(Some(c));
        }
    }
    clean
}

/// Builds a trusted local [`SessionMeta`] from an untrusted advertised meta.
/// Every server-controlled field is set locally and never taken from the wire.
/// Mirrors `toLocalMeta`.
pub fn to_local_meta(
    remote: &Value,
    label: &str,
    local_id: &str,
    socket_path: &str,
) -> SessionMeta {
    let now = now_iso();
    let get = |key: &str| remote.get(key).cloned().unwrap_or(Value::Null);

    let command = match get("command") {
        Value::Array(items) => items.iter().map(|c| bounded_string(c, "")).collect(),
        _ => Vec::new(),
    };
    let created_at = {
        let s = bounded_string(&get("createdAt"), "");
        if s.is_empty() {
            now.clone()
        } else {
            s
        }
    };
    let last_activity_at = {
        let s = bounded_string(&get("lastActivityAt"), "");
        if s.is_empty() {
            now.clone()
        } else {
            s
        }
    };
    let color = match get("color") {
        Value::Null if remote.get("color").is_some() => Some(None),
        other => parse_color(&other).map(Some),
    };
    let client_version = {
        let v = get("clientVersion");
        if v.as_str().map(|s| !s.is_empty()).unwrap_or(false) {
            Some(bounded_string(&v, ""))
        } else {
            None
        }
    };
    let name = {
        let v = get("name");
        if v.as_str().map(|s| !s.is_empty()).unwrap_or(false) {
            Some(bounded_string(&v, ""))
        } else {
            None
        }
    };
    let theme = {
        let v = get("theme");
        if v.as_str().map(|s| !s.is_empty()).unwrap_or(false) {
            Some(bounded_string(&v, ""))
        } else {
            None
        }
    };

    SessionMeta {
        id: local_id.to_string(),
        command,
        display_command: bounded_string(&get("displayCommand"), ""),
        cwd: bounded_string(&get("cwd"), ""),
        status: parse_status(&get("status")).unwrap_or(SessionStatus::Running),
        priority_reason: parse_priority_reason(&get("priorityReason"))
            .unwrap_or(PriorityReason::Running),
        daemon_pid: None,
        cols: as_integer(&get("cols")).map(|n| n as u16).unwrap_or(80),
        rows: as_integer(&get("rows")).map(|n| n as u16).unwrap_or(24),
        headless: get("headless").as_bool(),
        socket_path: socket_path.to_string(),
        client_version,
        created_at,
        updated_at: now,
        last_activity_at,
        attention_matched_at: None,
        attention_reason: None,
        completed_at: get("completedAt")
            .as_str()
            .map(|_| bounded_string(&get("completedAt"), "")),
        exit_code: get("exitCode").as_i64().map(|n| n as i32),
        error: None,
        origin: Some(Origin::Remote),
        client_label: Some(label.to_string()),
        name,
        priority: get("priority").as_f64().map(|n| n as u16),
        color,
        theme,
        user_paused: None,
    }
}

/// Tracks active connections per clientId and dismissed sessions across the
/// ingest daemon lifetime. Mirrors `IngestConnectionRegistry`.
#[derive(Default)]
pub struct IngestConnectionRegistry {
    active: Mutex<HashMap<String, ActiveConn>>,
    dismissed: Mutex<HashSet<String>>,
    pending_spawns:
        Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<crate::mux::ControlMessage>>>>,
}

struct ActiveConn {
    shutdown: Arc<Notify>,
    teardown_done: Arc<Notify>,
    send_tx: mpsc::UnboundedSender<Vec<u8>>,
}

impl IngestConnectionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns true if the session was explicitly removed and must not be
    /// re-materialized.
    pub fn is_dismissed(&self, local_id: &str) -> bool {
        self.dismissed.lock().unwrap().contains(local_id)
    }

    /// Marks a session as dismissed.
    pub fn dismiss(&self, local_id: &str) {
        self.dismissed.lock().unwrap().insert(local_id.to_string());
    }

    /// Clears the dismissed flag.
    pub fn undismiss(&self, local_id: &str) {
        self.dismissed.lock().unwrap().remove(local_id);
    }

    /// Registers a connection for `client_id`, evicting and awaiting the
    /// teardown of any previous one. Mirrors `evictAndRegister`.
    pub async fn evict_and_register(
        &self,
        client_id: &str,
        shutdown: Arc<Notify>,
        teardown_done: Arc<Notify>,
        send_tx: mpsc::UnboundedSender<Vec<u8>>,
    ) {
        let existing = self.active.lock().unwrap().remove(client_id);
        if let Some(existing) = existing {
            existing.shutdown.notify_one();
            existing.teardown_done.notified().await;
        }
        self.active.lock().unwrap().insert(
            client_id.to_string(),
            ActiveConn {
                shutdown,
                teardown_done,
                send_tx,
            },
        );
    }

    /// Returns the live send channel for `client_id`, if any. Mirrors `getChannel`.
    pub fn get_channel(&self, client_id: &str) -> Option<mpsc::UnboundedSender<Vec<u8>>> {
        self.active
            .lock()
            .unwrap()
            .get(client_id)
            .map(|c| c.send_tx.clone())
    }

    /// Registers an in-flight spawn; resolves on `resolve_pending_spawn` with the
    /// same request id, or after `timeout_ms` with a `timeout` SpawnResult.
    /// Mirrors `registerPendingSpawn`.
    pub fn register_pending_spawn(
        &self,
        request_id: &str,
        timeout_ms: u64,
    ) -> impl std::future::Future<Output = crate::mux::ControlMessage> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending_spawns
            .lock()
            .unwrap()
            .insert(request_id.to_string(), tx);
        let request_id = request_id.to_string();
        let pending_spawns = self.pending_spawns.clone();
        async move {
            match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
                Ok(Ok(msg)) => msg,
                _ => {
                    pending_spawns.lock().unwrap().remove(&request_id);
                    crate::mux::ControlMessage::SpawnResult {
                        request_id,
                        id: None,
                        warning: None,
                        error: Some("timeout".to_string()),
                    }
                }
            }
        }
    }

    /// Resolves the in-flight spawn for `request_id`, if any. Mirrors
    /// `resolvePendingSpawn`.
    pub fn resolve_pending_spawn(&self, request_id: &str, result: crate::mux::ControlMessage) {
        if let Some(tx) = self.pending_spawns.lock().unwrap().remove(request_id) {
            let _ = tx.send(result);
        }
    }

    /// Cancels an in-flight spawn without delivering a result.
    pub fn cancel_pending_spawn(&self, request_id: &str) {
        self.pending_spawns.lock().unwrap().remove(request_id);
    }

    /// Signals that the connection for `client_id` has fully torn down. Mirrors
    /// `markTornDown` (matched by `shutdown` pointer identity).
    pub fn mark_torn_down(&self, client_id: &str, shutdown: &Arc<Notify>) {
        let mut active = self.active.lock().unwrap();
        if let Some(entry) = active.get(client_id) {
            if Arc::ptr_eq(&entry.shutdown, shutdown) {
                entry.teardown_done.notify_one();
                active.remove(client_id);
            }
        }
    }
}

/// Signs and forwards a `Spawn` to the target devbox channel, awaiting the
/// correlated `SpawnResult`. Mirrors `handleSpawnControlRequest`.
pub async fn handle_spawn_control_request(
    req: SpawnControlRequest,
    registry: &IngestConnectionRegistry,
    spawn_secret: Option<String>,
    timeout_ms: u64,
) -> SpawnControlResponse {
    let Some(secret) = spawn_secret else {
        return SpawnControlResponse::error(&req.request_id, "remote spawn not configured");
    };
    let Some(channel) = registry.get_channel(&req.client_id) else {
        return SpawnControlResponse::error(&req.request_id, "client not connected");
    };
    let pending = registry.register_pending_spawn(&req.request_id, timeout_ms);
    let spawn = crate::mux::ControlMessage::Spawn {
        request_id: req.request_id.clone(),
        command: req.command,
        cwd: req.cwd,
        cols: req.cols,
        rows: req.rows,
        name: req.name,
        priority: req.priority,
        color: req.color,
        headless: req.headless,
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let signed = crate::spawn_auth::sign_now(&secret, &spawn, now_ms);
    if channel.send(crate::mux::encode_control(&signed)).is_err() {
        registry.cancel_pending_spawn(&req.request_id);
        return SpawnControlResponse::error(&req.request_id, "client not connected");
    }
    match pending.await {
        crate::mux::ControlMessage::SpawnResult {
            request_id,
            id,
            warning,
            error,
        } => SpawnControlResponse {
            kind: SpawnResultTag::SpawnResult,
            request_id,
            id,
            warning,
            error,
        },
        _ => SpawnControlResponse::error(&req.request_id, "internal error"),
    }
}

/// Serves one loopback control-socket connection: newline-delimited JSON
/// `SpawnControlRequest` in, `SpawnControlResponse` out. Mirrors the Bun
/// `controlServer` connection handler.
async fn serve_control_connection(
    socket: TcpStream,
    registry: Arc<IngestConnectionRegistry>,
    spawn_secret: Option<String>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (mut rd, mut wr) = socket.into_split();
    let mut buf = vec![0u8; 8 * 1024];
    let mut acc: Vec<u8> = Vec::new();
    loop {
        let n = match rd.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        acc.extend_from_slice(&buf[..n]);
        while let Some(pos) = acc.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = acc.drain(..=pos).collect();
            let line = &line[..line.len() - 1];
            if line.iter().all(|b| b.is_ascii_whitespace()) {
                continue;
            }
            let response = match serde_json::from_slice::<SpawnControlRequest>(line) {
                Ok(req) => {
                    handle_spawn_control_request(
                        req,
                        &registry,
                        spawn_secret.clone(),
                        DEFAULT_SPAWN_TIMEOUT_MS,
                    )
                    .await
                }
                Err(_) => SpawnControlResponse::error("", "bad request"),
            };
            let mut out = serde_json::to_vec(&response).unwrap_or_default();
            out.push(b'\n');
            if wr.write_all(&out).await.is_err() {
                return;
            }
        }
    }
}

/// Options for [`run_ingest_connection`]. Mirrors `IngestConnOptions`.
pub struct IngestConnOptions {
    pub store_env: StoreEnv,
    pub max_sessions: usize,
    pub keep_alive_seconds: f64,
    pub registry: Option<Arc<IngestConnectionRegistry>>,
    pub spawn_secret: Option<String>,
}

impl IngestConnOptions {
    pub fn new(store_env: StoreEnv) -> Self {
        Self {
            store_env,
            max_sessions: DEFAULT_MAX_SESSIONS,
            keep_alive_seconds: DEFAULT_KEEPALIVE_SECONDS,
            registry: None,
            spawn_secret: None,
        }
    }
}

type LocalSockets = Arc<tokio::sync::Mutex<HashMap<u64, mpsc::UnboundedSender<Vec<u8>>>>>;

struct RemoteSession {
    local_id: String,
    sockets: LocalSockets,
    accept_handle: tokio::task::JoinHandle<()>,
}

/// Handles a single inbound mux connection (raw TCP from a devbox via the dev
/// tunnel). Mirrors `runIngestConnection`. Returns when the channel closes.
pub async fn run_ingest_connection(channel: TcpStream, options: IngestConnOptions) {
    let store_env = Arc::new(options.store_env);
    let max_sessions = options.max_sessions;
    let registry = options.registry.clone();
    let spawn_secret = options.spawn_secret;
    let mut replay_guard =
        crate::spawn_auth::ReplayGuard::new(crate::spawn_auth::DEFAULT_FRESHNESS_WINDOW_MS);

    let (mut read_half, write_half) = channel.into_split();

    // Writer task: serialize all outbound frames.
    let (send_tx, mut send_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let writer = tokio::spawn(async move {
        let mut write_half = write_half;
        while let Some(buf) = send_rx.recv().await {
            if write_half.write_all(&buf).await.is_err() {
                break;
            }
        }
    });
    let send = move |send_tx: &mpsc::UnboundedSender<Vec<u8>>, buf: Vec<u8>| {
        let _ = send_tx.send(buf);
    };

    let mut sessions: HashMap<String, RemoteSession> = HashMap::new();
    let mut decoder = MuxDecoder::new();
    let mut label: Option<String> = None;

    let shutdown = Arc::new(Notify::new());
    let teardown_done = Arc::new(Notify::new());

    // Keepalive + idle teardown.
    let keep_alive_ms = (options.keep_alive_seconds.max(0.0) * 1000.0) as u64;
    let idle_timeout_ms = mux_idle_timeout_ms(keep_alive_ms as f64);
    let last_activity = Arc::new(Mutex::new(std::time::Instant::now()));
    let mut keepalive_task: Option<tokio::task::JoinHandle<()>> = None;
    let mut idle_task: Option<tokio::task::JoinHandle<()>> = None;
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
        if idle_timeout_ms > 0 {
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
    }

    let mut buf = vec![0u8; 64 * 1024];
    loop {
        tokio::select! {
            _ = shutdown.notified() => break,
            read = read_half.read(&mut buf) => {
                let n = match read {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                *last_activity.lock().unwrap() = std::time::Instant::now();
                let frames = match decoder.push_frames(&buf[..n]) {
                    Ok(frames) => frames,
                    Err(_) => break, // oversized/torn frame: tear the connection down.
                };
                for frame in frames {
                    match frame {
                        RawFrame::Control(payload) => {
                            let value: Value = match serde_json::from_slice(&payload) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                            handle_control(
                                &value,
                                &mut label,
                                &mut sessions,
                                &store_env,
                                max_sessions,
                                &send_tx,
                                &registry,
                                &shutdown,
                                &teardown_done,
                                spawn_secret.as_deref(),
                                Some(&mut replay_guard),
                            )
                            .await;
                        }
                        RawFrame::Data { session_id, data } => {
                            if let Some(session) = sessions.get(&session_id) {
                                let map = session.sockets.lock().await;
                                for tx in map.values() {
                                    let _ = tx.send(data.clone());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Teardown.
    if let Some(t) = keepalive_task.take() {
        t.abort();
    }
    if let Some(t) = idle_task.take() {
        t.abort();
    }
    let remote_ids: Vec<String> = sessions.keys().cloned().collect();
    for remote_id in remote_ids {
        remove_session(&mut sessions, &remote_id, &store_env).await;
    }
    if let (Some(label), Some(registry)) = (&label, &registry) {
        registry.mark_torn_down(label, &shutdown);
    }
    drop(send_tx);
    let _ = send;
    let _ = writer.await;
}

#[allow(clippy::too_many_arguments)]
async fn handle_control(
    value: &Value,
    label: &mut Option<String>,
    sessions: &mut HashMap<String, RemoteSession>,
    store_env: &Arc<StoreEnv>,
    max_sessions: usize,
    send_tx: &mpsc::UnboundedSender<Vec<u8>>,
    registry: &Option<Arc<IngestConnectionRegistry>>,
    shutdown: &Arc<Notify>,
    teardown_done: &Arc<Notify>,
    spawn_secret: Option<&str>,
    replay_guard: Option<&mut crate::spawn_auth::ReplayGuard>,
) {
    let kind = value.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "hello" => {
            if label.is_none() {
                if let Some(client_id) = value.get("clientId").and_then(|v| v.as_str()) {
                    if is_valid_remote_id(client_id) {
                        *label = Some(client_id.to_string());
                        if let Some(registry) = registry {
                            registry
                                .evict_and_register(
                                    client_id,
                                    shutdown.clone(),
                                    teardown_done.clone(),
                                    send_tx.clone(),
                                )
                                .await;
                        }
                    }
                }
            }
        }
        "ping" => {
            let _ = send_tx.send(encode_control(&ControlMessage::Pong));
        }
        "pong" => {}
        "session-added" => {
            if let Some(meta) = value.get("meta") {
                add_session(meta, label, sessions, store_env, max_sessions, send_tx).await;
            }
        }
        "session-updated" => {
            let id = value.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if !is_valid_remote_id(id) {
                return;
            }
            if let Some(session) = sessions.get(id) {
                let patch = value
                    .get("patch")
                    .map(sanitize_remote_patch)
                    .unwrap_or_default();
                let _ = patch_session_meta(store_env, &session.local_id, patch);
            }
        }
        "session-removed" => {
            let id = value.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if !is_valid_remote_id(id) {
                return;
            }
            remove_session(sessions, id, store_env).await;
        }
        "signed" => {
            if let (Some(secret), Some(guard)) = (spawn_secret, replay_guard) {
                if let Ok(envelope) =
                    serde_json::from_value::<crate::mux::ControlMessage>(value.clone())
                {
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis() as i64;
                    if let Ok(inner) =
                        crate::spawn_auth::verify_signed_control(secret, &envelope, guard, now_ms)
                    {
                        if let crate::mux::ControlMessage::SpawnResult { request_id, .. } = &inner {
                            if let Some(registry) = registry {
                                registry.resolve_pending_spawn(request_id, inner.clone());
                            }
                        }
                    }
                }
            }
        }
        "spawn-result" => {
            if let Some(registry) = registry {
                if let Ok(inner) =
                    serde_json::from_value::<crate::mux::ControlMessage>(value.clone())
                {
                    if let crate::mux::ControlMessage::SpawnResult { request_id, .. } = &inner {
                        registry.resolve_pending_spawn(request_id, inner.clone());
                    }
                }
            }
        }
        _ => {}
    }
}

async fn add_session(
    meta: &Value,
    label: &Option<String>,
    sessions: &mut HashMap<String, RemoteSession>,
    store_env: &Arc<StoreEnv>,
    max_sessions: usize,
    send_tx: &mpsc::UnboundedSender<Vec<u8>>,
) {
    let label = match label {
        Some(label) => label.clone(),
        None => return,
    };
    let remote_id = meta.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if !is_valid_remote_id(remote_id) {
        return;
    }
    let remote_id = remote_id.to_string();
    let local_id = namespaced_id(&label, &remote_id);

    if let Some(existing) = sessions.get(&remote_id) {
        let patch = sanitize_remote_patch(&serde_json::json!({
            "status": meta.get("status").cloned().unwrap_or(Value::Null),
            "priorityReason": meta.get("priorityReason").cloned().unwrap_or(Value::Null),
        }));
        let mut patch = patch;
        patch.last_activity_at = Some(now_iso());
        let _ = patch_session_meta(store_env, &existing.local_id, patch);
        return;
    }
    if sessions.len() >= max_sessions {
        return;
    }

    let listener = match TcpListener::bind(("127.0.0.1", 0)).await {
        Ok(l) => l,
        Err(_) => return,
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(_) => return,
    };
    let resolved = format_session_socket_ref("127.0.0.1", port);

    let meta_local = to_local_meta(meta, &label, &local_id, &resolved);
    if write_session_meta(store_env, &meta_local).is_err() {
        return;
    }

    let sockets: LocalSockets = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let accept_sockets = sockets.clone();
    let accept_send = send_tx.clone();
    let accept_remote_id = remote_id.clone();
    let next_id = Arc::new(AtomicU64::new(0));
    let accept_handle = tokio::spawn(async move {
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(pair) => pair,
                Err(_) => break,
            };
            let socket_id = next_id.fetch_add(1, Ordering::SeqCst);
            let (to_local_tx, mut to_local_rx) = mpsc::unbounded_channel::<Vec<u8>>();
            accept_sockets.lock().await.insert(socket_id, to_local_tx);
            let _ = accept_send.send(encode_control(&ControlMessage::Attach {
                id: accept_remote_id.clone(),
            }));

            let (mut rd, mut wr) = stream.into_split();
            // Writer: inbound mux data -> local socket.
            let writer = tokio::spawn(async move {
                while let Some(bytes) = to_local_rx.recv().await {
                    if wr.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
            });
            // Reader: local socket -> mux data frames.
            let reader_sockets = accept_sockets.clone();
            let reader_send = accept_send.clone();
            let reader_remote_id = accept_remote_id.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match rd.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if let Ok(frame) = encode_data(&reader_remote_id, &buf[..n]) {
                                let _ = reader_send.send(frame);
                            }
                        }
                    }
                }
                // Cleanup: drop this socket; emit detach when none remain.
                let empty = {
                    let mut map = reader_sockets.lock().await;
                    map.remove(&socket_id);
                    map.is_empty()
                };
                writer.abort();
                if empty {
                    let _ = reader_send.send(encode_control(&ControlMessage::Detach {
                        id: reader_remote_id.clone(),
                    }));
                }
            });
        }
    });

    sessions.insert(
        remote_id,
        RemoteSession {
            local_id,
            sockets,
            accept_handle,
        },
    );
}

async fn remove_session(
    sessions: &mut HashMap<String, RemoteSession>,
    remote_id: &str,
    store_env: &Arc<StoreEnv>,
) {
    if let Some(session) = sessions.remove(remote_id) {
        session.accept_handle.abort();
        session.sockets.lock().await.clear();
        let patch = SessionMetaPatch {
            status: Some(SessionStatus::Disconnected),
            priority_reason: Some(PriorityReason::Disconnected),
            ..Default::default()
        };
        let _ = patch_session_meta(store_env, &session.local_id, patch);
    }
}

/// A running `devtunnel host` process. Mirrors `HostProcess`.
pub trait HostProcess: Send {
    fn stop(&mut self);
}

/// A simple closure-backed host process for tests.
pub struct ClosureHostProcess<F: FnMut() + Send>(pub F);
impl<F: FnMut() + Send> HostProcess for ClosureHostProcess<F> {
    fn stop(&mut self) {
        (self.0)()
    }
}

/// Factory closure that spawns a `devtunnel host` process for a tunnel id.
pub type SpawnHostFn<'a> = Box<dyn FnMut(&str) -> Box<dyn HostProcess> + Send + 'a>;

/// Desired-state supervisor for `devtunnel host`. Mirrors `TunnelHostSupervisor`.
pub struct TunnelHostSupervisor<'a> {
    config_env: ConfigEnv,
    spawn_host: SpawnHostFn<'a>,
    current: Option<(String, Box<dyn HostProcess>)>,
}

impl<'a> TunnelHostSupervisor<'a> {
    pub fn new(config_env: ConfigEnv, spawn_host: SpawnHostFn<'a>) -> Self {
        Self {
            config_env,
            spawn_host,
            current: None,
        }
    }

    /// Compares persisted `remote-host.json` against the running host and
    /// starts/stops/restarts to match. Mirrors `reconcile`.
    pub fn reconcile(&mut self) {
        let desired = crate::remote_host::read_remote_host_state(&self.config_env);
        let desired_id = desired.map(|s| s.tunnel_id);
        let current_id = self.current.as_ref().map(|(id, _)| id.clone());
        if current_id == desired_id {
            return;
        }
        if let Some((_, mut proc)) = self.current.take() {
            proc.stop();
        }
        if let Some(id) = desired_id {
            let proc = (self.spawn_host)(&id);
            self.current = Some((id, proc));
        }
    }

    /// Stops the running host, if any. Mirrors `stop`.
    pub fn stop(&mut self) {
        if let Some((_, mut proc)) = self.current.take() {
            proc.stop();
        }
    }
}

/// Resolves the configured port-shift retry count, defaulting to 100. Mirrors
/// `resolveIngestRetryAttempts`.
pub fn resolve_ingest_retry_attempts(config_env: &ConfigEnv) -> u32 {
    let raw = resolve_config_setting(
        "remote.ingestPortRetryAttempts",
        config_env,
        std::path::Path::new("."),
    );
    if let Some(value) = raw {
        if let Some(n) = value.as_f64() {
            if n.is_finite() && n.fract() == 0.0 && n >= 1.0 {
                return n as u32;
            }
        }
    }
    INGEST_PORT_RETRY_ATTEMPTS
}

/// True when a live ingest must be recycled: no beacon, a host-less beacon, or a
/// beacon bound to a different interface than expected. Mirrors `ingestNeedsRecycle`.
pub fn ingest_needs_recycle(beacon: Option<&IngestState>, expected_host: &str) -> bool {
    match beacon {
        None => true,
        Some(beacon) => match &beacon.host {
            None => true,
            Some(host) => host != expected_host,
        },
    }
}

/// Marks leftover running remote sessions from a previous daemon as
/// disconnected, and removes stale disconnected ones. Mirrors
/// `reconcileStaleRemoteSessions`.
pub fn reconcile_stale_remote_sessions(store_env: &StoreEnv) {
    let sessions = match list_sessions(store_env) {
        Ok(sessions) => sessions,
        Err(_) => return,
    };
    for meta in sessions {
        if meta.origin != Some(Origin::Remote) {
            continue;
        }
        match meta.status {
            SessionStatus::Running
            | SessionStatus::Acknowledged
            | SessionStatus::NeedsAttention
            | SessionStatus::Paused => {
                let patch = SessionMetaPatch {
                    status: Some(SessionStatus::Disconnected),
                    priority_reason: Some(PriorityReason::Disconnected),
                    ..Default::default()
                };
                let _ = patch_session_meta(store_env, &meta.id, patch);
            }
            SessionStatus::Disconnected => {
                let _ = remove_session_meta(store_env, &meta.id);
            }
            _ => {}
        }
    }
}

/// Reads a session meta (test/CLI helper).
pub fn read_meta(store_env: &StoreEnv, id: &str) -> Option<SessionMeta> {
    read_session_meta(store_env, id).ok().flatten()
}

/// Daemon completion reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IngestExit {
    /// Already running (singleton not acquired).
    AlreadyRunning,
    /// Stopped via SIGTERM/SIGINT-equivalent.
    Stopped,
    /// Demoted via a shutdown request.
    Demoted,
}

/// A flag the CLI sets from an OS signal handler to request a graceful stop.
pub type StopFlag = Arc<AtomicBool>;

/// Injected steps for [`run_ingest_daemon`]. Production wires real spawns; tests
/// inject no-ops. Mirrors the closures built inline in `runIngestDaemon`.
pub struct IngestDaemonDeps<'a> {
    /// Spawn a detached `__uplink` (used on demotion).
    pub spawn_uplink: Box<dyn FnMut() + Send + 'a>,
    /// Stop the co-located dashboard server (used on demotion).
    pub stop_local_server: Box<dyn FnMut() + Send + 'a>,
    /// Spawn a `devtunnel host` for a tunnel id.
    pub spawn_host: SpawnHostFn<'a>,
}

impl Default for IngestDaemonDeps<'_> {
    fn default() -> Self {
        Self {
            spawn_uplink: Box::new(|| {}),
            stop_local_server: Box::new(|| {}),
            spawn_host: Box::new(|_| Box::new(ClosureHostProcess(|| {}))),
        }
    }
}

fn ingest_pid_path(config_env: &ConfigEnv) -> std::path::PathBuf {
    climon_config::config::get_climon_home(config_env).join("ingest.pid")
}

fn server_state_path(config_env: &ConfigEnv) -> std::path::PathBuf {
    climon_config::config::get_climon_home(config_env).join("server.json")
}

/// Tries to bind `host:port`, returning true when nothing is listening. Mirrors
/// `canBindTcpPort`.
fn can_bind_tcp_port(host: &str, port: u16) -> bool {
    std::net::TcpListener::bind((host, port)).is_ok()
}

/// Picks the first bindable port at or after `start`, up to `max_attempts`.
/// Mirrors `chooseAvailablePort`. Returns `(port, changed)`.
fn choose_available_port(host: &str, start: u16, max_attempts: u32) -> Option<(u16, bool)> {
    for offset in 0..max_attempts {
        let port = start.checked_add(offset as u16)?;
        if can_bind_tcp_port(host, port) {
            return Some((port, port != start));
        }
    }
    None
}

/// Long-lived ingest daemon. Mirrors `runIngestDaemon`, but returns an
/// [`IngestExit`] instead of calling `process.exit` so it is testable; the CLI
/// wrapper maps the exit to a process code. `stop` is notified to trigger a
/// graceful stop (SIGTERM/SIGINT equivalent).
pub async fn run_ingest_daemon(
    config_env: ConfigEnv,
    store_env: StoreEnv,
    stop: Arc<Notify>,
    mut deps: IngestDaemonDeps<'_>,
) -> std::io::Result<IngestExit> {
    let pid_path = ingest_pid_path(&config_env);
    if !crate::singleton::acquire_singleton(&pid_path) {
        return Ok(IngestExit::AlreadyRunning);
    }
    reconcile_stale_remote_sessions(&store_env);

    let state = crate::remote_host::read_remote_host_state(&config_env);
    let default_port = state
        .as_ref()
        .map(|s| s.ingest_port)
        .or_else(|| {
            resolve_config_setting("remote.port", &config_env, std::path::Path::new("."))
                .and_then(|v| v.as_f64())
                .filter(|n| n.is_finite() && n.fract() == 0.0 && *n > 0.0)
                .map(|n| n as u16)
        })
        .unwrap_or(crate::ingest_port::DEFAULT_INGEST_PORT);
    let peer_env: crate::peer::Env = std::env::vars().collect();
    let host = crate::ingest_bind_host::resolve_ingest_bind_host(
        &peer_env,
        &crate::ingest_bind_host::ResolveIngestBindHostDeps {
            interfaces: Box::new(crate::ingest_bind_host::system_interfaces),
            is_wsl: Box::new(crate::peer::is_wsl),
            configured_host: Box::new(|_| None),
        },
    );
    // remote.ingestHost / remote-host.json override mirror resolveIngestBindAddress.
    let host = resolve_config_setting("remote.ingestHost", &config_env, std::path::Path::new("."))
        .and_then(|v| v.as_str().filter(|s| !s.is_empty()).map(String::from))
        .or_else(|| state.as_ref().and_then(|s| s.ingest_host.clone()))
        .unwrap_or(host);

    let retry = resolve_ingest_retry_attempts(&config_env);
    let (port, changed) = choose_available_port(&host, default_port, retry).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::AddrInUse, "no available ingest port")
    })?;
    if changed && state.is_none() {
        let _ = climon_config::config::write_config_setting(
            "remote.port",
            &port.to_string(),
            climon_config::config::WriteScope::Global,
            &config_env,
            std::path::Path::new("."),
        );
    }

    let keep_alive_seconds =
        resolve_config_setting("remote.keepAlive", &config_env, std::path::Path::new("."))
            .and_then(|v| v.as_f64())
            .filter(|n| *n >= 0.0)
            .unwrap_or(DEFAULT_KEEPALIVE_SECONDS);

    let listener = TcpListener::bind((host.as_str(), port)).await?;

    let spawn_secret =
        resolve_config_setting("remote.spawnSecret", &config_env, std::path::Path::new("."))
            .and_then(|v| v.as_str().filter(|s| !s.is_empty()).map(String::from));

    let control_listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let control_port = control_listener.local_addr()?.port();
    let control_socket =
        climon_session::socket::format_session_socket_ref("127.0.0.1", control_port);

    // Dual-listen: when a tunnel is configured and the data listener is NOT on
    // loopback, also bind 127.0.0.1:port so same-machine clients can connect.
    let needs_loopback = state
        .as_ref()
        .map(|s| !s.tunnel_id.is_empty())
        .unwrap_or(false)
        && host != "127.0.0.1"
        && host != "::1";
    let loopback_listener = if needs_loopback {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => Some(l),
            Err(e) => {
                eprintln!(
                    "climon: warning: ingest could not bind loopback 127.0.0.1:{port} ({e}). Dev tunnel connections may fail."
                );
                None
            }
        }
    } else {
        None
    };

    let mut supervisor = TunnelHostSupervisor::new(config_env.clone(), deps.spawn_host);
    supervisor.reconcile();

    let home = climon_config::config::get_climon_home(&config_env);
    let demote = Arc::new(Notify::new());
    let demote_for_watch = demote.clone();
    let _watcher = crate::shutdown_watch::create_shutdown_request_watcher(
        home.clone(),
        crate::shutdown_watch::DEFAULT_POLL_MS,
        move |_request| demote_for_watch.notify_one(),
    );

    crate::ingest_state::write_ingest_state(
        &IngestState {
            pid: std::process::id(),
            port,
            host: Some(host.clone()),
            control_socket: Some(control_socket.clone()),
        },
        &config_env,
    )?;

    let registry = Arc::new(IngestConnectionRegistry::new());

    // Dismiss watcher: when a materialized remote-session meta file disappears
    // (e.g. removed via the dashboard), dismiss its local id so it is not
    // re-materialized. Mirrors the Bun sessions-dir watcher.
    let sessions_dir = store_env.sessions_dir();
    let dismiss_registry = registry.clone();
    let _dismiss_watcher = {
        use std::collections::HashSet;
        let mut prev: HashSet<String> = scan_namespaced_session_files(&sessions_dir);
        crate::shutdown_watch::spawn_poll(crate::shutdown_watch::DEFAULT_POLL_MS, move || {
            let current = scan_namespaced_session_files(&sessions_dir);
            for gone in prev.difference(&current) {
                dismiss_registry.dismiss(gone);
            }
            prev = current;
        })
    };

    let loopback_task = loopback_listener.map(|lb| {
        let reg = registry.clone();
        let store = store_env.clone();
        let secret = spawn_secret.clone();
        let ka = keep_alive_seconds;
        tokio::spawn(async move {
            while let Ok((socket, _)) = lb.accept().await {
                let mut opts = IngestConnOptions::new(store.clone());
                opts.keep_alive_seconds = ka;
                opts.registry = Some(reg.clone());
                opts.spawn_secret = secret.clone();
                tokio::spawn(run_ingest_connection(socket, opts));
            }
        })
    });

    let mut poll = tokio::time::interval(Duration::from_secs(5));
    poll.tick().await;

    let exit;
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                if let Ok((socket, _)) = accepted {
                    let mut opts = IngestConnOptions::new(store_env.clone());
                    opts.keep_alive_seconds = keep_alive_seconds;
                    opts.registry = Some(registry.clone());
                    opts.spawn_secret = spawn_secret.clone();
                    tokio::spawn(run_ingest_connection(socket, opts));
                }
            }
            accepted = control_listener.accept() => {
                if let Ok((socket, _)) = accepted {
                    let reg = registry.clone();
                    let secret = spawn_secret.clone();
                    tokio::spawn(serve_control_connection(socket, reg, secret));
                }
            }
            _ = poll.tick() => {
                supervisor.reconcile();
            }
            _ = stop.notified() => {
                exit = IngestExit::Stopped;
                break;
            }
            _ = demote.notified() => {
                exit = IngestExit::Demoted;
                break;
            }
        }
    }

    supervisor.stop();
    drop(listener);
    if let Some(task) = loopback_task {
        task.abort();
    }
    if exit == IngestExit::Demoted {
        (deps.spawn_uplink)();
        (deps.stop_local_server)();
    }
    remove_beacons(&config_env);
    Ok(exit)
}

fn remove_beacons(config_env: &ConfigEnv) {
    let _ = std::fs::remove_file(crate::ingest_state::get_ingest_state_path(config_env));
    let _ = std::fs::remove_file(ingest_pid_path(config_env));
    let _ = std::fs::remove_file(crate::shutdown_request::get_shutdown_request_path(
        config_env,
    ));
    let _ = std::fs::remove_file(server_state_path(config_env));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespaced_session_filename_matcher() {
        assert_eq!(
            match_namespaced_session_file("client-1~abc123.json"),
            Some("client-1~abc123".to_string())
        );
        assert_eq!(match_namespaced_session_file("not-namespaced.json"), None);
        assert_eq!(match_namespaced_session_file("client-1~abc123.txt"), None);
    }

    #[tokio::test]
    async fn registry_channel_and_pending_spawn_roundtrip() {
        use crate::mux::ControlMessage;
        let registry = IngestConnectionRegistry::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let shutdown = std::sync::Arc::new(tokio::sync::Notify::new());
        let teardown = std::sync::Arc::new(tokio::sync::Notify::new());
        registry
            .evict_and_register("client-1", shutdown, teardown, tx)
            .await;

        // Channel is retrievable and usable.
        let chan = registry
            .get_channel("client-1")
            .expect("channel registered");
        chan.send(crate::mux::encode_control(&ControlMessage::Ping))
            .unwrap();
        assert!(rx.recv().await.is_some());

        // Pending spawn resolves when resolve_pending_spawn is called.
        let pending = registry.register_pending_spawn("req-1", 5_000);
        registry.resolve_pending_spawn(
            "req-1",
            ControlMessage::SpawnResult {
                request_id: "req-1".into(),
                id: Some("sess-1".into()),
                warning: None,
                error: None,
            },
        );
        let result = pending.await;
        match result {
            ControlMessage::SpawnResult { id, .. } => assert_eq!(id.as_deref(), Some("sess-1")),
            other => panic!("unexpected result: {other:?}"),
        }
    }

    #[tokio::test]
    async fn pending_spawn_times_out() {
        use crate::mux::ControlMessage;
        let registry = IngestConnectionRegistry::new();
        let pending = registry.register_pending_spawn("req-timeout", 20);
        match pending.await {
            ControlMessage::SpawnResult { error, .. } => {
                assert_eq!(error.as_deref(), Some("timeout"))
            }
            other => panic!("expected timeout SpawnResult, got {other:?}"),
        }
        assert!(registry.pending_spawns.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn spawn_control_request_signs_and_correlates() {
        use crate::mux::ControlMessage;
        let registry = std::sync::Arc::new(IngestConnectionRegistry::new());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let shutdown = std::sync::Arc::new(tokio::sync::Notify::new());
        let teardown = std::sync::Arc::new(tokio::sync::Notify::new());
        registry
            .evict_and_register("client-1", shutdown, teardown, tx)
            .await;

        let req = SpawnControlRequest {
            request_id: "req-9".into(),
            client_id: "client-1".into(),
            command: vec!["bash".into()],
            cwd: "/tmp".into(),
            cols: 80,
            rows: 24,
            name: None,
            priority: None,
            color: None,
            theme: None,
            headless: false,
        };

        let reg = registry.clone();
        let handle = tokio::spawn(async move {
            handle_spawn_control_request(req, &reg, Some("sekret".to_string()), 5_000).await
        });

        let frame = rx.recv().await.expect("spawn frame sent");
        registry.resolve_pending_spawn(
            "req-9",
            ControlMessage::SpawnResult {
                request_id: "req-9".into(),
                id: Some("sess-9".into()),
                warning: None,
                error: None,
            },
        );
        let res = handle.await.unwrap();
        assert_eq!(res.request_id, "req-9");
        assert_eq!(res.id.as_deref(), Some("sess-9"));
        let _ = frame;
    }

    #[tokio::test]
    async fn spawn_control_request_errors_when_client_absent() {
        let registry = std::sync::Arc::new(IngestConnectionRegistry::new());
        let req = SpawnControlRequest {
            request_id: "r".into(),
            client_id: "nobody".into(),
            command: vec!["sh".into()],
            cwd: "/".into(),
            cols: 80,
            rows: 24,
            name: None,
            priority: None,
            color: None,
            theme: None,
            headless: false,
        };
        let res = handle_spawn_control_request(req, &registry, Some("s".into()), 1_000).await;
        assert_eq!(res.error.as_deref(), Some("client not connected"));
    }

    #[tokio::test]
    async fn spawn_control_request_cleans_pending_when_send_fails() {
        let registry = std::sync::Arc::new(IngestConnectionRegistry::new());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let shutdown = std::sync::Arc::new(tokio::sync::Notify::new());
        let teardown = std::sync::Arc::new(tokio::sync::Notify::new());
        registry
            .evict_and_register("client-1", shutdown, teardown, tx)
            .await;
        drop(rx);

        let req = SpawnControlRequest {
            request_id: "send-fail".into(),
            client_id: "client-1".into(),
            command: vec!["sh".into()],
            cwd: "/".into(),
            cols: 80,
            rows: 24,
            name: None,
            priority: None,
            color: None,
            theme: None,
            headless: false,
        };
        let res = handle_spawn_control_request(req, &registry, Some("s".into()), 1_000).await;
        assert_eq!(res.error.as_deref(), Some("client not connected"));
        assert!(registry.pending_spawns.lock().unwrap().is_empty());
    }

    #[test]
    fn is_valid_remote_id_accepts_safe_ids() {
        assert!(is_valid_remote_id("abc-123_x.y"));
    }

    #[test]
    fn is_valid_remote_id_rejects_traversal_and_overlong() {
        assert!(!is_valid_remote_id("../etc"));
        assert!(!is_valid_remote_id("a/b"));
        assert!(!is_valid_remote_id(""));
        assert!(!is_valid_remote_id(&"x".repeat(65)));
    }

    #[test]
    fn resolve_ingest_retry_attempts_defaults_and_overrides() {
        let dir = std::env::temp_dir().join(format!(
            "climon-ingest-retry-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let os_home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        let env = ConfigEnv::new(Some(dir.to_str().unwrap()), &os_home);
        assert_eq!(resolve_ingest_retry_attempts(&env), 100);
        std::fs::write(
            dir.join("config.jsonc"),
            serde_json::json!({"remote": {"ingestPortRetryAttempts": 250}}).to_string(),
        )
        .unwrap();
        assert_eq!(resolve_ingest_retry_attempts(&env), 250);
        std::fs::write(
            dir.join("config.jsonc"),
            serde_json::json!({"remote": {"ingestPortRetryAttempts": 0}}).to_string(),
        )
        .unwrap();
        assert_eq!(resolve_ingest_retry_attempts(&env), 100);
        std::fs::write(
            dir.join("config.jsonc"),
            serde_json::json!({"remote": {"ingestPortRetryAttempts": -3}}).to_string(),
        )
        .unwrap();
        assert_eq!(resolve_ingest_retry_attempts(&env), 100);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn beacon(host: Option<&str>) -> IngestState {
        IngestState {
            pid: 1,
            port: 3132,
            host: host.map(String::from),
            control_socket: None,
        }
    }

    #[test]
    fn ingest_needs_recycle_rules() {
        assert!(ingest_needs_recycle(None, "127.0.0.1"));
        assert!(ingest_needs_recycle(Some(&beacon(None)), "127.0.0.1"));
        assert!(ingest_needs_recycle(
            Some(&beacon(Some("127.0.0.1"))),
            "172.30.192.1"
        ));
        assert!(!ingest_needs_recycle(
            Some(&beacon(Some("172.30.192.1"))),
            "172.30.192.1"
        ));
    }

    #[test]
    fn to_local_meta_coerces_invalid_fields() {
        let remote = serde_json::json!({
            "id": "s1",
            "command": ["bash"],
            "displayCommand": "bash",
            "cwd": "/home/dev",
            "status": "totally-invalid",
            "priorityReason": "because-i-said-so",
            "color": "chartreuse",
            "cols": 80,
            "rows": 24,
            "createdAt": "t",
            "updatedAt": "t",
            "lastActivityAt": "t"
        });
        let meta = to_local_meta(&remote, "dev1", "dev1~s1", "tcp://127.0.0.1:5000");
        assert_eq!(meta.status, SessionStatus::Running);
        assert_eq!(meta.priority_reason, PriorityReason::Running);
        assert_eq!(meta.color, None);
        assert_eq!(meta.origin, Some(Origin::Remote));
        assert_eq!(meta.client_label.as_deref(), Some("dev1"));
        assert_eq!(meta.socket_path, "tcp://127.0.0.1:5000");
    }

    #[test]
    fn sanitize_remote_patch_drops_server_fields() {
        let patch = sanitize_remote_patch(&serde_json::json!({
            "socketPath": "/evil.sock",
            "origin": "local",
            "clientLabel": "evil",
            "status": "completed"
        }));
        assert_eq!(patch.socket_path, None);
        assert_eq!(patch.status, Some(SessionStatus::Completed));
    }

    fn unique_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "climon-ingest-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        dir
    }

    async fn connect(port: u16) -> TcpStream {
        TcpStream::connect(("127.0.0.1", port)).await.unwrap()
    }

    async fn wait_meta(
        store_env: &StoreEnv,
        id: &str,
        pred: impl Fn(&SessionMeta) -> bool,
    ) -> Option<SessionMeta> {
        for _ in 0..200 {
            if let Some(meta) = read_session_meta(store_env, id).ok().flatten() {
                if pred(&meta) {
                    return Some(meta);
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        None
    }

    #[tokio::test]
    async fn materializes_a_remote_session_as_local_tcp_meta() {
        let home = unique_home("mat");
        let config_env = ConfigEnv::new(Some(home.to_str().unwrap()), &home);
        let _ = &config_env;
        let store_env = StoreEnv::with_home(&home);

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let se = store_env.clone();
        tokio::spawn(async move {
            loop {
                let (sock, _) = listener.accept().await.unwrap();
                let mut opts = IngestConnOptions::new(se.clone());
                opts.max_sessions = 10;
                tokio::spawn(run_ingest_connection(sock, opts));
            }
        });

        let mut client = connect(port).await;
        client
            .write_all(&encode_control(&ControlMessage::Hello {
                client_id: "dev1".into(),
            }))
            .await
            .unwrap();
        let meta_json = serde_json::json!({
            "id": "s1", "command": ["bash"], "displayCommand": "bash", "cwd": "/home/dev",
            "status": "running", "priorityReason": "running", "socketPath": "/should/be/ignored.sock",
            "cols": 80, "rows": 24, "createdAt": "t", "updatedAt": "t", "lastActivityAt": "t"
        });
        let added = serde_json::json!({"kind": "session-added", "meta": meta_json});
        client
            .write_all(&crate::mux::encode_control_value(&added))
            .await
            .unwrap();

        let meta = wait_meta(&store_env, "dev1~s1", |m| {
            !m.socket_path.ends_with(":0") && m.origin == Some(Origin::Remote)
        })
        .await
        .expect("meta materialized");
        assert_eq!(meta.client_label.as_deref(), Some("dev1"));
        assert!(meta.socket_path.starts_with("tcp://127.0.0.1:"));
        assert_ne!(meta.socket_path, "/should/be/ignored.sock");

        drop(client);
        let after = wait_meta(&store_env, "dev1~s1", |m| {
            m.status == SessionStatus::Disconnected
        })
        .await
        .expect("disconnected");
        assert_eq!(after.status, SessionStatus::Disconnected);
        std::fs::remove_dir_all(&home).ok();
    }

    #[tokio::test]
    async fn rejects_a_malicious_session_id_before_any_write() {
        let home = unique_home("evil");
        let store_env = StoreEnv::with_home(&home);
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let se = store_env.clone();
        let handle = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut opts = IngestConnOptions::new(se.clone());
            opts.max_sessions = 10;
            run_ingest_connection(sock, opts).await;
        });
        let mut client = connect(port).await;
        client
            .write_all(&encode_control(&ControlMessage::Hello {
                client_id: "dev1".into(),
            }))
            .await
            .unwrap();
        let added = serde_json::json!({"kind": "session-added", "meta": {
            "id": "../evil", "command": [], "displayCommand": "x", "cwd": "/",
            "status": "running", "priorityReason": "running", "socketPath": "x",
            "cols": 80, "rows": 24, "createdAt": "t", "updatedAt": "t", "lastActivityAt": "t"
        }});
        client
            .write_all(&crate::mux::encode_control_value(&added))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(list_sessions(&store_env).unwrap().len(), 0);
        drop(client);
        let _ = handle.await;
        std::fs::remove_dir_all(&home).ok();
    }

    #[tokio::test]
    async fn rejects_server_controlled_fields_in_updates() {
        let home = unique_home("upd");
        let store_env = StoreEnv::with_home(&home);
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let se = store_env.clone();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut opts = IngestConnOptions::new(se.clone());
            opts.max_sessions = 10;
            run_ingest_connection(sock, opts).await;
        });
        let mut client = connect(port).await;
        client
            .write_all(&encode_control(&ControlMessage::Hello {
                client_id: "dev1".into(),
            }))
            .await
            .unwrap();
        let added = serde_json::json!({"kind": "session-added", "meta": {
            "id": "s1", "command": ["bash"], "displayCommand": "bash", "cwd": "/home/dev",
            "status": "running", "priorityReason": "running", "socketPath": "x",
            "cols": 80, "rows": 24, "createdAt": "t", "updatedAt": "t", "lastActivityAt": "t"
        }});
        client
            .write_all(&crate::mux::encode_control_value(&added))
            .await
            .unwrap();
        let meta = wait_meta(&store_env, "dev1~s1", |m| !m.socket_path.ends_with(":0"))
            .await
            .unwrap();
        let socket_path = meta.socket_path.clone();
        let upd = serde_json::json!({"kind": "session-updated", "id": "s1", "patch": {
            "socketPath": "/evil.sock", "origin": "local", "clientLabel": "evil"
        }});
        client
            .write_all(&crate::mux::encode_control_value(&upd))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let after = read_session_meta(&store_env, "dev1~s1").unwrap().unwrap();
        assert_eq!(after.socket_path, socket_path);
        assert_eq!(after.origin, Some(Origin::Remote));
        assert_eq!(after.client_label.as_deref(), Some("dev1"));
        drop(client);
        std::fs::remove_dir_all(&home).ok();
    }

    #[tokio::test]
    async fn tears_down_idle_channel_without_keepalive_answer() {
        let home = unique_home("idle");
        let store_env = StoreEnv::with_home(&home);
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let se = store_env.clone();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut opts = IngestConnOptions::new(se.clone());
            opts.max_sessions = 10;
            opts.keep_alive_seconds = 0.05;
            run_ingest_connection(sock, opts).await;
        });
        let mut client = connect(port).await;
        client
            .write_all(&encode_control(&ControlMessage::Hello {
                client_id: "dev1".into(),
            }))
            .await
            .unwrap();
        let added = serde_json::json!({"kind": "session-added", "meta": {
            "id": "s1", "command": ["bash"], "displayCommand": "bash", "cwd": "/home/dev",
            "status": "running", "priorityReason": "running", "socketPath": "x",
            "cols": 80, "rows": 24, "createdAt": "t", "updatedAt": "t", "lastActivityAt": "t"
        }});
        client
            .write_all(&crate::mux::encode_control_value(&added))
            .await
            .unwrap();
        let after = wait_meta(&store_env, "dev1~s1", |m| {
            m.status == SessionStatus::Disconnected
        })
        .await
        .expect("disconnected via idle");
        assert_eq!(after.status, SessionStatus::Disconnected);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn supervisor_starts_and_stops_hosting() {
        let home = unique_home("sup");
        let config_env = ConfigEnv::new(Some(home.to_str().unwrap()), &home);
        let remote_path = climon_config::config::get_remote_host_path(&config_env);

        let spawned = Arc::new(Mutex::new(Vec::<String>::new()));
        let killed = Arc::new(Mutex::new(Vec::<String>::new()));
        let sp = spawned.clone();
        let kl = killed.clone();
        let mut supervisor = TunnelHostSupervisor::new(
            config_env.clone(),
            Box::new(move |id: &str| {
                sp.lock().unwrap().push(id.to_string());
                let kl2 = kl.clone();
                let id2 = id.to_string();
                Box::new(ClosureHostProcess(move || {
                    kl2.lock().unwrap().push(id2.clone())
                })) as Box<dyn HostProcess>
            }),
        );

        supervisor.reconcile();
        assert!(spawned.lock().unwrap().is_empty());

        std::fs::write(&remote_path, r#"{"tunnelId":"tunA","ingestPort":3132}"#).unwrap();
        supervisor.reconcile();
        assert_eq!(*spawned.lock().unwrap(), vec!["tunA".to_string()]);

        supervisor.reconcile();
        assert_eq!(*spawned.lock().unwrap(), vec!["tunA".to_string()]);

        std::fs::write(&remote_path, r#"{"tunnelId":"tunB","ingestPort":3132}"#).unwrap();
        supervisor.reconcile();
        assert_eq!(*killed.lock().unwrap(), vec!["tunA".to_string()]);
        assert_eq!(
            *spawned.lock().unwrap(),
            vec!["tunA".to_string(), "tunB".to_string()]
        );

        std::fs::remove_file(&remote_path).ok();
        supervisor.reconcile();
        assert_eq!(
            *killed.lock().unwrap(),
            vec!["tunA".to_string(), "tunB".to_string()]
        );
        supervisor.stop();
        std::fs::remove_dir_all(&home).ok();
    }

    #[tokio::test]
    async fn daemon_demotes_on_shutdown_request_and_frees_port() {
        let home = unique_home("demote");
        let config_env = ConfigEnv::new(Some(home.to_str().unwrap()), &home);
        let store_env = StoreEnv::with_home(&home);
        // Force loopback bind via remote.ingestHost.
        std::fs::write(
            home.join("config.jsonc"),
            serde_json::json!({"remote": {"ingestHost": "127.0.0.1"}}).to_string(),
        )
        .unwrap();

        let stop = Arc::new(Notify::new());
        let spawned_uplink = Arc::new(AtomicBool::new(false));
        let su = spawned_uplink.clone();
        let cfg = config_env.clone();
        let se = store_env.clone();
        let handle = tokio::spawn(async move {
            run_ingest_daemon(
                cfg,
                se,
                stop,
                IngestDaemonDeps {
                    spawn_uplink: Box::new(move || su.store(true, Ordering::SeqCst)),
                    stop_local_server: Box::new(|| {}),
                    spawn_host: Box::new(|_| Box::new(ClosureHostProcess(|| {}))),
                },
            )
            .await
        });

        // Wait for the beacon.
        let mut bound_port = None;
        for _ in 0..200 {
            if let Some(state) = crate::ingest_state::read_ingest_state(&config_env) {
                bound_port = Some(state.port);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let bound_port = bound_port.expect("ingest beacon published");

        // Write a shutdown request into the daemon's own home.
        crate::shutdown_request::write_shutdown_request_to_dir(
            &home,
            &crate::shutdown_request::ShutdownRequest {
                requested_by: "Windows".into(),
                ts: 1_717_000_000_000,
            },
        )
        .unwrap();

        let exit = tokio::time::timeout(Duration::from_secs(10), handle)
            .await
            .expect("daemon exits")
            .unwrap()
            .unwrap();
        assert_eq!(exit, IngestExit::Demoted);
        assert!(spawned_uplink.load(Ordering::SeqCst));
        assert!(crate::ingest_state::read_ingest_state(&config_env).is_none());
        assert!(!crate::shutdown_request::get_shutdown_request_path_in_dir(&home).exists());
        // Port is bindable again.
        assert!(can_bind_tcp_port("127.0.0.1", bound_port));
        std::fs::remove_dir_all(&home).ok();
    }
}
