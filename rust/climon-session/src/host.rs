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
    encode_frame, encode_json_frame, parse_json_payload, AttentionPayload, ControlPayload,
    ExitPayload, FrameDecoder, FrameType, PtySizePayload, ResizePayload, ResizeSource, SurfaceKind,
    TerminalModePayload, TerminalResizeMode, TerminalWarningPayload,
};
use climon_proto::meta::{
    PriorityReason, SessionMeta, SessionMetaPatch, SessionStatus, TerminalProgress,
};
use climon_pty::pty::PtyResizer;
use climon_pty::{resolve_command, Pty, PtyOptions};
use climon_store::paths::now_iso;
use climon_store::Env as StoreEnv;

use crate::attention::fingerprint_body;
use crate::attention::should_apply_user_attention_acknowledgement;
use crate::control::{choose_controller, is_displaced, Surface};
use crate::error::{SessionError, SessionResult};
use crate::fingerprint::HeadlessGrid;
use crate::idle::ScreenIdleDetector;
use crate::replay::{
    build_mouse_private_mode_replay_suffix, track_mouse_private_modes_from_output,
    TRACKED_MOUSE_PRIVATE_MODES,
};
use crate::resize::{revert_size, Dimensions};
use crate::socket::{
    cleanup_session_socket, listen_on_session_socket, SessionListener, SessionStream,
};
use crate::title_capture::capture_terminal_output;

const SESSION_ENV_VAR: &str = "CLIMON_SESSION_ID";
const NEST_LEVEL_ENV_VAR: &str = "CLIMON_NEST_LEVEL";
const SCROLLBACK_CAP: usize = 256 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the local terminal stays suppressed after a browser viewer shrinks
/// back to (or under) the local size before the restore watcher repaints it from
/// the parsed grid's current screen. This delay lets the PTY's resize-repaint
/// burst (notably Windows ConPTY's clear-and-repaint, delivered asynchronously
/// on the reader thread after the resize call) drain first, so the clean grid
/// repaint lands last and the local terminal is not left blank or corrupted. The
/// screen is rendered when the watcher fires, so it reflects the latest output.
const LOCAL_RESTORE_DELAY: Duration = Duration::from_millis(250);

/// Returns whether the `CLIMON_DEBUG_RESTORE` restore diagnostics are enabled
/// (any non-empty, non-`0` value). Cached for the process lifetime.
fn debug_restore_enabled() -> bool {
    use std::sync::OnceLock;
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(|| {
        std::env::var("CLIMON_DEBUG_RESTORE")
            .map(|v| !v.is_empty() && v != "0")
            .unwrap_or(false)
    })
}

/// Appends a timestamped line to `$CLIMON_HOME/logs/restore-debug.log` when the
/// `CLIMON_DEBUG_RESTORE` diagnostics are enabled. Best-effort: silently ignores
/// any IO error. Used to capture the exact sizes and bytes around a Fill-mode
/// restore so one Windows run reveals the corruption source.
fn debug_restore_log(env: &StoreEnv, line: &str) {
    if !debug_restore_enabled() {
        return;
    }
    let dir = env.logs_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("restore-debug.log"))
    {
        let _ = writeln!(f, "{} {}", now_iso(), line);
    }
}

/// Escapes control bytes for the restore debug log and caps the length so a
/// large repaint burst does not flood the log.
fn debug_escape(bytes: &[u8], cap: usize) -> String {
    let mut s = String::new();
    for &b in bytes.iter().take(cap) {
        match b {
            0x1b => s.push_str("\\e"),
            b'\r' => s.push_str("\\r"),
            b'\n' => s.push_str("\\n"),
            b'\t' => s.push_str("\\t"),
            0x20..=0x7e => s.push(b as char),
            other => s.push_str(&format!("\\x{other:02x}")),
        }
    }
    if bytes.len() > cap {
        s.push_str(&format!("...(+{} bytes)", bytes.len() - cap));
    }
    s
}

/// Reads the *real* local console size for the restore diagnostics. On Windows
/// this is `GetConsoleScreenBufferInfo`'s visible viewport (a null handle falls
/// back to `STD_OUTPUT_HANDLE`); on Unix it reads stdin's `TIOCGWINSZ`.
#[cfg(windows)]
fn debug_console_size() -> (u16, u16) {
    climon_pty::terminal_size(std::ptr::null_mut())
}

#[cfg(unix)]
fn debug_console_size() -> (u16, u16) {
    climon_pty::terminal_size(0)
}

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
    /// Surface class, for control priority.
    kind: SurfaceKind,
    /// Stable viewer id from the client's resize frames (defaults to
    /// `client-<id>` so a dashboard that omits `viewerId` is never mistaken for
    /// the in-process `"local"` surface).
    viewer_id: String,
    /// Last size this surface reported.
    cols: u16,
    rows: u16,
    /// Connection sequence for controller tie-breaking (higher = more recent).
    seq: u64,
}

/// All mutable host state, guarded by one mutex (mirrors the single-threaded TS).
struct HostState {
    env: StoreEnv,
    id: String,
    resizer: PtyResizer,

    clients: HashMap<u64, Client>,

    clamp_browser_to_host: bool,
    terminal_mode: TerminalResizeMode,
    host_cols: u16,
    host_rows: u16,
    applied_cols: u16,
    applied_rows: u16,

    /// Id of the surface currently controlling the PTY grid (`None` when no
    /// surface has resized yet). The PTY dims (`applied_cols`/`applied_rows`)
    /// always equal this surface's last reported size.
    controller_id: Option<String>,
    /// Monotonic connection counter for controller tie-breaking.
    next_seq: u64,

