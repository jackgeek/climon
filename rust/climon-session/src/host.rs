//! The `SessionHost` orchestrator — production superset of `src/session-host.ts`
//! and `src/daemon/daemon.ts`.
//!
//! Owns the PTY, the per-session IPC socket server, the scrollback shadow, the
//! headless VT grid + idle/attention detection, the full frame relay, the
//! dashboard-driven title broadcast, the optional local-terminal relay, and the
//! `running`→`completed`/`failed` lifecycle. The TS async event loop maps to a
//! set of threads guarded by a single `Arc<Mutex<HostState>>` (mirroring the
//! single-threaded TS semantics) plus a connection registry.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use climon_proto::frame::{
    encode_frame, encode_json_frame, parse_json_payload, AttentionPayload, ExitPayload,
    FrameDecoder, FrameType, PtySizePayload, ResizePayload, ResizeSource, TerminalModePayload,
    TerminalResizeMode, TerminalWarningPayload, TitlePayload,
};
use climon_proto::meta::{PriorityReason, SessionMeta, SessionMetaPatch, SessionStatus};
use climon_pty::pty::PtyResizer;
use climon_pty::{resolve_command, Pty, PtyOptions};
use climon_store::paths::now_iso;
use climon_store::Env as StoreEnv;

use crate::attention::should_apply_user_attention_acknowledgement;
use crate::error::{SessionError, SessionResult};
use crate::fingerprint::HeadlessGrid;
use crate::idle::ScreenIdleDetector;
use crate::replay::{
    build_mouse_private_mode_replay_suffix, track_mouse_private_modes_from_output,
    TRACKED_MOUSE_PRIVATE_MODES,
};
use crate::resize::{clamp_resize, revert_size, Dimensions, ResizeRequest};
use crate::socket::{
    cleanup_session_socket, listen_on_session_socket, SessionListener, SessionStream,
};

const SESSION_ENV_VAR: &str = "CLIMON_SESSION_ID";
const NEST_LEVEL_ENV_VAR: &str = "CLIMON_NEST_LEVEL";
const SCROLLBACK_CAP: usize = 256 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// Options controlling the session host.
#[derive(Debug, Clone, Default)]
pub struct SessionHostOptions {
    /// When true, no local terminal attach (background session).
    pub headless: bool,
}

/// Origin of an attention transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttentionSource {
    Detector,
    User,
}

/// A connected client (dashboard server / browser viewer / local host probe).
struct Client {
    /// Outbound queue to the client's writer thread. Enqueuing never blocks on
    /// socket I/O, so a slow/wedged client cannot stall the shared state lock,
    /// the PTY-reader/local-relay hot path, or any other client — mirroring the
    /// non-blocking, buffered writes of the TS (Node) host. Dropping the client
    /// closes the channel, draining queued frames before the socket shuts down.
    tx: Sender<Arc<Vec<u8>>>,
    /// Whether the client has received its initial frames and joins broadcasts.
    in_clients: bool,
    /// Acted as a host terminal (sent a `source: host` resize).
    is_host: bool,
    /// Acted as a browser viewer (sent a non-host resize).
    is_viewer: bool,
    /// Already received the overgrown warning.
    warned: bool,
}

/// All mutable host state, guarded by one mutex (mirrors the single-threaded TS).
struct HostState {
    env: StoreEnv,
    id: String,
    headless: bool,
    resizer: PtyResizer,

    clients: HashMap<u64, Client>,

    clamp_browser_to_host: bool,
    set_title: bool,
    terminal_mode: TerminalResizeMode,
    current_name: String,
    host_cols: u16,
    host_rows: u16,
    applied_cols: u16,
    applied_rows: u16,

    last_attention_state: Option<bool>,
    current_attention_matched_at: Option<String>,
    current_attention_fingerprint: Option<String>,
    host_warning_active: bool,

    exited: bool,
    exit_code: Option<i32>,

    scrollback: climon_pty::Scrollback,
    grid: HeadlessGrid,
    idle_detector: ScreenIdleDetector,
    mouse_mode_state: HashMap<String, bool>,
    mouse_mode_remainder: String,
}

type Shared = Arc<Mutex<HostState>>;

impl HostState {
    fn fingerprint(&self) -> String {
        self.grid.fingerprint()
    }