    last_attention_state: Option<bool>,
    current_attention_matched_at: Option<String>,
    current_attention_fingerprint: Option<String>,
    host_warning_active: bool,
    /// True when an interactive local terminal is attached (non-headless, stdin
    /// and stdout are real consoles). The in-process local terminal is the
    /// session host, so it counts as a host presence for overgrown detection
    /// even though it is not a socket `Client`.
    local_attached: bool,
    /// True while local PTY output is paused because a browser viewer grew the
    /// shared PTY beyond the local terminal (Fill mode). Mirrors the client's
    /// `LocalTerminalOutputGate`; prevents oversized output from corrupting the
    /// local screen.
    local_output_suppressed: bool,
    /// When set, a restore (browser shrank back to/under the local size) is
    /// pending: the local terminal stays suppressed until this instant, then the
    /// restore watcher thread repaints it from the parsed grid's current screen
    /// and resumes live output. Deferring the repaint past the PTY's
    /// resize-repaint burst is load-bearing on Windows ConPTY, whose resize
    /// clears the screen and repaints only the current grid asynchronously after
    /// the resize call — an immediate repaint would be clobbered by that, leaving
    /// the local terminal blank. The grid is rendered at fire time, so it
    /// reflects the latest output.
    local_restore_at: Option<Instant>,
    /// Diagnostics-only (`CLIMON_DEBUG_RESTORE`): while set, the reader thread
    /// logs every chunk it writes to the local terminal so a single Windows run
    /// captures the PTY's post-unsuppress live output (the suspected ConPTY
    /// resize-repaint corrupter). Set by the restore watcher when it fires.
    local_debug_capture_until: Option<Instant>,

    exited: bool,
    exit_code: Option<i32>,

    scrollback: climon_pty::Scrollback,
    grid: HeadlessGrid,
    idle_detector: ScreenIdleDetector,
    started_at: Instant,
    mouse_mode_state: HashMap<String, bool>,
    mouse_mode_remainder: String,
    /// Latest terminal title parsed from the PTY output stream (`OSC 0/2`).
    /// `None` = no program has set a title yet; `Some("")` = explicitly cleared.
    captured_terminal_title: Option<String>,
    /// Trailing incomplete OSC bytes carried across reader chunks.
    terminal_title_remainder: String,
    /// Whether smart-notification snippet extraction is enabled
    /// (`feature.smartNotifications`, default disabled).
    snippet_enabled: bool,
    /// Latest progress parsed from the PTY output stream (`OSC 9;4`).
    /// `None` = never observed; `Some(None)` = cleared; `Some(Some(p))` = active.
    captured_progress: Option<Option<TerminalProgress>>,
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

    /// Snapshot of all connected surfaces (socket clients + the in-process local
    /// terminal) for the controller decision.
    fn surfaces(&self) -> Vec<Surface> {
        let mut out: Vec<Surface> = self
            .clients
            .values()
            .filter(|c| c.in_clients)
            .map(|c| Surface {
                id: c.viewer_id.clone(),
                kind: c.kind,
                cols: c.cols,
                rows: c.rows,
                seq: c.seq,
            })
            .collect();
        if self.local_attached {
            out.push(Surface {
                id: "local".into(),
                kind: SurfaceKind::Terminal,
                cols: self.host_cols,
                rows: self.host_rows,
                seq: 0,
            });
        }
        out
    }

    /// Size the controller currently dictates, if any.
    fn controller_size(&self) -> Option<(u16, u16)> {
        let id = self.controller_id.as_deref()?;
        if id == "local" {
            return Some((self.host_cols.max(1), self.host_rows.max(1)));
        }
        self.clients
            .values()
            .find(|c| c.viewer_id == id)
            .map(|c| (c.cols.max(1), c.rows.max(1)))
    }