    /// Builds the Replay payload: the scrollback snapshot plus the mouse
    /// private-mode re-assertion suffix.
    ///
    /// INTEROP NOTE (accepted divergence, code-review Issue 2): this mirrors
    /// `daemon.ts`, which appends the mouse-mode suffix. The currently-wired Bun
    /// production path (`session-host.ts`) replays a raw `scrollback.snapshot()`
    /// with no suffix. The suffix only re-asserts `\x1b[?<mode>h` for modes the
    /// session actually enabled (empty for non-mouse sessions), so it is a
    /// harmless superset: xterm handles the extra mode-sets gracefully and it
    /// fixes a latent "mouse mode lost on reattach" bug. The dashboard server
    /// merely bridges these bytes and the Rust client replaces the Bun client at
    /// cutover, so this is not a server-interop concern. We intentionally keep
    /// the richer daemon.ts behavior.
    fn replay_snapshot(&self) -> Vec<u8> {
        let mut snapshot = self.scrollback.snapshot();
        let suffix = build_mouse_private_mode_replay_suffix(
            &self.mouse_mode_state,
            TRACKED_MOUSE_PRIVATE_MODES,
        );
        if !suffix.is_empty() {
            snapshot.extend_from_slice(&suffix);
        }
        snapshot
    }

    /// Queues a frame to one client; drops the client if its writer has died.
    fn send_to_client(&mut self, client_id: u64, frame: &[u8]) {
        let frame = Arc::new(frame.to_vec());
        let mut failed = false;
        if let Some(client) = self.clients.get(&client_id) {
            if client.tx.send(frame).is_err() {
                failed = true;
            }
        }
        if failed {
            self.clients.remove(&client_id);
        }
    }

    /// Queues a frame to every initialized client; drops clients whose writer
    /// has died. One `Arc`'d frame is shared across all clients.
    fn broadcast(&mut self, frame: &[u8]) {
        let frame = Arc::new(frame.to_vec());
        let mut dead = Vec::new();
        for (id, client) in self.clients.iter() {
            if !client.in_clients {
                continue;
            }
            if client.tx.send(Arc::clone(&frame)).is_err() {
                dead.push(*id);
            }
        }
        for id in dead {
            self.clients.remove(&id);
        }
    }

    fn broadcast_terminal_mode(&mut self) {
        let frame = encode_json_frame(
            FrameType::TerminalMode,
            &TerminalModePayload {
                mode: self.terminal_mode,
            },
        );
        self.broadcast(&frame);
    }

    fn write_host_warning(&mut self, payload: &TerminalWarningPayload) {
        let frame = Arc::new(encode_json_frame(FrameType::TerminalWarning, payload));
        let mut dead = Vec::new();
        for (id, client) in self.clients.iter_mut() {
            if client.is_host && !client.warned {
                if client.tx.send(Arc::clone(&frame)).is_err() {
                    dead.push(*id);
                } else {
                    client.warned = true;
                }
            }
        }
        for id in dead {
            self.clients.remove(&id);
        }
    }

    fn overgrown_warning_payload(&self) -> Option<TerminalWarningPayload> {
        let has_host = self.clients.values().any(|c| c.is_host);
        let overgrown = self.terminal_mode == TerminalResizeMode::Fill
            && has_host
            && (self.applied_cols > self.host_cols.max(1)
                || self.applied_rows > self.host_rows.max(1));
        if !overgrown {
            return None;
        }
        Some(TerminalWarningPayload::Overgrown {
            cols: self.applied_cols,
            rows: self.applied_rows,
            host_cols: self.host_cols.max(1),
            host_rows: self.host_rows.max(1),
        })
    }

    fn update_overgrown_warning(&mut self) {
        if let Some(payload) = self.overgrown_warning_payload() {
            self.write_host_warning(&payload);
            self.host_warning_active = true;
        } else {
            if self.host_warning_active {
                let frame = Arc::new(encode_json_frame(
                    FrameType::TerminalWarning,
                    &TerminalWarningPayload::Restored,
                ));
                let mut dead = Vec::new();
                for (id, client) in self.clients.iter() {
                    if client.is_host && client.tx.send(Arc::clone(&frame)).is_err() {
                        dead.push(*id);
                    }
                }
                for id in dead {
                    self.clients.remove(&id);
                }
            }
            self.host_warning_active = false;
            for client in self.clients.values_mut() {
                client.warned = false;
            }
        }
    }

    fn apply_terminal_mode(&mut self, mode: TerminalResizeMode) {
        let changed = mode != self.terminal_mode;
        self.terminal_mode = mode;
        if changed {
            self.broadcast_terminal_mode();
        }
        if mode == TerminalResizeMode::Clamped {
            self.revert_to_host_size();
        } else {
            self.update_overgrown_warning();
        }
    }

    fn apply_resize(&mut self, size: ResizePayload) {
        if size.source == Some(ResizeSource::Host) {
            self.host_cols = size.cols.max(1);
            self.host_rows = size.rows.max(1);
            let has_viewer = self.clients.values().any(|c| c.is_viewer);
            if self.terminal_mode == TerminalResizeMode::Fill && has_viewer {
                self.update_overgrown_warning();
                return;
            }
        }

        if size.source != Some(ResizeSource::Host) {
            if let Some(mode) = size.mode {
                if mode != self.terminal_mode {
                    self.terminal_mode = mode;
                    self.broadcast_terminal_mode();
                }
            }
        }

        let is_host = size.source == Some(ResizeSource::Host);
        let request = ResizeRequest {
            cols: size.cols,
            rows: size.rows,
            source: size.source,
            mode: if is_host {
                None
            } else {
                Some(self.terminal_mode)
            },
        };
        let Dimensions { cols, rows } = clamp_resize(
            request,
            Dimensions {
                cols: self.host_cols,
                rows: self.host_rows,
            },
            self.clamp_browser_to_host,
        );
        let changed = cols != self.applied_cols || rows != self.applied_rows;
        let clamped_viewer = !is_host && (cols != size.cols.max(1) || rows != size.rows.max(1));
        self.applied_cols = cols;
        self.applied_rows = rows;
        self.resizer.resize(cols, rows);
        if changed {
            self.grid.resize(cols, rows);
            let fp = self.fingerprint();
            self.idle_detector.absorb_resize(&fp);
            let _ = climon_store::patch::patch_session_meta(
                &self.env,
                &self.id,
                SessionMetaPatch {
                    cols: Some(cols),
                    rows: Some(rows),
                    ..Default::default()
                },
            );
            let frame = encode_json_frame(FrameType::PtySize, &PtySizePayload { cols, rows });
            self.broadcast(&frame);
        } else if clamped_viewer {
            let frame = encode_json_frame(FrameType::PtySize, &PtySizePayload { cols, rows });
            self.broadcast(&frame);
        }
        self.update_overgrown_warning();
    }

    fn revert_to_host_size(&mut self) {
        if self.exited {
            return;
        }
        let target = revert_size(
            Dimensions {
                cols: self.host_cols,
                rows: self.host_rows,
            },
            Dimensions {
                cols: self.applied_cols,
                rows: self.applied_rows,
            },
        );
        let Some(target) = target else {
            return;
        };
        self.applied_cols = target.cols;
        self.applied_rows = target.rows;
        self.resizer.resize(target.cols, target.rows);
        self.grid.resize(target.cols, target.rows);
        let fp = self.fingerprint();
        self.idle_detector.absorb_resize(&fp);
        let _ = climon_store::patch::patch_session_meta(
            &self.env,
            &self.id,
            SessionMetaPatch {
                cols: Some(target.cols),
                rows: Some(target.rows),
                ..Default::default()
            },
        );
        let frame = encode_json_frame(
            FrameType::PtySize,
            &PtySizePayload {
                cols: target.cols,
                rows: target.rows,
            },
        );
        self.broadcast(&frame);
        self.update_overgrown_warning();
    }

    fn apply_attention(
        &mut self,
        payload: AttentionPayload,
        source: AttentionSource,
        current_fp: &str,
    ) {
        if self.exited {
            return;
        }
        if !payload.needs_attention {
            if source == AttentionSource::User
                && !should_apply_user_attention_acknowledgement(
                    self.last_attention_state,
                    self.current_attention_matched_at.as_deref(),
                    payload.attention_matched_at.as_deref(),
                    self.current_attention_fingerprint.as_deref(),
                    current_fp,
                )
            {
                return;
            }
            self.last_attention_state = Some(false);
            self.current_attention_matched_at = None;
            self.current_attention_fingerprint = None;
            let now = now_iso();
            let is_user = source == AttentionSource::User;
            let _ = climon_store::patch::patch_session_meta_from_current(
                &self.env,
                &self.id,
                |current| {
                    let status = if current.status == SessionStatus::Paused {
                        SessionStatus::Paused
                    } else if is_user {
                        SessionStatus::Acknowledged
                    } else {
                        SessionStatus::Running
                    };
                    Some(SessionMetaPatch {
                        status: Some(status),
                        priority_reason: Some(PriorityReason::Running),
                        attention_matched_at: Some(None),
                        attention_reason: Some(None),
                        last_activity_at: Some(now.clone()),
                        ..Default::default()
                    })
                },
            );
            return;
        }
        if self.last_attention_state == Some(true) {
            return;
        }
        let now = now_iso();
        let reason = payload.reason.clone();
        let mut applied = false;
        let _ =
            climon_store::patch::patch_session_meta_from_current(&self.env, &self.id, |current| {
                if current.status == SessionStatus::Paused {
                    return None;
                }
                applied = true;
                Some(SessionMetaPatch {
                    status: Some(SessionStatus::NeedsAttention),
                    priority_reason: Some(PriorityReason::Attention),
                    attention_matched_at: Some(Some(now.clone())),
                    attention_reason: Some(reason.clone()),
                    last_activity_at: Some(now.clone()),
                    ..Default::default()
                })
            });
        if applied {
            self.last_attention_state = Some(true);
            self.current_attention_matched_at = Some(now);
            self.current_attention_fingerprint = Some(current_fp.to_string());
        }
    }