    /// Broadcasts the current controller + grid dims to every surface.
    fn broadcast_control(&mut self) {
        let (Some(id), Some((cols, rows))) = (self.controller_id.clone(), self.controller_size())
        else {
            return;
        };
        let frame = encode_json_frame(
            FrameType::Control,
            &ControlPayload {
                controller_id: id,
                cols,
                rows,
            },
        );
        self.broadcast(&frame);
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

    /// Whether the shared PTY currently exceeds the local terminal's console in
    /// either dimension. This is the *real*, mode-independent condition under
    /// which the local Windows console corrupts: ConPTY positions its live output
    /// absolutely for the (larger) PTY grid, so any byte it writes can land off
    /// the bottom/right of the smaller real console. The local pause + notice and
    /// the restore repaint are gated on this — NOT on `overgrown_warning_payload`,
    /// which is Fill-mode-gated and only describes the dashboard-facing warning.
    fn local_terminal_exceeded(&self) -> bool {
        self.applied_cols > self.host_cols.max(1) || self.applied_rows > self.host_rows.max(1)
    }

    fn overgrown_warning_payload(&self) -> Option<TerminalWarningPayload> {
        let has_host = self.local_attached || self.clients.values().any(|c| c.is_host);
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

    /// Pauses or restores the in-process local terminal based on whether it is
    /// *displaced* — i.e. the controlling surface's grid is larger than the local
    /// console in either dimension, so ConPTY's absolutely-positioned output
    /// would corrupt the smaller real console. Level-triggered on the controller
    /// grid vs the local size (equivalently [`local_terminal_exceeded`], since
    /// `applied_*` tracks the controller). There is no socket `Client` for the
    /// local terminal, so pause/resume + the on-screen notice are handled here;
    /// the deferred repaint is driven by the restore watcher (see
    /// `local_restore_at`).
    fn update_local_displaced(&mut self) {
        if !self.local_attached {
            return;
        }
        let displaced = self
            .controller_size()
            .map(|(cc, cr)| is_displaced(self.host_cols, self.host_rows, cc, cr))
            .unwrap_or(false);
        if displaced {
            // Controller grid larger than the local console: pause local output
            // and show the notice. Cancel any pending restore.
            self.local_restore_at = None;
            if !self.local_output_suppressed {
                debug_restore_log(
                    &self.env,
                    &format!(
                        "displace-suppress host={}x{} applied={}x{} real_console={:?}",
                        self.host_cols,
                        self.host_rows,
                        self.applied_cols,
                        self.applied_rows,
                        debug_console_size(),
                    ),
                );
                write_local_stdout(
                    render_local_displaced(self.applied_cols, self.applied_rows).as_bytes(),
                );
                self.local_output_suppressed = true;
            }
        } else if self.local_output_suppressed && self.local_restore_at.is_none() {
            // Controller grid now fits the local console: schedule the deferred
            // repaint.
            self.local_restore_at = Some(Instant::now() + LOCAL_RESTORE_DELAY);
            debug_restore_log(
                &self.env,
                &format!(
                    "restore-schedule host={}x{} applied={}x{} real_console={:?} delay={}ms",
                    self.host_cols,
                    self.host_rows,
                    self.applied_cols,
                    self.applied_rows,
                    debug_console_size(),
                    LOCAL_RESTORE_DELAY.as_millis(),
                ),
            );
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
            self.update_local_displaced();
        }
    }

    /// Records a surface's reported size and, if that surface controls the PTY
    /// grid, drives the PTY to match. The first surface to resize claims control;
    /// thereafter only the controller's resizes move the grid. `TakeControl`
    /// (see [`take_control`]) is the explicit way to seize control.
    fn apply_resize(&mut self, size: ResizePayload) {
        let cols = size.cols.max(1);
        let rows = size.rows.max(1);
        let vid = size
            .viewer_id
            .clone()
            .unwrap_or_else(|| "local".to_string());
        let is_local = vid == "local";
        if is_local {
            self.host_cols = cols;
            self.host_rows = rows;
        }
        if let Some(client) = self.clients.values_mut().find(|c| c.viewer_id == vid) {
            client.cols = cols;
            client.rows = rows;
        }
        if self.controller_id.is_none() {
            self.controller_id = Some(vid.clone());
        }
        if self.controller_id.as_deref() == Some(vid.as_str()) {
            self.set_pty_size(cols, rows);
        } else if is_local {
            // The local console changed size while a remote surface controls the
            // grid: re-evaluate whether the local terminal is now displaced.
            self.update_local_displaced();
        }
        self.broadcast_control();
    }

    /// Drives the PTY/grid/metadata to `cols`x`rows` (the controller's size) and
    /// broadcasts the new `PtySize`. Extracted so [`apply_resize`],
    /// [`take_control`], and [`recompute_controller`] share one grid-mutation
    /// path. Always re-checks local-terminal displacement afterwards.
    fn set_pty_size(&mut self, cols: u16, rows: u16) {
        let changed = cols != self.applied_cols || rows != self.applied_rows;
        self.applied_cols = cols;
        self.applied_rows = rows;
        self.resizer.resize(cols, rows);
        if changed {
            self.grid.resize(cols, rows);
            let fp = self.fingerprint();
            let now_ms = self.started_at.elapsed().as_millis() as i64;
            self.idle_detector.absorb_resize(&fp, now_ms);
            climon_logging::logger::child("idle").log_with(
                climon_logging::level::LogLevel::Debug,
                serde_json::json!({
                    "sessionId": self.id,
                    "event": "set_pty_size",
                    "cols": cols,
                    "rows": rows,
                    "controller": self.controller_id,
                    "now": now_ms,
                    "settleUntil": self.idle_detector.settle_until(),
                }),
                "resize absorbed",
            );
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
        }
        self.update_local_displaced();
    }

    /// Promotes the surface `vid` to controller and resizes the PTY to its last
    /// reported size. Driven by a `TakeControl` frame or the local Ctrl+T chord.
    fn take_control(&mut self, vid: &str) {
        let size = if vid == "local" {
            Some((self.host_cols.max(1), self.host_rows.max(1)))
        } else {
            self.clients
                .values()
                .find(|c| c.viewer_id == vid)
                .map(|c| (c.cols.max(1), c.rows.max(1)))
        };
        let Some((cols, rows)) = size else {
            return;
        };
        self.controller_id = Some(vid.to_string());
        self.set_pty_size(cols, rows);
        self.broadcast_control();
    }

    /// Re-picks a controller when the current one is gone. If the controller is
    /// still connected this is a no-op; otherwise it falls back to
    /// [`choose_controller`] (priority PWA > dashboard > terminal, ties by most
    /// recent) and resizes the PTY to the new controller's size.
    fn recompute_controller(&mut self) {
        let still_present = self
            .controller_id
            .as_deref()
            .map(|id| {
                (id == "local" && self.local_attached)
                    || self
                        .clients
                        .values()
                        .any(|c| c.in_clients && c.viewer_id == id)
            })
            .unwrap_or(false);
        if still_present {
            return;
        }
        let surfaces = self.surfaces();
        match choose_controller(&surfaces) {
            Some(next) => {
                let (id, cols, rows) = (next.id.clone(), next.cols.max(1), next.rows.max(1));
                self.controller_id = Some(id);
                self.set_pty_size(cols, rows);
                self.broadcast_control();
            }
            None => {
                self.controller_id = None;
            }
        }
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
        let now_ms = self.started_at.elapsed().as_millis() as i64;
        self.idle_detector.absorb_resize(&fp, now_ms);
        climon_logging::logger::child("idle").log_with(
            climon_logging::level::LogLevel::Debug,
            serde_json::json!({
                "sessionId": self.id,
                "event": "revert_to_host_size",
                "cols": target.cols,
                "rows": target.rows,
                "now": now_ms,
                "settleUntil": self.idle_detector.settle_until(),
                "flagged": self.idle_detector.is_flagged(),
                "acknowledged": self.idle_detector.is_acknowledged(),
            }),
            "revert absorbed",
        );
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
        self.update_local_displaced();
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
            climon_logging::logger::child("idle").log_with(
                climon_logging::level::LogLevel::Debug,
                serde_json::json!({
                    "sessionId": self.id,
                    "event": "apply_attention",
                    "source": format!("{source:?}"),
                    "status": if is_user { "acknowledged" } else { "running" },
                }),
                "attention cleared",
            );
            if is_user {
                // A user acknowledgement clears the detector's flagged state so a
                // later screen change cannot emit a stale revert, and marks the
                // screen acknowledged so it does not re-flag while unchanged.
                let now_ms = self.started_at.elapsed().as_millis() as i64;
                self.idle_detector.acknowledge(current_fp, now_ms);
            }
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
                        attention_snippet: Some(None),
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
        let attention_snippet = if self.snippet_enabled {
            crate::snippet::extract_snippet(
                &self.grid.visible_lines(),
                Some(self.grid.cursor_row() as usize),
            )
        } else {
            None
        };
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
                    attention_snippet: Some(attention_snippet.clone()),
                    ..Default::default()
                })
            });
        if applied {
            self.last_attention_state = Some(true);
            self.current_attention_matched_at = Some(now);
            self.current_attention_fingerprint = Some(current_fp.to_string());
            climon_logging::logger::child("idle").log_with(
                climon_logging::level::LogLevel::Debug,
                serde_json::json!({
                    "sessionId": self.id,
                    "event": "apply_attention",
                    "source": format!("{source:?}"),
                    "status": "needs-attention",
                    "reason": reason,
                }),
                "attention flagged",
            );
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

    /// Writes the initial frames for a client (PtySize, TerminalMode, Replay,
    /// then the current Control frame, optional Exit). Assigns the connection
    /// `seq` used for controller tie-breaking. Returns whether the client was
    /// closed (post-exit path).
    fn write_initial_frames(&mut self, client_id: u64) -> bool {
        match self.clients.get(&client_id) {
            Some(c) if c.in_clients => return false,
            None => return true,
            _ => {}
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        if let Some(c) = self.clients.get_mut(&client_id) {
            c.in_clients = true;
            c.seq = seq;
        }
        self.write_replay(client_id);
        self.update_local_displaced();
        // Tell the newly-connected client (and everyone else, harmlessly) who
        // controls the grid and at what dims.
        self.broadcast_control();
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
        false
    }

    fn handle_disconnect(&mut self, client_id: u64) {
        self.clients.remove(&client_id);
        // If the departing client was the controller, fall back to the next
        // eligible surface; otherwise this is a no-op.
        self.recompute_controller();
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

    // Route this daemon's diagnostics to `$CLIMON_HOME/logs/daemon/<id>.log`
    // (per-session, matching the TS daemon) instead of the shared client log.
    climon_logging::logger::init_logger(
        climon_logging::sinks::LogRole::Daemon,
        climon_logging::logger::LoggerInitOptions {
            session_id: Some(id.to_string()),
            ..Default::default()
        },
    );

    let clamp_browser_to_host = cfg_bool(&config, "terminal", "clampBrowserToHost", false);
    let idle_seconds = cfg_i64(&config, "attention", "idleSeconds", 10);
    let idle_enabled = idle_seconds > 0;
    let snippet_enabled =
        climon_config::features::is_feature_enabled(&config, "smartNotifications");
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
        resizer,
        clients: HashMap::new(),
        clamp_browser_to_host,
        terminal_mode: initial_mode,
        host_cols: meta.cols,
        host_rows: meta.rows,
        applied_cols: meta.cols,
        applied_rows: meta.rows,
        controller_id: None,
        next_seq: 0,
        last_attention_state: None,
        current_attention_matched_at: None,
        current_attention_fingerprint: None,
        host_warning_active: false,
        local_attached: false,
        local_output_suppressed: false,
        local_restore_at: None,
        local_debug_capture_until: None,
        exited: false,
        exit_code: None,
        scrollback: climon_pty::Scrollback::new(SCROLLBACK_CAP),
        grid: HeadlessGrid::new(meta.cols, meta.rows),
        idle_detector: ScreenIdleDetector::new(idle_seconds),
        started_at: Instant::now(),
        mouse_mode_state: HashMap::new(),
        mouse_mode_remainder: String::new(),
        captured_terminal_title: None,
        terminal_title_remainder: String::new(),
        snippet_enabled,
        captured_progress: None,
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

    #[cfg(windows)]
    let _local = local_relay::setup(
        headless,
        Arc::clone(&state),
        Arc::clone(&pty_writer),
        Arc::clone(&shutdown),
    );

    // --- Local-terminal restore watcher ---
    // Fires the deferred clear+replay after a browser viewer shrinks back to the
    // local size (Fill mode). Only needed when an interactive local terminal is
    // attached; headless daemons have no local screen to restore.
    let local_attached = state.lock().unwrap().local_attached;
    let restore_handle = if local_attached {
        if debug_restore_enabled() {
            let logfile = env.logs_dir().join("restore-debug.log");
            // Visible confirmation that the flag is active and where the log
            // lives, so a missing log immediately means "env var not set / not
            // an attached console" rather than "nothing happened yet".
            eprintln!(
                "[climon] CLIMON_DEBUG_RESTORE active -> {}",
                logfile.display()
            );
            let (hc, hr) = {
                let s = state.lock().unwrap();
                (s.host_cols, s.host_rows)
            };
            debug_restore_log(
                &env,
                &format!(
                    "session-start id={id} local_attached=true host={hc}x{hr} real_console={:?}",
                    debug_console_size(),
                ),
            );
        }
        Some(spawn_restore_thread(
            Arc::clone(&state),
            Arc::clone(&shutdown),
        ))
    } else {
        if debug_restore_enabled() {
            eprintln!(
                "[climon] CLIMON_DEBUG_RESTORE set but session is not an attached console; \
                 no restore diagnostics will be written"
            );
        }
        None
    };

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

    // --- Title-capture thread ---
    let title_handle = spawn_title_capture_thread(Arc::clone(&state), Arc::clone(&shutdown));

    // --- Signal handling: SIGTERM/SIGINT kill the child ---
    #[cfg(unix)]
    signals::spawn_kill_thread(pid, Arc::clone(&shutdown));

    // --- Wait for exit ---
    let exit_code = pty.wait().unwrap_or(1);

    // Release the PTY master now that the child has exited. On Windows this is
    // load-bearing: ConPTY keeps the output pipe open (conhost stays alive)
    // until the pseudoconsole is closed, which only happens when the last
    // strong `Arc` to the master is dropped. The reader thread's cloned reader
    // would otherwise never EOF and `reader_handle.join()` below would hang
    // forever (e.g. after the user types `exit`). The `PtyResizer` held in
    // `HostState` is only a `Weak`, so this `drop` is the final strong ref. On
    // Unix the reader already EOFs from the slave drop at spawn, so this is a
    // harmless no-op there.
    drop(pty);

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
    if let Some(h) = restore_handle {
        let _ = h.join();
    }
    let _ = title_handle.join();
    let _ = reader_handle.join();
    for h in conn_threads.lock().unwrap().drain(..) {
        let _ = h.join();
    }

    cleanup_session_socket(&resolved_ref);
    Ok(exit_code)
}

/// The centered notice shown on the in-process local terminal when it is
/// *displaced* — the shared PTY grid is larger than this console, so a surface
/// (dashboard/PWA) is controlling it. Clears the screen and centers a friendly
/// message plus the take-control hint, then pauses local output until control
/// returns (preserving the Windows ConPTY corruption guard).
fn render_local_displaced(_cols: u16, _rows: u16) -> String {
    let (w, h) = debug_console_size();
    let mut out = String::from("\x1b[2J\x1b[H");
    let msg = "This session is being viewed on a climon dashboard.";
    let hint = "Press Ctrl+T to take control and resize it to this terminal.";
    let row = (h / 2).max(1);
    for (i, line) in [msg, hint].iter().enumerate() {
        let col = ((w as usize).saturating_sub(line.len()) / 2 + 1).max(1);
        out.push_str(&format!("\x1b[{};{}H{}", row as usize + i, col, line));
    }
    out
}

/// Writes directly to the local terminal's stdout (locked, flushed). Used for
/// the in-process host's overgrown/restored notices, which originate off the
/// PTY-reader thread.
fn write_local_stdout(bytes: &[u8]) {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    let _ = lock.write_all(bytes);
    let _ = lock.flush();
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
            let suppress_local = {
                let mut s = state.lock().unwrap();
                let remainder = std::mem::take(&mut s.mouse_mode_remainder);
                s.mouse_mode_remainder = track_mouse_private_modes_from_output(
                    &mut s.mouse_mode_state,
                    data,
                    &remainder,
                    TRACKED_MOUSE_PRIVATE_MODES,
                );
                let title_remainder = std::mem::take(&mut s.terminal_title_remainder);
                let mut captured_title = s.captured_terminal_title.take();
                let mut captured_progress = s.captured_progress.take();
                s.terminal_title_remainder = capture_terminal_output(
                    &mut captured_title,
                    &mut captured_progress,
                    data,
                    &title_remainder,
                );
                s.captured_terminal_title = captured_title;
                s.captured_progress = captured_progress;
                s.scrollback.append(data);
                s.grid.write(data);
                s.broadcast(&frame);
                let suppressed = s.local_output_suppressed;
                // Diagnostics: while suppression is pending or just after a
                // restore, log every chunk so one Windows run reveals whether
                // ConPTY's live output (not our repaint) corrupts the screen.
                if debug_restore_enabled() {
                    let pending = s.local_restore_at.is_some();
                    let in_window = s
                        .local_debug_capture_until
                        .map(|t| Instant::now() < t)
                        .unwrap_or(false);
                    if pending || in_window {
                        debug_restore_log(
                            &s.env,
                            &format!(
                                "reader-chunk suppressed={suppressed} pending={pending} window={in_window} n={}: {}",
                                data.len(),
                                debug_escape(data, 2048),
                            ),
                        );
                    }
                }
                suppressed
            };
            // Skip the local write while a browser viewer has grown the shared
            // PTY beyond this terminal (Fill mode): the oversized output would
            // corrupt/blank the local screen. Scrollback, grid, and dashboard
            // viewers above still receive every byte.
            if !headless && !suppress_local {
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
                            kind: SurfaceKind::Dashboard,
                            viewer_id: format!("client-{client_id}"),
                            cols: 0,
                            rows: 0,
                            seq: 0,
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
                        if let Ok(mut size) = parse_json_payload::<ResizePayload>(&frame.payload) {
                            let mut s = state.lock().unwrap();
                            if size.source == Some(ResizeSource::Host) {
                                if let Some(c) = s.clients.get_mut(&client_id) {
                                    c.is_host = true;
                                }
                            } else if let Some(c) = s.clients.get_mut(&client_id) {
                                c.is_viewer = true;
                            }
                            // Stamp this surface's class + stable id from the
                            // resize frame, then route the resize through the
                            // client's id so a dashboard that omits `viewerId` is
                            // never mistaken for the in-process `"local"` surface.
                            if let Some(c) = s.clients.get_mut(&client_id) {
                                if let Some(kind) = size.kind {
                                    c.kind = kind;
                                }
                                if let Some(vid) = size.viewer_id.as_ref().filter(|v| !v.is_empty())
                                {
                                    c.viewer_id = vid.clone();
                                }
                                size.viewer_id = Some(c.viewer_id.clone());
                            }
                            s.apply_resize(size);
                            s.write_initial_frames(client_id);
                        }
                    }
                    FrameType::TakeControl => {
                        let mut s = state.lock().unwrap();
                        let vid = s.clients.get(&client_id).map(|c| c.viewer_id.clone());
                        if let Some(vid) = vid {
                            if !vid.is_empty() {
                                s.take_control(&vid);
                            }
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

/// Watches for a deferred local-terminal restore (browser viewer shrank back to
/// the local size in Fill mode) and, once `local_restore_at` elapses, repaints
/// the local screen from the parsed grid's current state, then resumes live
/// output. Deferring the repaint lets the PTY's resize-repaint burst drain first
/// (see `LOCAL_RESTORE_DELAY`), so the clean grid repaint lands last instead of
/// being clobbered.
/// What the restore watcher should do on a given tick. Extracted as a pure
/// decision (see [`local_restore_decision`]) so the fix — never resuming the
/// local terminal while the PTY is still overgrown — is unit-testable without a
/// live PTY/`HostState`.
#[derive(Debug, PartialEq, Eq)]
enum LocalRestoreDecision {
    /// No restore is pending, or the deferral has not elapsed yet.
    NotDue,
    /// The deferral elapsed but the PTY is still larger than the local console
    /// (a viewer re-grew during the delay): stay suppressed and clear the
    /// pending restore so the next genuine shrink reschedules it.
    SkipOvergrown,
    /// The deferral elapsed and the PTY now fits the local console: repaint the
    /// local screen from the grid and resume live output.
    Repaint,
}

/// Pure decision for the restore watcher. Resuming the local terminal while the
/// PTY is still overgrown is the Windows corruption root cause: ConPTY positions
/// its live output absolutely for the taller grid (e.g. `\e[34;1H` for a 57-row
/// PTY), which stacks lines / overwrites the prompt on the shorter real console.
fn local_restore_decision(
    restore_at: Option<Instant>,
    now: Instant,
    overgrown: bool,
) -> LocalRestoreDecision {
    match restore_at {
        Some(at) if now >= at => {
            if overgrown {
                LocalRestoreDecision::SkipOvergrown
            } else {
                LocalRestoreDecision::Repaint
            }
        }
        _ => LocalRestoreDecision::NotDue,
    }
}

fn spawn_restore_thread(state: Shared, shutdown: Arc<AtomicBool>) -> JoinHandle<()> {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(25));
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        let mut s = state.lock().unwrap();
        if s.exited {
            break;
        }
        let overgrown = s.local_terminal_exceeded();
        match local_restore_decision(s.local_restore_at, Instant::now(), overgrown) {
            LocalRestoreDecision::NotDue => {}
            LocalRestoreDecision::SkipOvergrown => {
                // A viewer re-grew the shared PTY during the delay (Fill mode).
                // Stay suppressed; the next genuine restore transition reschedules
                // via `update_overgrown_warning`.
                if debug_restore_enabled() {
                    debug_restore_log(
                        &s.env,
                        &format!(
                            "restore-skip-overgrown host={}x{} applied={}x{} real_console={:?}",
                            s.host_cols,
                            s.host_rows,
                            s.applied_cols,
                            s.applied_rows,
                            debug_console_size(),
                        ),
                    );
                }
                s.local_restore_at = None;
            }
            LocalRestoreDecision::Repaint => {
                // Repaint the local terminal from the parsed grid's *current*
                // screen, not the raw scrollback: on Windows ConPTY the raw
                // byte stream is a sequence of absolute-positioned screen diffs
                // that stack on top of each other (corrupt/blank) when replayed
                // in bulk to a cleared console. `render_screen()` emits a clean,
                // self-contained repaint (clear + positioned rows + cursor).
                // Write it while still holding the lock and only then unsuppress,
                // so the reader thread cannot interleave a live chunk between
                // resuming output and the repaint landing.
                let out = s.grid.render_screen();
                if debug_restore_enabled() {
                    debug_restore_log(
                        &s.env,
                        &format!(
                            "restore-fire host={}x{} applied={}x{} real_console={:?} render(len={}): {}",
                            s.host_cols,
                            s.host_rows,
                            s.applied_cols,
                            s.applied_rows,
                            debug_console_size(),
                            out.len(),
                            debug_escape(&out, 4096),
                        ),
                    );
                    // Capture the PTY's live output for a window after we
                    // unsuppress, to catch ConPTY's late resize-repaint.
                    s.local_debug_capture_until = Some(Instant::now() + Duration::from_secs(2));
                }
                write_local_stdout(&out);
                s.local_output_suppressed = false;
                s.local_restore_at = None;
            }
        }
    })
}

fn spawn_idle_thread(state: Shared, shutdown: Arc<AtomicBool>) -> JoinHandle<()> {
    thread::spawn(move || {
        let log = climon_logging::logger::child("idle");
        let mut prev_body: Option<String> = None;
        loop {
            thread::sleep(Duration::from_millis(1000));
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            let mut s = state.lock().unwrap();
            if s.exited {
                break;
            }
            let now_ms = s.started_at.elapsed().as_millis() as i64;
            let fp = s.fingerprint();
            let body = fingerprint_body(&fp);
            let body_changed = prev_body.as_deref() != Some(body);
            let settle_until = s.idle_detector.settle_until();
            let was_flagged = s.idle_detector.is_flagged();
            let was_ack = s.idle_detector.is_acknowledged();
            let transition = s.idle_detector.update(&fp, now_ms);
            if body_changed || transition.is_some() {
                log.log_with(
                    climon_logging::level::LogLevel::Debug,
                    serde_json::json!({
                        "sessionId": s.id,
                        "now": now_ms,
                        "settleUntil": settle_until,
                        "withinSettle": now_ms < settle_until,
                        "wasFlagged": was_flagged,
                        "wasAcknowledged": was_ack,
                        "bodyChanged": body_changed,
                        "transition": transition.as_ref().map(|t| if t.needs_attention { "needs-attention" } else { "running" }),
                    }),
                    "idle sample",
                );
            }
            prev_body = Some(body.to_string());
            if let Some(transition) = transition {
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

/// Polls the reader-thread-captured terminal title and progress, persisting them
/// to session metadata, debounced: it wakes every 300ms and writes only when a
/// value actually changed, coalescing bursts of updates to the latest values.
fn spawn_title_capture_thread(state: Shared, shutdown: Arc<AtomicBool>) -> JoinHandle<()> {
    thread::spawn(move || {
        let (env, id) = {
            let s = state.lock().unwrap();
            (s.env.clone(), s.id.clone())
        };
        let mut last_title: Option<String> = None;
        let mut last_progress: Option<Option<TerminalProgress>> = None;
        loop {
            thread::sleep(Duration::from_millis(300));
            let stop = shutdown.load(Ordering::SeqCst);
            let (captured_title, captured_progress) = {
                let s = state.lock().unwrap();
                (s.captured_terminal_title.clone(), s.captured_progress)
            };
            let mut patch = SessionMetaPatch::default();
            let mut dirty = false;
            if let Some(title) = &captured_title {
                if last_title.as_deref() != Some(title.as_str()) {
                    patch.terminal_title = Some(title.clone());
                    last_title = Some(title.clone());
                    dirty = true;
                }
            }
            if let Some(progress) = captured_progress {
                if last_progress != Some(progress) {
                    patch.progress = Some(progress);
                    last_progress = Some(progress);
                    dirty = true;
                }
            }
            if dirty {
                let _ = climon_store::patch::patch_session_meta(&env, &id, patch);
            }
            if stop {
                break;
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

        // The in-process local terminal is the session host. Mark it attached
        // only when stdout is also a real terminal, so displaced-output gating
        // (which pauses local writes) never drops bytes from a redirected
        // stdout. See `HostState::local_attached`. The local terminal is the
        // default controller: it owns the grid until a surface takes control.
        if unsafe { libc::isatty(libc::STDOUT_FILENO) } == 1 {
            let mut s = state.lock().unwrap();
            s.local_attached = true;
            s.controller_id = Some("local".into());
        }

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
                    kind: Some(SurfaceKind::Terminal),
                    viewer_id: Some("local".into()),
                });
            }
        });

        LocalRelay { _raw: raw }
    }
}

#[cfg(windows)]
mod local_relay {
    use super::*;
    use climon_pty::terminal_size;

    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT,
        ENABLE_PROCESSED_INPUT, ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING,
        STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };

    /// RAII guard that restores the console's input/output modes on drop, so the
    /// user's cmd.exe/PowerShell is never left in raw mode after the session.
    ///
    /// Windows counterpart of the unix [`LocalRelay`]: it puts the console input
    /// buffer into raw mode (no line buffering/echo, Ctrl-C forwarded, keys
    /// translated to VT sequences) so local keystrokes reach the PTY, mirroring
    /// the legacy TS client's `stdin.setRawMode(true)`. It also enables VT output
    /// processing so the PTY's escape sequences render. Without it the launching
    /// console stays in cooked mode and only the dashboard can drive the session.
    pub struct LocalRelay {
        in_handle: HANDLE,
        out_handle: HANDLE,
        saved_in: u32,
        saved_out: u32,
        in_active: bool,
        out_active: bool,
    }

    impl Drop for LocalRelay {
        fn drop(&mut self) {
            unsafe {
                if self.in_active {
                    SetConsoleMode(self.in_handle, self.saved_in);
                }
                if self.out_active {
                    SetConsoleMode(self.out_handle, self.saved_out);
                }
            }
        }
    }

    fn inactive() -> LocalRelay {
        LocalRelay {
            in_handle: std::ptr::null_mut(),
            out_handle: std::ptr::null_mut(),
            saved_in: 0,
            saved_out: 0,
            in_active: false,
            out_active: false,
        }
    }

    pub fn setup(
        headless: bool,
        state: Shared,
        pty_writer: Arc<Mutex<Box<dyn Write + Send>>>,
        shutdown: Arc<AtomicBool>,
    ) -> LocalRelay {
        if headless {
            return inactive();
        }

        let (in_handle, out_handle, saved_in, saved_out, out_active) = unsafe {
            let in_handle = GetStdHandle(STD_INPUT_HANDLE);
            if in_handle.is_null() || in_handle == INVALID_HANDLE_VALUE {
                return inactive();
            }
            let mut saved_in: u32 = 0;
            // Fails when stdin is not a console (redirected from a pipe/file):
            // there is no local terminal to relay, so leave the handles alone.
            if GetConsoleMode(in_handle, &mut saved_in) == 0 {
                return inactive();
            }
            let raw_in = (saved_in
                & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT))
                | ENABLE_VIRTUAL_TERMINAL_INPUT;
            if SetConsoleMode(in_handle, raw_in) == 0 {
                return inactive();
            }

            // Best-effort: enable VT output processing so PTY escape sequences
            // render. A failure here must not disable input forwarding.
            let out_handle = GetStdHandle(STD_OUTPUT_HANDLE);
            let mut saved_out: u32 = 0;
            let out_active = !out_handle.is_null()
                && out_handle != INVALID_HANDLE_VALUE
                && GetConsoleMode(out_handle, &mut saved_out) != 0
                && SetConsoleMode(out_handle, saved_out | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0;
            (in_handle, out_handle, saved_in, saved_out, out_active)
        };

        // The in-process local terminal is the session host. Mark it attached
        // only when stdout is a real console (VT output enabled), so
        // displaced-output gating never drops bytes from a redirected stdout.
        // See `HostState::local_attached`. The local terminal is the default
        // controller. Also prime the host/PTY size from the real console: the
        // launcher's `terminal_size()` is unix-only and reports 80x24 on
        // Windows, and the resize poller only fires on a *change*, so without
        // this `host_cols/host_rows` (and the displacement comparison) would be
        // stuck at the bogus launch metadata.
        if out_active {
            let (cols, rows) = terminal_size(std::ptr::null_mut());
            let mut s = state.lock().unwrap();
            s.local_attached = true;
            s.controller_id = Some("local".into());
            s.apply_resize(ResizePayload {
                cols,
                rows,
                source: Some(ResizeSource::Host),
                mode: None,
                kind: Some(SurfaceKind::Terminal),
                viewer_id: Some("local".into()),
            });
        }

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

        // Console-resize poller: Windows has no SIGWINCH, so poll the visible
        // console size and forward a Host resize whenever it changes (parity with
        // the unix SIGWINCH handler). A null handle makes `terminal_size` fall
        // back to STD_OUTPUT_HANDLE, avoiding a non-Send handle in the closure.
        let resize_shutdown = Arc::clone(&shutdown);
        let resize_state = Arc::clone(&state);
        thread::spawn(move || {
            let mut last = terminal_size(std::ptr::null_mut());
            loop {
                if resize_shutdown.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(200));
                let next = terminal_size(std::ptr::null_mut());
                if next != last {
                    last = next;
                    let mut s = resize_state.lock().unwrap();
                    s.apply_resize(ResizePayload {
                        cols: next.0,
                        rows: next.1,
                        source: Some(ResizeSource::Host),
                        mode: None,
                        kind: Some(SurfaceKind::Terminal),
                        viewer_id: Some("local".into()),
                    });
                }
            }
        });

        LocalRelay {
            in_handle,
            out_handle,
            saved_in,
            saved_out,
            in_active: true,
            out_active,
        }
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

#[cfg(test)]
mod restore_decision_tests {
    use super::{local_restore_decision, LocalRestoreDecision};
    use std::time::{Duration, Instant};

    #[test]
    fn not_due_when_no_restore_pending() {
        let now = Instant::now();
        assert_eq!(
            local_restore_decision(None, now, false),
            LocalRestoreDecision::NotDue
        );
        assert_eq!(
            local_restore_decision(None, now, true),
            LocalRestoreDecision::NotDue
        );
    }

    #[test]
    fn not_due_before_deferral_elapses() {
        let now = Instant::now();
        let future = now + Duration::from_millis(250);
        assert_eq!(
            local_restore_decision(Some(future), now, false),
            LocalRestoreDecision::NotDue
        );
    }

    #[test]
    fn repaints_when_due_and_not_overgrown() {
        let now = Instant::now();
        let past = now - Duration::from_millis(1);
        assert_eq!(
            local_restore_decision(Some(past), now, false),
            LocalRestoreDecision::Repaint
        );
    }

    #[test]
    fn skips_when_due_but_still_overgrown() {
        // Regression guard for the Windows corruption: a viewer re-grew the PTY
        // during the deferral, so resuming the local terminal would expose
        // ConPTY's tall-grid absolute-positioned output to the shorter console.
        let now = Instant::now();
        let past = now - Duration::from_millis(1);
        assert_eq!(
            local_restore_decision(Some(past), now, true),
            LocalRestoreDecision::SkipOvergrown
        );
    }
}