    fn write_replay(&mut self, client_id: u64) {
        let pty_size = encode_json_frame(
            FrameType::PtySize,
            &PtySizePayload {
                cols: self.applied_cols,
                rows: self.applied_rows,
            },
        );
        self.send_to_client(client_id, &pty_size);
        let mode = encode_json_frame(
            FrameType::TerminalMode,
            &TerminalModePayload {
                mode: self.terminal_mode,
            },
        );
        self.send_to_client(client_id, &mode);
        let replay = encode_frame(FrameType::Replay, &self.replay_snapshot());
        self.send_to_client(client_id, &replay);
    }

    /// Writes the initial frames for a client (PtySize, TerminalMode,
    /// overgrown-warning, Replay, optional Exit/Title). Returns whether the
    /// client was closed (post-exit path).
    fn write_initial_frames(&mut self, client_id: u64) -> bool {
        match self.clients.get(&client_id) {
            Some(c) if c.in_clients => return false,
            None => return true,
            _ => {}
        }
        if let Some(c) = self.clients.get_mut(&client_id) {
            c.in_clients = true;
        }
        self.write_replay(client_id);
        self.update_overgrown_warning();
        if self.exited {
            if let Some(code) = self.exit_code {
                let exit = encode_json_frame(FrameType::Exit, &ExitPayload { exit_code: code });
                self.send_to_client(client_id, &exit);
            }
            // Drop the client so its writer drains the queued Exit frame and
            // then shuts the socket down (mirrors `socket.end()` after Exit).
            self.clients.remove(&client_id);
            return true;
        }
        if self.set_title && !self.current_name.is_empty() {
            let title = encode_json_frame(
                FrameType::Title,
                &TitlePayload {
                    name: self.current_name.clone(),
                },
            );
            self.send_to_client(client_id, &title);
        }
        false
    }

    fn handle_disconnect(&mut self, client_id: u64) {
        let removed = self.clients.remove(&client_id);
        let was_viewer = removed.as_ref().map(|c| c.is_viewer).unwrap_or(false);
        self.update_overgrown_warning();
        if was_viewer && !self.clients.values().any(|c| c.is_viewer) {
            let initial_mode = if self.clamp_browser_to_host {
                TerminalResizeMode::Clamped
            } else {
                TerminalResizeMode::Fill
            };
            if self.terminal_mode != initial_mode {
                self.terminal_mode = initial_mode;
                self.broadcast_terminal_mode();
            }
            self.revert_to_host_size();
        }
    }
}

fn cfg_bool(config: &serde_json::Value, section: &str, key: &str, default: bool) -> bool {
    config
        .get(section)
        .and_then(|s| s.get(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

fn cfg_i64(config: &serde_json::Value, section: &str, key: &str, default: i64) -> i64 {
    config
        .get(section)
        .and_then(|s| s.get(key))
        .and_then(|v| v.as_i64())
        .unwrap_or(default)
}

fn build_child_env(id: &str) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert(SESSION_ENV_VAR.to_string(), id.to_string());
    let nest = std::env::var(NEST_LEVEL_ENV_VAR)
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
        + 1;
    env.insert(NEST_LEVEL_ENV_VAR.to_string(), nest.to_string());
    env
}

/// Runs a session in-process: spawns the PTY, starts the IPC socket server for
/// dashboard clients, and (unless headless) relays local stdin/stdout. Returns
/// the PTY exit code when the command finishes. Mirrors `runSessionHost`.
pub fn run_session_host(
    id: &str,
    meta: SessionMeta,
    options: SessionHostOptions,
) -> SessionResult<i32> {
    let env = StoreEnv::from_env();
    let config_env = climon_config::config::Env::real();
    let config = climon_config::config::load_config(&config_env).map_err(SessionError::Config)?;

    let clamp_browser_to_host = cfg_bool(&config, "terminal", "clampBrowserToHost", false);
    let set_title = cfg_bool(&config, "terminal", "setTitle", true);
    let idle_seconds = cfg_i64(&config, "attention", "idleSeconds", 10);
    let idle_enabled = idle_seconds > 0;
    let headless = options.headless;

    let initial_mode = if clamp_browser_to_host {
        TerminalResizeMode::Clamped
    } else {
        TerminalResizeMode::Fill
    };

    // --- Spawn PTY ---
    let (file, args) = resolve_command(&meta.command)?;
    let mut pty = match Pty::spawn(&PtyOptions {
        command: file,
        args,
        cwd: std::path::PathBuf::from(&meta.cwd),
        cols: meta.cols,
        rows: meta.rows,
        env: Some(build_child_env(id)),
    }) {
        Ok(pty) => pty,
        Err(e) => {
            let now = now_iso();
            let _ = climon_store::patch::patch_session_meta(
                &env,
                id,
                SessionMetaPatch {
                    status: Some(SessionStatus::Failed),
                    priority_reason: Some(PriorityReason::Failed),
                    completed_at: Some(now.clone()),
                    exit_code: Some(1),
                    error: Some(e.to_string()),
                    last_activity_at: Some(now),
                    ..Default::default()
                },
            );
            return Ok(1);
        }
    };
    let pid = pty.pid();
    let reader = pty.try_clone_reader()?;
    let writer = pty.take_writer()?;
    let resizer = pty.resizer();
    let pty_writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(writer));

    let state: Shared = Arc::new(Mutex::new(HostState {
        env: env.clone(),
        id: id.to_string(),
        headless,
        resizer,
        clients: HashMap::new(),
        clamp_browser_to_host,
        set_title,
        terminal_mode: initial_mode,
        current_name: meta.name.clone().unwrap_or_default(),
        host_cols: meta.cols,
        host_rows: meta.rows,
        applied_cols: meta.cols,
        applied_rows: meta.rows,
        last_attention_state: None,
        current_attention_matched_at: None,
        current_attention_fingerprint: None,
        host_warning_active: false,
        exited: false,
        exit_code: None,
        scrollback: climon_pty::Scrollback::new(SCROLLBACK_CAP),
        grid: HeadlessGrid::new(meta.cols, meta.rows),
        idle_detector: ScreenIdleDetector::new(idle_seconds),
        mouse_mode_state: HashMap::new(),
        mouse_mode_remainder: String::new(),
    }));

    let shutdown = Arc::new(AtomicBool::new(false));
    let conn_threads: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));
    let client_seq = Arc::new(AtomicU64::new(0));

    // --- Local terminal relay (attached, unix, tty) ---
    //
    // Raw mode MUST be established before the PTY-reader thread can forward any
    // child output to the local terminal. The child (e.g. a shell's
    // instant-prompt) may emit terminal queries (OSC 10/11/4 color requests,
    // cursor-position reports, etc.) as its very first output; if that query
    // reaches the real terminal while stdin is still in cooked mode, the
    // terminal's reply is echoed back onto the screen as stray text like
    // `11;rgb:0d0d/1111/1717`. The TS host relies on Node's synchronous setup
    // ordering for this guarantee; here we must enable raw mode explicitly
    // first, since `spawn_reader_thread` runs concurrently.
    #[cfg(unix)]
    let _local = local_relay::setup(
        headless,
        Arc::clone(&state),
        Arc::clone(&pty_writer),
        Arc::clone(&shutdown),
    );

    // --- PTY-reader thread ---
    let reader_handle = spawn_reader_thread(reader, Arc::clone(&state), headless);

    // --- Mark running (respect paused) ---
    let _ = climon_store::patch::patch_session_meta_from_current(&env, id, |current| {
        if current.status == SessionStatus::Paused {
            Some(SessionMetaPatch {
                daemon_pid: pid,
                priority_reason: Some(PriorityReason::Running),
                ..Default::default()
            })
        } else {
            Some(SessionMetaPatch {
                status: Some(SessionStatus::Running),
                priority_reason: Some(PriorityReason::Running),
                daemon_pid: pid,
                ..Default::default()
            })
        }
    });

    // --- IPC socket server ---
    let (listener, resolved_ref) = listen_on_session_socket(&meta.socket_path)?;
    let _ = climon_store::patch::patch_session_meta(
        &env,
        id,
        SessionMetaPatch {
            socket_path: Some(resolved_ref.clone()),
            ..Default::default()
        },
    );
    listener.set_nonblocking(true)?;
    let accept_handle = spawn_accept_thread(
        listener,
        Arc::clone(&state),
        Arc::clone(&pty_writer),
        Arc::clone(&shutdown),
        Arc::clone(&conn_threads),
        Arc::clone(&client_seq),
    );

    // --- Idle-sampling thread ---
    let idle_handle = if idle_enabled {
        Some(spawn_idle_thread(Arc::clone(&state), Arc::clone(&shutdown)))
    } else {
        None
    };

    // --- Title-watch thread ---
    let title_handle = if set_title {
        Some(spawn_title_thread(
            Arc::clone(&state),
            Arc::clone(&shutdown),
        ))
    } else {
        None
    };

    // --- Signal handling: SIGTERM/SIGINT kill the child ---
    #[cfg(unix)]
    signals::spawn_kill_thread(pid, Arc::clone(&shutdown));

    // --- Wait for exit ---
    let exit_code = pty.wait().unwrap_or(1);

    // --- Lifecycle teardown ---
    {
        let mut s = state.lock().unwrap();
        s.exited = true;
        s.exit_code = Some(exit_code);
        let snapshot = s.scrollback.snapshot();
        let _ = climon_store::meta::write_scrollback(&env, id, &snapshot);
        let now = now_iso();
        let status = if exit_code == 0 {
            SessionStatus::Completed
        } else {
            SessionStatus::Failed
        };
        let reason = if exit_code == 0 {
            PriorityReason::Completed
        } else {
            PriorityReason::Failed
        };
        let _ = climon_store::patch::patch_session_meta(
            &env,
            id,
            SessionMetaPatch {
                status: Some(status),
                priority_reason: Some(reason),
                completed_at: Some(now.clone()),
                exit_code: Some(exit_code),
                last_activity_at: Some(now),
                ..Default::default()
            },
        );
        let exit_frame = encode_json_frame(FrameType::Exit, &ExitPayload { exit_code });
        s.broadcast(&exit_frame);
        // Drop every client; each writer thread drains its queued frames
        // (including the Exit just broadcast) and then shuts its socket down,
        // which in turn unblocks the connection reader threads. Writer and
        // reader threads are joined via `conn_threads` below.
        s.clients.clear();
    }

    shutdown.store(true, Ordering::SeqCst);
    let _ = accept_handle.join();
    if let Some(h) = idle_handle {
        let _ = h.join();
    }
    if let Some(h) = title_handle {
        let _ = h.join();
    }
    let _ = reader_handle.join();
    for h in conn_threads.lock().unwrap().drain(..) {
        let _ = h.join();
    }

    cleanup_session_socket(&resolved_ref);
    Ok(exit_code)
}

fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    state: Shared,
    headless: bool,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let data = &buf[..n];
            let frame = encode_frame(FrameType::Output, data);
            {
                let mut s = state.lock().unwrap();
                let remainder = std::mem::take(&mut s.mouse_mode_remainder);
                s.mouse_mode_remainder = track_mouse_private_modes_from_output(
                    &mut s.mouse_mode_state,
                    data,
                    &remainder,
                    TRACKED_MOUSE_PRIVATE_MODES,
                );
                s.scrollback.append(data);
                s.grid.write(data);
                s.broadcast(&frame);
            }
            if !headless {
                let stdout = std::io::stdout();
                let mut lock = stdout.lock();
                let _ = lock.write_all(data);
                let _ = lock.flush();
            }
        }
    })
}

#[allow(clippy::too_many_arguments)]
fn spawn_accept_thread(
    listener: SessionListener,
    state: Shared,
    pty_writer: Arc<Mutex<Box<dyn Write + Send>>>,
    shutdown: Arc<AtomicBool>,
    conn_threads: Arc<Mutex<Vec<JoinHandle<()>>>>,
    client_seq: Arc<AtomicU64>,
) -> JoinHandle<()> {
    thread::spawn(move || loop {
        match listener.accept() {
            Ok(stream) => {
                let client_id = client_seq.fetch_add(1, Ordering::SeqCst);
                // Accepted sockets can inherit the listener's non-blocking flag;
                // per-connection reads must block.
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
                let writer_clone = match stream.try_clone_box() {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                // Dedicated writer thread drains the client's outbound queue so
                // socket writes never happen under the shared state lock.
                let (tx, rx) = channel::<Arc<Vec<u8>>>();
                let writer_handle = spawn_writer_thread(writer_clone, rx);
                {
                    let mut s = state.lock().unwrap();
                    s.clients.insert(
                        client_id,
                        Client {
                            tx,
                            in_clients: false,
                            is_host: false,
                            is_viewer: false,
                            warned: false,
                        },
                    );
                }
                // 10ms initial-frames timer (gives the client a chance to send
                // its first Resize/Mode so host/viewer + size are known).
                let timer_state = Arc::clone(&state);
                let timer = thread::spawn(move || {
                    thread::sleep(Duration::from_millis(10));
                    let mut s = timer_state.lock().unwrap();
                    s.write_initial_frames(client_id);
                });
                let reader_handle = spawn_connection_reader(
                    stream,
                    client_id,
                    Arc::clone(&state),
                    Arc::clone(&pty_writer),
                );
                let mut handles = conn_threads.lock().unwrap();
                handles.push(timer);
                handles.push(reader_handle);
                handles.push(writer_handle);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
    })
}

/// Drains a client's outbound queue, writing each frame to its socket in FIFO
/// order. Runs on its own thread so a slow or wedged client never blocks the
/// shared state lock or any peer. Exits (shutting the socket down, which
/// unblocks the connection reader) when the channel closes, a `Close` message
/// arrives, or a write fails.
fn spawn_writer_thread(
    mut stream: Box<dyn SessionStream>,
    rx: Receiver<Arc<Vec<u8>>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while let Ok(frame) = rx.recv() {
            if stream.write_all(&frame).is_err() {
                break;
            }
        }
        let _ = stream.shutdown_both();
    })
}

fn spawn_connection_reader(
    mut stream: Box<dyn SessionStream>,
    client_id: u64,
    state: Shared,
    pty_writer: Arc<Mutex<Box<dyn Write + Send>>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut decoder = FrameDecoder::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for frame in decoder.push(&buf[..n]) {
                match frame.frame_type {
                    FrameType::Input => {
                        {
                            let mut s = state.lock().unwrap();
                            let fp = s.fingerprint();
                            s.apply_attention(
                                AttentionPayload {
                                    needs_attention: false,
                                    reason: Some("input".to_string()),
                                    attention_matched_at: None,
                                },
                                AttentionSource::User,
                                &fp,
                            );
                        }
                        let mut w = pty_writer.lock().unwrap();
                        let _ = w.write_all(&frame.payload);
                        let _ = w.flush();
                    }
                    FrameType::Resize => {
                        if let Ok(size) = parse_json_payload::<ResizePayload>(&frame.payload) {
                            let mut s = state.lock().unwrap();
                            if size.source == Some(ResizeSource::Host) {
                                if let Some(c) = s.clients.get_mut(&client_id) {
                                    c.is_host = true;
                                }
                            } else if let Some(c) = s.clients.get_mut(&client_id) {
                                c.is_viewer = true;
                            }
                            s.apply_resize(size);
                            s.write_initial_frames(client_id);
                        }
                    }
                    FrameType::TerminalMode => {
                        if let Ok(payload) =
                            parse_json_payload::<TerminalModePayload>(&frame.payload)
                        {
                            let mut s = state.lock().unwrap();
                            s.apply_terminal_mode(payload.mode);
                            s.write_initial_frames(client_id);
                        }
                    }
                    FrameType::Attention => {
                        if let Ok(payload) = parse_json_payload::<AttentionPayload>(&frame.payload)
                        {
                            let mut s = state.lock().unwrap();
                            let fp = s.fingerprint();
                            s.apply_attention(payload, AttentionSource::User, &fp);
                            s.write_initial_frames(client_id);
                        }
                    }
                    FrameType::Replay => {
                        let mut s = state.lock().unwrap();
                        s.write_replay(client_id);
                    }
                    _ => {}
                }
            }
        }
        let mut s = state.lock().unwrap();
        s.handle_disconnect(client_id);
    })
}

fn spawn_idle_thread(state: Shared, shutdown: Arc<AtomicBool>) -> JoinHandle<()> {
    thread::spawn(move || {
        let start = Instant::now();
        loop {
            thread::sleep(Duration::from_millis(1000));
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            let now_ms = start.elapsed().as_millis() as i64;
            let mut s = state.lock().unwrap();
            if s.exited {
                break;
            }
            let fp = s.fingerprint();
            if let Some(transition) = s.idle_detector.update(&fp, now_ms) {
                s.apply_attention(
                    AttentionPayload {
                        needs_attention: transition.needs_attention,
                        reason: transition.reason,
                        attention_matched_at: None,
                    },
                    AttentionSource::Detector,
                    &fp,
                );
            }
        }
    })
}

fn spawn_title_thread(state: Shared, shutdown: Arc<AtomicBool>) -> JoinHandle<()> {
    thread::spawn(move || {
        let (env, id, headless) = {
            let s = state.lock().unwrap();
            (s.env.clone(), s.id.clone(), s.headless)
        };
        loop {
            thread::sleep(Duration::from_millis(1000));
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            let fresh = match climon_store::meta::read_session_meta(&env, &id) {
                Ok(Some(m)) => m,
                _ => continue,
            };
            let new_name = fresh.name.unwrap_or_default();
            let mut s = state.lock().unwrap();
            if s.exited {
                break;
            }
            if new_name != s.current_name {
                s.current_name = new_name.clone();
                let frame = encode_json_frame(
                    FrameType::Title,
                    &TitlePayload {
                        name: new_name.clone(),
                    },
                );
                s.broadcast(&frame);
                if !headless {
                    let stdout = std::io::stdout();
                    let mut lock = stdout.lock();
                    let _ = write!(lock, "\x1b]0;{new_name}\x07");
                    let _ = lock.flush();
                }
            }
        }
    })
}

#[cfg(unix)]
mod signals {
    use super::*;

    pub fn spawn_kill_thread(pid: Option<u32>, shutdown: Arc<AtomicBool>) {
        let Some(pid) = pid else {
            return;
        };
        thread::spawn(move || {
            use signal_hook::consts::{SIGINT, SIGTERM};
            use signal_hook::iterator::Signals;
            let mut signals = match Signals::new([SIGTERM, SIGINT]) {
                Ok(s) => s,
                Err(_) => return,
            };
            for _ in signals.forever() {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
                // Terminate the child; its exit wakes pty.wait() on the main thread.
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGTERM);
                }
            }
        });
    }
}

#[cfg(unix)]
mod local_relay {
    use super::*;
    use climon_pty::{terminal_size, RawMode};

    /// RAII bundle keeping raw mode enabled for the attached session lifetime.
    pub struct LocalRelay {
        _raw: Option<RawMode>,
    }

    pub fn setup(
        headless: bool,
        state: Shared,
        pty_writer: Arc<Mutex<Box<dyn Write + Send>>>,
        shutdown: Arc<AtomicBool>,
    ) -> LocalRelay {
        if headless || unsafe { libc::isatty(libc::STDIN_FILENO) } != 1 {
            return LocalRelay { _raw: None };
        }
        let raw = RawMode::enable(libc::STDIN_FILENO).ok();

        // stdin -> pty
        let stdin_shutdown = Arc::clone(&shutdown);
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let stdin = std::io::stdin();
            loop {
                if stdin_shutdown.load(Ordering::SeqCst) {
                    break;
                }
                let mut lock = stdin.lock();
                let n = match lock.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                drop(lock);
                let mut w = pty_writer.lock().unwrap();
                if w.write_all(&buf[..n]).is_err() {
                    break;
                }
                let _ = w.flush();
            }
        });

        // SIGWINCH -> apply host resize
        let winch_state = Arc::clone(&state);
        let winch_shutdown = Arc::clone(&shutdown);
        thread::spawn(move || {
            use signal_hook::consts::SIGWINCH;
            use signal_hook::iterator::Signals;
            let mut signals = match Signals::new([SIGWINCH]) {
                Ok(s) => s,
                Err(_) => return,
            };
            for _ in signals.forever() {
                if winch_shutdown.load(Ordering::SeqCst) {
                    break;
                }
                let (cols, rows) = terminal_size(libc::STDIN_FILENO);
                let mut s = winch_state.lock().unwrap();
                s.apply_resize(ResizePayload {
                    cols,
                    rows,
                    source: Some(ResizeSource::Host),
                    mode: None,
                });
            }
        });

        LocalRelay { _raw: raw }
    }
}

#[cfg(all(test, unix))]
mod writer_thread_tests {
    use super::spawn_writer_thread;
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    use std::sync::mpsc::channel;
    use std::sync::Arc;

    #[test]
    fn writer_drains_queued_frames_in_order_then_closes_socket() {
        let (writer_side, mut reader_side) = UnixStream::pair().unwrap();
        let (tx, rx) = channel::<Arc<Vec<u8>>>();
        let handle = spawn_writer_thread(Box::new(writer_side), rx);

        tx.send(Arc::new(b"hello".to_vec())).unwrap();
        tx.send(Arc::new(b"world".to_vec())).unwrap();
        // Dropping the only sender closes the channel; the writer drains the
        // queued frames, then shuts the socket down (read returns EOF).
        drop(tx);

        let mut out = Vec::new();
        reader_side.read_to_end(&mut out).unwrap();
        assert_eq!(out, b"helloworld");
        handle.join().unwrap();
    }

    #[test]
    fn writer_exits_when_peer_closes_without_blocking_sender() {
        let (writer_side, reader_side) = UnixStream::pair().unwrap();
        let (tx, rx) = channel::<Arc<Vec<u8>>>();
        let handle = spawn_writer_thread(Box::new(writer_side), rx);

        // Peer goes away; subsequent enqueues must not block the producer.
        drop(reader_side);
        for _ in 0..1000 {
            let _ = tx.send(Arc::new(vec![0u8; 64]));
        }
        drop(tx);
        handle.join().unwrap();
    }
}
