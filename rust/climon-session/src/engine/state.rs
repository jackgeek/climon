//! Aggregate actor state: the pure `(state, event) -> Vec<Effect>` transition
//! that composes the crate-private domain modules into one session actor.
//!
//! [`SessionState::apply`] is the single entry point. It never touches the pty,
//! sockets, console, store, clock, or logging: every interaction with the
//! outside world is returned as an [`Effect`] value, and every external input
//! (including the current time) is delivered as a [`SessionEvent`] plus a
//! [`TransitionContext`]. This keeps the whole session core synchronous and
//! unit-testable; the I/O coordinator/adapters that perform the effects and
//! feed back completion events land in a later task.
//!
//! The aggregate is only reachable from tests and (later) that coordinator, so
//! it carries the same module-level `dead_code` allowance as the effect/event
//! vocabulary it consumes.
#![allow(dead_code)]

use std::collections::HashMap;
use std::time::Duration;

use climon_proto::frame::{
    encode_frame, encode_json_frame, parse_json_payload, AttentionPayload, ControlPayload,
    DecodedFrame, ExitPayload, FrameType, PtySizePayload, ResizePayload, SurfaceKind,
};
use climon_proto::meta::{SessionMeta, SessionMetaPatch, SessionStatus, TerminalProgress};

use crate::domain::attention::AttentionState;
use crate::domain::clients::ClientRegistry;
use crate::domain::control::{ControlChange, ControlState, SurfaceState, LOCAL_ID};
use crate::domain::lifecycle::{FinalizationStep, LifecycleState, StepCompletion};
use crate::domain::local_view::{LocalViewAction, LocalViewState};
use crate::domain::terminal::TerminalModel;
use crate::engine::effect::{ClientId, Effect, OperationId, TimerId};
use crate::engine::event::SessionEvent;

/// Deferred delivery of initial frames after a client connects, giving it a
/// short window to send its first `Resize` so the surface identity/size is
/// known before the (size-dependent) replay lands.
const INITIAL_FRAME_DELAY: Duration = Duration::from_millis(10);
/// Idle-sampling cadence.
const IDLE_INTERVAL: Duration = Duration::from_millis(1000);
/// Title/progress metadata debounce window.
const METADATA_DEBOUNCE: Duration = Duration::from_millis(300);
/// Delay between the two legs of a repaint jiggle.
const JIGGLE_INTERVAL: Duration = Duration::from_millis(25);

/// The wall-clock/monotonic reading supplied to a single transition. The pure
/// state never reads a clock itself; the coordinator stamps every event.
#[derive(Debug, Clone)]
pub(crate) struct TransitionContext {
    /// Monotonic milliseconds since session start (idle-detector clock).
    pub(crate) now_ms: i64,
    /// ISO-8601 wall-clock timestamp (metadata `*_at` fields).
    pub(crate) wall_time: String,
}

/// Static configuration for a session actor, resolved once at construction.
#[derive(Debug, Clone)]
pub(crate) struct SessionStateConfig {
    /// Screen-idle threshold (`<= 0` disables idle attention detection).
    pub(crate) idle_seconds: i64,
    /// Whether smart-notification snippet extraction is enabled.
    pub(crate) snippet_enabled: bool,
    /// Whether the session runs without an interactive local terminal.
    pub(crate) headless: bool,
    /// Scrollback shadow byte cap.
    pub(crate) scrollback_cap: usize,
}

/// What a scheduled [`TimerId`] means when it fires. Typed so a fired timer is
/// routed to exactly one handler without inspecting untyped payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimerPurpose {
    /// Deliver a specific client's initial frames.
    InitialFrame(ClientId),
    /// Sample the idle detector.
    Idle,
    /// Flush the debounced title/progress metadata patch.
    Metadata,
    /// Fire a deferred local-terminal restore.
    LocalRestore,
    /// Run the next leg of a repaint jiggle.
    Jiggle,
}

/// A scheduled timer's purpose plus the generation that makes a stale firing
/// (after a cancel/reschedule) detectable.
#[derive(Debug, Clone, Copy)]
struct TimerEntry {
    purpose: TimerPurpose,
    generation: u64,
}

/// The aggregate session actor state.
pub(crate) struct SessionState {
    id: String,
    config: SessionStateConfig,

    clients: ClientRegistry,
    control: ControlState,
    terminal: TerminalModel,
    attention: AttentionState,
    local_view: LocalViewState,
    lifecycle: LifecycleState,

    current_status: SessionStatus,

    next_operation_id: u64,
    next_timer_id: u64,

    /// Typed purpose + current generation for every live timer id.
    timers: HashMap<TimerId, TimerEntry>,
    idle_timer: TimerId,
    metadata_timer: TimerId,
    restore_timer: TimerId,
    jiggle_timer: TimerId,

    /// Whether a debounced metadata flush is already pending (coalescing).
    metadata_pending: bool,
    /// Latest title/progress values already persisted, so the debounced flush
    /// only patches genuinely changed values.
    persisted_title: Option<String>,
    persisted_progress: Option<Option<TerminalProgress>>,

    /// Whether the local-terminal repaint jiggle already has a live timer.
    jiggle_scheduled: bool,
    /// Whether a shutdown-driven kill has already been requested.
    kill_requested: bool,
    /// Whether the accept loop has already been told to stop.
    accepting_stopped: bool,
}

impl SessionState {
    /// Builds a session actor from `meta`, static `config`, and whether an
    /// interactive local terminal is attached. Lifecycle begins `Running`
    /// (startup supervision lands with the coordinator).
    pub(crate) fn new(
        meta: &SessionMeta,
        config: SessionStateConfig,
        local_attached: bool,
    ) -> Self {
        let cols = meta.cols;
        let rows = meta.rows;
        let local_view = if local_attached {
            LocalViewState::attached(cols, rows)
        } else {
            LocalViewState::headless(cols, rows)
        };
        let mut next_timer_id = 0u64;
        let mut alloc_timer = || {
            let id = TimerId(next_timer_id);
            next_timer_id += 1;
            id
        };
        let idle_timer = alloc_timer();
        let metadata_timer = alloc_timer();
        let restore_timer = alloc_timer();
        let jiggle_timer = alloc_timer();
        SessionState {
            id: meta.id.clone(),
            clients: ClientRegistry::default(),
            control: ControlState::new(cols, rows, local_attached),
            terminal: TerminalModel::new(cols, rows, config.scrollback_cap),
            attention: AttentionState::new(config.idle_seconds, config.snippet_enabled),
            local_view,
            lifecycle: LifecycleState::running(),
            current_status: SessionStatus::Running,
            next_operation_id: 0,
            next_timer_id,
            timers: HashMap::new(),
            idle_timer,
            metadata_timer,
            restore_timer,
            jiggle_timer,
            metadata_pending: false,
            persisted_title: None,
            persisted_progress: None,
            jiggle_scheduled: false,
            kill_requested: false,
            accepting_stopped: false,
            config,
        }
    }

    /// Emits the startup timers (idle sampling) once the actor is live.
    pub(crate) fn start(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        if self.config.idle_seconds > 0 {
            self.schedule_timer(
                self.idle_timer,
                TimerPurpose::Idle,
                IDLE_INTERVAL,
                &mut effects,
            );
        }
        effects
    }

    /// Applies one [`SessionEvent`] against `ctx`, returning the [`Effect`]s the
    /// coordinator must perform. The single, synchronous transition point.
    pub(crate) fn apply(&mut self, event: SessionEvent, ctx: &TransitionContext) -> Vec<Effect> {
        let mut effects = Vec::new();
        match event {
            SessionEvent::PtyOutput(data) => self.on_pty_output(&data, &mut effects),
            SessionEvent::PtyExited(code) => self.on_pty_exited(code, ctx, &mut effects),
            SessionEvent::PtyFailed(error) => self.on_pty_failed(error, ctx, &mut effects),
            SessionEvent::ClientConnected(client_id) => {
                self.on_client_connected(client_id, &mut effects)
            }
            SessionEvent::ClientFrame { client_id, frame } => {
                self.on_client_frame(client_id, frame, ctx, &mut effects)
            }
            SessionEvent::ClientDisconnected(client_id) => {
                self.on_client_gone(client_id, ctx, &mut effects)
            }
            SessionEvent::ClientSendFailed { client_id, .. } => {
                self.on_client_gone(client_id, ctx, &mut effects)
            }
            SessionEvent::LocalInput(bytes) => self.on_local_input(&bytes, ctx, &mut effects),
            SessionEvent::LocalResized { cols, rows } => {
                self.on_local_resized(cols, rows, ctx, &mut effects)
            }
            SessionEvent::ConsoleWriteCompleted(op) => {
                self.on_console_completed(op, ctx, &mut effects)
            }
            SessionEvent::ConsoleWriteFailed { operation_id, .. } => {
                self.on_console_failed(operation_id, ctx, &mut effects)
            }
            SessionEvent::TimerFired {
                timer_id,
                generation,
            } => self.on_timer_fired(timer_id, generation, ctx, &mut effects),
            SessionEvent::MetadataCompleted(op) => {
                self.on_metadata_completed(op, ctx, &mut effects)
            }
            SessionEvent::MetadataFailed { operation_id, .. } => {
                self.on_metadata_completed(operation_id, ctx, &mut effects)
            }
            SessionEvent::ShutdownRequested => self.on_shutdown(&mut effects),
        }
        effects
    }

    // ---- pty output -----------------------------------------------------

    fn on_pty_output(&mut self, data: &[u8], effects: &mut Vec<Effect>) {
        // Terminal model updates first, before any byte is broadcast or written
        // locally, so replay/idle/title state always reflects this chunk.
        let update = self.terminal.apply_output(data);
        self.broadcast(&update.output_frame, effects);
        if self.local_output_enabled() {
            let op = self.next_op();
            effects.push(Effect::WriteConsole {
                operation_id: op,
                bytes: data.to_vec(),
            });
        }
        if update.title_changed || update.progress_changed {
            self.schedule_metadata_flush(effects);
        }
    }

    fn local_output_enabled(&self) -> bool {
        !self.config.headless && !self.local_view.output_suppressed() && !self.local_view.degraded()
    }

    // ---- client lifecycle ----------------------------------------------

    fn on_client_connected(&mut self, client_id: ClientId, effects: &mut Vec<Effect>) {
        self.clients.connect(client_id);
        let timer = self.alloc_timer_id();
        self.schedule_timer(
            timer,
            TimerPurpose::InitialFrame(client_id),
            INITIAL_FRAME_DELAY,
            effects,
        );
    }

    fn on_client_frame(
        &mut self,
        client_id: ClientId,
        frame: DecodedFrame,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        match frame.frame_type {
            FrameType::Resize => {
                if let Ok(payload) = parse_json_payload::<ResizePayload>(&frame.payload) {
                    self.on_client_resize(client_id, payload, ctx, effects);
                }
            }
            FrameType::Input => self.on_client_input(client_id, &frame.payload, ctx, effects),
            FrameType::TakeControl => self.on_take_control_frame(client_id, ctx, effects),
            FrameType::Attention => {
                if let Ok(payload) = parse_json_payload::<AttentionPayload>(&frame.payload) {
                    self.on_attention_frame(client_id, payload, ctx, effects);
                }
            }
            FrameType::Replay => self.write_replay(client_id, effects),
            _ => {}
        }
    }

    /// Accepts input bytes only from the named controller: clears any user
    /// attention (mirroring the legacy host's input-origin acknowledgement) and
    /// then forwards the bytes to the pty. Non-controller input emits nothing.
    fn on_client_input(
        &mut self,
        client_id: ClientId,
        bytes: &[u8],
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        let viewer_id = self.clients.get(client_id).map(|c| c.viewer_id.clone());
        let is_controller = matches!(
            (self.control.controller_id(), viewer_id.as_deref()),
            (Some(controller), Some(viewer)) if controller == viewer
        );
        if !is_controller {
            return;
        }
        self.clear_attention_from_input(ctx, effects);
        let op = self.next_op();
        effects.push(Effect::WritePty {
            operation_id: op,
            bytes: bytes.to_vec(),
        });
    }

    /// Attempts the input-origin user attention acknowledgement, patching
    /// metadata only when [`AttentionState`] accepts the clear.
    fn clear_attention_from_input(&mut self, ctx: &TransitionContext, effects: &mut Vec<Effect>) {
        let fingerprint = self.terminal.fingerprint();
        let visible = self.terminal.visible_lines();
        let cursor = Some(self.terminal.cursor_row() as usize);
        if let Some(transition) = self.attention.apply_user(
            AttentionPayload {
                needs_attention: false,
                reason: Some("input".to_string()),
                attention_matched_at: None,
            },
            &fingerprint,
            ctx.now_ms,
            &ctx.wall_time,
            self.current_status,
            &visible,
            cursor,
        ) {
            self.current_status = transition.status;
            let op = self.next_op();
            effects.push(Effect::PatchMetadata {
                operation_id: op,
                patch: transition.patch,
                barrier: false,
            });
        }
    }

    fn on_client_resize(
        &mut self,
        client_id: ClientId,
        payload: ResizePayload,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        let cols = payload.cols.max(1);
        let rows = payload.rows.max(1);
        let kind = payload.kind.unwrap_or_else(|| {
            self.clients
                .get(client_id)
                .map(|c| c.kind)
                .unwrap_or(SurfaceKind::Dashboard)
        });
        let viewer_raw = payload.viewer_id.unwrap_or_default();
        self.clients
            .update_surface(client_id, &viewer_raw, kind, cols, rows);
        let Some(client) = self.clients.get(client_id) else {
            return;
        };
        let viewer_id = client.viewer_id.clone();
        let seq = client.seq;
        self.control
            .upsert(SurfaceState::new(&viewer_id, kind, cols, rows, seq));

        let change = if self.control.controller_id().is_none() {
            self.control.take_control(&viewer_id)
        } else if self.control.controller_id() == Some(viewer_id.as_str()) {
            self.control.report_surface_size(&viewer_id, cols, rows)
        } else {
            None
        };
        if let Some(change) = change {
            self.apply_grid_change(&change, ctx, effects);
        }
        self.update_local_from_controller(ctx, effects);
        self.broadcast_control(effects);
        self.write_initial_frames(client_id, ctx, effects);
    }

    /// Handles a `TakeControl` frame: promotes the sending client's surface to
    /// controller (delegated to [`ControlState`]).
    fn on_take_control_frame(
        &mut self,
        client_id: ClientId,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        let Some(viewer_id) = self.clients.get(client_id).map(|c| c.viewer_id.clone()) else {
            return;
        };
        if viewer_id.is_empty() {
            return;
        }
        self.perform_take_control(&viewer_id, ctx, effects);
    }

    /// Handles an `Attention` frame: delegates to [`AttentionState`] against the
    /// current terminal fingerprint/visible-grid and, on a transition, emits a
    /// non-barrier metadata patch, then delivers the client's initial frames.
    fn on_attention_frame(
        &mut self,
        client_id: ClientId,
        payload: AttentionPayload,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        let fingerprint = self.terminal.fingerprint();
        let visible = self.terminal.visible_lines();
        let cursor = Some(self.terminal.cursor_row() as usize);
        if let Some(transition) = self.attention.apply_user(
            payload,
            &fingerprint,
            ctx.now_ms,
            &ctx.wall_time,
            self.current_status,
            &visible,
            cursor,
        ) {
            self.current_status = transition.status;
            let op = self.next_op();
            effects.push(Effect::PatchMetadata {
                operation_id: op,
                patch: transition.patch,
                barrier: false,
            });
        }
        self.write_initial_frames(client_id, ctx, effects);
    }

    /// Sends `PtySize` then `Replay` to a single client (initial-frame replay
    /// and on-demand `Replay` requests share this path).
    fn write_replay(&mut self, client_id: ClientId, effects: &mut Vec<Effect>) {
        let (cols, rows) = self.control.applied_size();
        let pty_size = encode_json_frame(FrameType::PtySize, &PtySizePayload { cols, rows });
        self.send_to_client(client_id, &pty_size, effects);
        let replay = encode_frame(FrameType::Replay, &self.terminal.replay_snapshot());
        self.send_to_client(client_id, &replay, effects);
    }

    /// Promotes `viewer_id` to controller and drives the pty to its size. A
    /// non-local surface taking control at the current size (no real resize)
    /// gets a repaint jiggle; the local terminal instead relies on its restore
    /// protocol, so it is excluded here.
    fn perform_take_control(
        &mut self,
        viewer_id: &str,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        let before = self.control.applied_size();
        let Some(change) = self.control.take_control(viewer_id) else {
            return;
        };
        self.apply_grid_change(&change, ctx, effects);
        if viewer_id != LOCAL_ID && self.control.applied_size() == before {
            self.request_jiggle(effects);
        }
        self.update_local_from_controller(ctx, effects);
        self.broadcast_control(effects);
    }

    fn on_client_gone(
        &mut self,
        client_id: ClientId,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        let viewer_id = self.clients.get(client_id).map(|c| c.viewer_id.clone());
        self.clients.remove(client_id);
        if let Some(viewer_id) = viewer_id {
            self.control.remove(&viewer_id);
        }
        if let Some(change) = self.control.recompute() {
            self.apply_grid_change(&change, ctx, effects);
            self.update_local_from_controller(ctx, effects);
            self.broadcast_control(effects);
        }
    }

    /// Delivers a client's ordered initial frames (`PtySize`, `Replay`,
    /// `Control`; plus `Exit`+close once the session has exited). No-op if the
    /// client is unknown or already initialized.
    fn write_initial_frames(
        &mut self,
        client_id: ClientId,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        match self.clients.get(client_id) {
            Some(c) if c.initialized => return,
            None => return,
            _ => {}
        }
        self.clients.mark_initialized(client_id);
        let Some(client) = self.clients.get(client_id) else {
            return;
        };
        let viewer_id = client.viewer_id.clone();
        self.control.upsert(SurfaceState::new(
            &viewer_id,
            client.kind,
            client.cols,
            client.rows,
            client.seq,
        ));

        self.write_replay(client_id, effects);
        self.update_local_from_controller(ctx, effects);
        self.broadcast_control(effects);

        if self.finalizing() {
            if let Some(code) = self.lifecycle.exit_code() {
                let exit = encode_json_frame(FrameType::Exit, &ExitPayload { exit_code: code });
                self.send_to_client(client_id, &exit, effects);
            }
            effects.push(Effect::CloseClient { client_id });
            self.clients.remove(client_id);
            self.control.remove(&viewer_id);
        }
    }

    // ---- grid / control -------------------------------------------------

    /// Applies a controller size change: drives the pty, patches metadata
    /// dimensions, re-baselines idle, and broadcasts the new `PtySize`. Never
    /// touches the local view or the `Control` broadcast (callers own those).
    fn apply_grid_change(
        &mut self,
        change: &ControlChange,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        if !change.size_changed {
            return;
        }
        let op = self.next_op();
        effects.push(Effect::ResizePty {
            operation_id: op,
            cols: change.cols,
            rows: change.rows,
        });
        self.terminal.resize(change.cols, change.rows);
        let fingerprint = self.terminal.fingerprint();
        self.attention.absorb_resize(&fingerprint, ctx.now_ms);
        let op = self.next_op();
        effects.push(Effect::PatchMetadata {
            operation_id: op,
            patch: SessionMetaPatch {
                cols: Some(change.cols),
                rows: Some(change.rows),
                ..Default::default()
            },
            barrier: false,
        });
        let frame = encode_json_frame(
            FrameType::PtySize,
            &PtySizePayload {
                cols: change.cols,
                rows: change.rows,
            },
        );
        self.broadcast(&frame, effects);
    }

    fn broadcast_control(&mut self, effects: &mut Vec<Effect>) {
        let Some(controller_id) = self.control.controller_id().map(str::to_string) else {
            return;
        };
        let (cols, rows) = self.control.applied_size();
        let frame = encode_json_frame(
            FrameType::Control,
            &ControlPayload {
                controller_id,
                cols,
                rows,
            },
        );
        self.broadcast(&frame, effects);
    }

    /// Reconciles the local terminal's displaced/suppressed state with the
    /// current controller, translating the resulting [`LocalViewAction`]s.
    fn update_local_from_controller(&mut self, ctx: &TransitionContext, effects: &mut Vec<Effect>) {
        let controller = self.control.controller_id().unwrap_or(LOCAL_ID).to_string();
        let (cols, rows) = self.control.applied_size();
        let actions = self.local_view.controller_changed(&controller, cols, rows);
        self.translate_local_actions(actions, ctx, effects);
    }

    // ---- broadcast helpers ---------------------------------------------

    fn broadcast(&mut self, frame: &[u8], effects: &mut Vec<Effect>) {
        for client_id in self.clients.broadcast_recipients() {
            let op = self.next_op();
            effects.push(Effect::SendClient {
                client_id,
                operation_id: op,
                bytes: frame.to_vec(),
            });
        }
    }

    fn send_to_client(&mut self, client_id: ClientId, frame: &[u8], effects: &mut Vec<Effect>) {
        let op = self.next_op();
        effects.push(Effect::SendClient {
            client_id,
            operation_id: op,
            bytes: frame.to_vec(),
        });
    }

    // ---- input / local view --------------------------------------------

    /// Routes a chunk of local-terminal stdin through the local view (take
    /// control while displaced / swallow / forward).
    fn on_local_input(&mut self, bytes: &[u8], ctx: &TransitionContext, effects: &mut Vec<Effect>) {
        let action = self.local_view.local_input(bytes);
        self.translate_local_actions(vec![action], ctx, effects);
    }

    /// Reports a local-console resize: drives the pty when the local terminal is
    /// controller, then re-centers the notice or schedules a restore, and
    /// re-broadcasts control.
    fn on_local_resized(
        &mut self,
        cols: u16,
        rows: u16,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        if let Some(change) = self.control.report_local_size(cols, rows) {
            self.apply_grid_change(&change, ctx, effects);
        }
        let controller = self.control.controller_id().map(str::to_string);
        let actions = self
            .local_view
            .local_resized(cols, rows, controller.as_deref());
        self.translate_local_actions(actions, ctx, effects);
        self.broadcast_control(effects);
    }

    fn translate_local_actions(
        &mut self,
        actions: Vec<LocalViewAction>,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        for action in actions {
            match action {
                LocalViewAction::Noop => {}
                LocalViewAction::ShowNotice { cols, rows } => {
                    let op = self.next_op();
                    effects.push(Effect::WriteConsole {
                        operation_id: op,
                        bytes: render_displaced_notice(cols, rows),
                    });
                }
                LocalViewAction::ScheduleRestore { generation, delay } => {
                    self.timers.insert(
                        self.restore_timer,
                        TimerEntry {
                            purpose: TimerPurpose::LocalRestore,
                            generation,
                        },
                    );
                    effects.push(Effect::ScheduleTimer {
                        timer_id: self.restore_timer,
                        generation,
                        delay,
                    });
                }
                LocalViewAction::CancelRestore { generation } => {
                    effects.push(Effect::CancelTimer {
                        timer_id: self.restore_timer,
                        generation,
                    });
                    if let Some(entry) = self.timers.get_mut(&self.restore_timer) {
                        entry.generation = self.local_view.restore_generation();
                    }
                }
                LocalViewAction::WriteRestore {
                    operation_id,
                    bytes,
                } => {
                    effects.push(Effect::WriteConsole {
                        operation_id,
                        bytes,
                    });
                }
                LocalViewAction::TakeControl => {
                    self.perform_take_control(LOCAL_ID, ctx, effects);
                }
                LocalViewAction::ForwardInput(bytes) => {
                    let op = self.next_op();
                    effects.push(Effect::WritePty {
                        operation_id: op,
                        bytes,
                    });
                }
                LocalViewAction::SwallowInput => {}
                LocalViewAction::Degraded => {}
            }
        }
    }

    /// Schedules the two-leg repaint jiggle (coalesced) and arms its 25ms timer.
    fn request_jiggle(&mut self, effects: &mut Vec<Effect>) {
        self.local_view.request_jiggle();
        self.arm_jiggle_timer(effects);
    }

    /// Arms the jiggle timer unless one is already live.
    fn arm_jiggle_timer(&mut self, effects: &mut Vec<Effect>) {
        if self.jiggle_scheduled || !self.local_view.jiggle_pending() {
            return;
        }
        self.jiggle_scheduled = true;
        self.schedule_timer(
            self.jiggle_timer,
            TimerPurpose::Jiggle,
            JIGGLE_INTERVAL,
            effects,
        );
    }

    // ---- console / metadata / timers -----------------------------------

    /// A restore (or exit-time) console write completed. Routes to the
    /// finalization sequence when it matches an in-flight step, otherwise to
    /// the local-view restore protocol (unsuppress + schedule the jiggle).
    fn on_console_completed(
        &mut self,
        op: OperationId,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        if self.complete_finalization_step(op, ctx, effects) {
            return;
        }
        if self.local_view.console_write_completed(op) {
            self.arm_jiggle_timer(effects);
        }
    }

    /// A console write failed. In the finalization sequence it still advances
    /// teardown; otherwise it degrades the local view (no core exit).
    fn on_console_failed(
        &mut self,
        op: OperationId,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        if self.complete_finalization_step(op, ctx, effects) {
            return;
        }
        self.local_view.console_write_failed(op);
    }

    /// A metadata patch completed. Only the exit-time barrier patch is awaited;
    /// every other (fire-and-forget) patch completion is a stale no-op.
    fn on_metadata_completed(
        &mut self,
        op: OperationId,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        self.complete_finalization_step(op, ctx, effects);
    }

    fn on_timer_fired(
        &mut self,
        timer_id: TimerId,
        generation: u64,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) {
        let Some(purpose) = self.resolve_timer(timer_id, generation) else {
            return;
        };
        match purpose {
            TimerPurpose::InitialFrame(client_id) => {
                self.timers.remove(&timer_id);
                self.write_initial_frames(client_id, ctx, effects);
            }
            TimerPurpose::Idle => self.on_idle_timer(ctx, effects),
            TimerPurpose::Metadata => self.on_metadata_timer(effects),
            TimerPurpose::LocalRestore => self.on_restore_timer(ctx, effects),
            TimerPurpose::Jiggle => self.on_jiggle_timer(effects),
        }
    }

    /// Samples the idle detector against the supplied clock, patching a
    /// detected attention transition, then reschedules the 1s sampler while the
    /// session is still running. No-op once finalization has begun.
    fn on_idle_timer(&mut self, ctx: &TransitionContext, effects: &mut Vec<Effect>) {
        if self.finalizing() {
            return;
        }
        let fingerprint = self.terminal.fingerprint();
        let visible = self.terminal.visible_lines();
        let cursor = Some(self.terminal.cursor_row() as usize);
        if let Some(transition) = self.attention.sample(
            &fingerprint,
            ctx.now_ms,
            &ctx.wall_time,
            self.current_status,
            &visible,
            cursor,
        ) {
            self.current_status = transition.status;
            let op = self.next_op();
            effects.push(Effect::PatchMetadata {
                operation_id: op,
                patch: transition.patch,
                barrier: false,
            });
        }
        if !self.finalizing() {
            self.schedule_timer(self.idle_timer, TimerPurpose::Idle, IDLE_INTERVAL, effects);
        }
    }

    fn on_metadata_timer(&mut self, effects: &mut Vec<Effect>) {
        self.metadata_pending = false;
        let mut patch = SessionMetaPatch::default();
        let mut dirty = false;
        if let Some(title) = self.terminal.captured_title() {
            if self.persisted_title.as_deref() != Some(title) {
                patch.terminal_title = Some(title.to_string());
                self.persisted_title = Some(title.to_string());
                dirty = true;
            }
        }
        if let Some(progress) = self.terminal.captured_progress() {
            if self.persisted_progress != Some(progress) {
                patch.progress = Some(progress);
                self.persisted_progress = Some(progress);
                dirty = true;
            }
        }
        if dirty {
            let op = self.next_op();
            effects.push(Effect::PatchMetadata {
                operation_id: op,
                patch,
                barrier: false,
            });
        }
    }

    /// A deferred local restore fired: recompute the overgrown safety, compose
    /// the mouse-restore + host-screen repaint, and hand it to the local view
    /// (which stays suppressed until the resulting console write is confirmed).
    fn on_restore_timer(&mut self, ctx: &TransitionContext, effects: &mut Vec<Effect>) {
        let (applied_cols, applied_rows) = self.control.applied_size();
        let (host_cols, host_rows) = self.local_view.host_size();
        let overgrown = applied_cols > host_cols || applied_rows > host_rows;
        let generation = self.local_view.restore_generation();
        let op = self.next_op();
        let mut repaint = self.terminal.mouse_restore_suffix();
        repaint.extend_from_slice(&self.terminal.render_host_screen(host_cols, host_rows));
        let action = self
            .local_view
            .restore_timer_fired(generation, overgrown, op, repaint);
        self.translate_local_actions(vec![action], ctx, effects);
    }

    /// Runs the next leg of a repaint jiggle: one `ResizePty` computed from the
    /// current applied size, rescheduling until both legs have run.
    fn on_jiggle_timer(&mut self, effects: &mut Vec<Effect>) {
        self.jiggle_scheduled = false;
        let (cols, rows) = self.control.applied_size();
        if let Some((jcols, jrows)) = self.local_view.next_jiggle(cols, rows) {
            let op = self.next_op();
            effects.push(Effect::ResizePty {
                operation_id: op,
                cols: jcols,
                rows: jrows,
            });
        }
        self.arm_jiggle_timer(effects);
    }

    // ---- lifecycle ------------------------------------------------------

    /// The pty exited: begin the ordered finalization sequence (first exit
    /// wins; a later exit or a core failure is ignored).
    fn on_pty_exited(&mut self, code: i32, ctx: &TransitionContext, effects: &mut Vec<Effect>) {
        if self.lifecycle.begin_exit(code) {
            self.begin_finalization(ctx, effects);
        }
    }

    /// An unrecoverable pty/core failure: begin finalization with exit code 1
    /// and the error carried in the terminal patch (first failure wins).
    fn on_pty_failed(&mut self, error: String, ctx: &TransitionContext, effects: &mut Vec<Effect>) {
        if self.lifecycle.begin_core_failure(error) {
            self.begin_finalization(ctx, effects);
        }
    }

    /// A graceful shutdown was requested: kill the pty once, unless the session
    /// is already finalizing (the pending exit will tear everything down).
    fn on_shutdown(&mut self, effects: &mut Vec<Effect>) {
        if self.finalizing() || self.kill_requested {
            return;
        }
        self.kill_requested = true;
        let op = self.next_op();
        effects.push(Effect::KillPty { operation_id: op });
    }

    fn begin_finalization(&mut self, ctx: &TransitionContext, effects: &mut Vec<Effect>) {
        if !self.accepting_stopped {
            self.accepting_stopped = true;
            effects.push(Effect::StopAcceptingClients);
        }
        self.drive_finalization(ctx, effects);
    }

    /// Advances the finalization sequence as far as it can without awaiting an
    /// external completion. Steps with a durable/console await (the terminal
    /// status barrier patch, an optional local restore write) stop the pump
    /// until their completion event arrives; fire-and-forget steps (scrollback
    /// persistence, exit-frame sends) complete synchronously.
    fn drive_finalization(&mut self, ctx: &TransitionContext, effects: &mut Vec<Effect>) {
        while let Some(step) = self.lifecycle.next_step() {
            match step {
                FinalizationStep::PersistScrollback => {
                    let op = self.next_op();
                    self.lifecycle.start_step(step, op);
                    effects.push(Effect::PersistScrollback {
                        operation_id: op,
                        bytes: self.terminal.scrollback_snapshot(),
                    });
                    self.lifecycle.complete_step(op);
                }
                FinalizationStep::PatchTerminalStatus => {
                    let op = self.next_op();
                    self.lifecycle.start_step(step, op);
                    if let Some((status, _)) = self.lifecycle.terminal_status() {
                        self.current_status = status;
                    }
                    if let Some(patch) = self.lifecycle.terminal_patch(&ctx.wall_time) {
                        effects.push(Effect::PatchMetadata {
                            operation_id: op,
                            patch,
                            barrier: true,
                        });
                    }
                    return;
                }
                FinalizationStep::SendExitFrames => {
                    let op = self.next_op();
                    self.lifecycle.start_step(step, op);
                    if let Some(code) = self.lifecycle.exit_code() {
                        let frame =
                            encode_json_frame(FrameType::Exit, &ExitPayload { exit_code: code });
                        self.broadcast(&frame, effects);
                    }
                    self.lifecycle.complete_step(op);
                }
                FinalizationStep::RestoreLocalScreen => {
                    if let Some(bytes) = self.exit_restore_bytes() {
                        let op = self.next_op();
                        self.lifecycle.start_step(step, op);
                        effects.push(Effect::WriteConsole {
                            operation_id: op,
                            bytes,
                        });
                        return;
                    }
                    self.lifecycle.complete_without_effect(step);
                }
                FinalizationStep::CloseClients => {
                    for client_id in self.clients.ids() {
                        effects.push(Effect::CloseClient { client_id });
                    }
                    self.lifecycle.complete_without_effect(step);
                    if let Some(code) = self.lifecycle.exit_code() {
                        effects.push(Effect::CompleteSession { exit_code: code });
                    }
                    return;
                }
            }
        }
    }

    /// The exit-time local restore bytes, when an interactive local terminal is
    /// attached and still suppressed (displaced) at exit; `None` otherwise.
    fn exit_restore_bytes(&self) -> Option<Vec<u8>> {
        if self.config.headless
            || !self.local_view.output_suppressed()
            || self.local_view.degraded()
        {
            return None;
        }
        let (host_cols, host_rows) = self.local_view.host_size();
        let mut bytes = self.terminal.mouse_restore_suffix();
        bytes.extend_from_slice(&self.terminal.render_host_screen(host_cols, host_rows));
        Some(bytes)
    }

    /// Advances the exit finalization sequence when `op` matches its in-flight
    /// step. Returns whether a finalization step was completed.
    fn complete_finalization_step(
        &mut self,
        op: OperationId,
        ctx: &TransitionContext,
        effects: &mut Vec<Effect>,
    ) -> bool {
        if self.lifecycle.complete_step(op) == StepCompletion::Completed {
            self.drive_finalization(ctx, effects);
            true
        } else {
            false
        }
    }

    fn finalizing(&self) -> bool {
        self.lifecycle.exit_code().is_some()
    }

    // ---- metadata debounce ---------------------------------------------

    fn schedule_metadata_flush(&mut self, effects: &mut Vec<Effect>) {
        if self.metadata_pending {
            return;
        }
        self.metadata_pending = true;
        self.schedule_timer(
            self.metadata_timer,
            TimerPurpose::Metadata,
            METADATA_DEBOUNCE,
            effects,
        );
    }

    // ---- id / timer helpers --------------------------------------------

    fn next_op(&mut self) -> OperationId {
        let id = self.next_operation_id;
        self.next_operation_id += 1;
        OperationId(id)
    }

    fn alloc_timer_id(&mut self) -> TimerId {
        let id = self.next_timer_id;
        self.next_timer_id += 1;
        TimerId(id)
    }

    fn schedule_timer(
        &mut self,
        timer_id: TimerId,
        purpose: TimerPurpose,
        delay: Duration,
        effects: &mut Vec<Effect>,
    ) {
        let generation = self
            .timers
            .get(&timer_id)
            .map(|e| e.generation + 1)
            .unwrap_or(0);
        self.timers.insert(
            timer_id,
            TimerEntry {
                purpose,
                generation,
            },
        );
        effects.push(Effect::ScheduleTimer {
            timer_id,
            generation,
            delay,
        });
    }

    fn resolve_timer(&self, timer_id: TimerId, generation: u64) -> Option<TimerPurpose> {
        match self.timers.get(&timer_id) {
            Some(entry) if entry.generation == generation => Some(entry.purpose),
            _ => None,
        }
    }
}

/// Renders the take-control notice a displaced local terminal shows, centered
/// at the local console's `cols`x`rows`. Pure counterpart to the legacy host's
/// `render_local_displaced`, which reads the live console size for its layout.
fn render_displaced_notice(cols: u16, rows: u16) -> Vec<u8> {
    let mut out = String::from("\x1b[m\x1b[H\x1b[J");
    let msg = "This session is being viewed on a climon dashboard.";
    let hint = "Press Space to take control.";
    let width = cols.max(1) as usize;
    let row = (rows / 2).max(1) as usize;
    for (i, line) in [msg, hint].iter().enumerate() {
        let col = (width.saturating_sub(line.len()) / 2 + 1).max(1);
        out.push_str(&format!("\x1b[{};{}H{}", row + i, col, line));
    }
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use climon_proto::frame::{
        parse_json_payload, ControlPayload, FrameDecoder, FrameType, PtySizePayload, SurfaceKind,
    };

    use crate::test_support::harness::ActorHarness;

    fn frame_types(effects: &[crate::engine::effect::Effect], client_id: u64) -> Vec<FrameType> {
        effects
            .iter()
            .filter_map(|e| e.client_target())
            .filter(|(cid, _)| *cid == client_id)
            .map(|(_, bytes)| FrameDecoder::new().push(bytes)[0].frame_type)
            .collect()
    }

    #[test]
    fn pty_output_updates_state_before_broadcast_and_local_write() {
        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        let effects = harness.pty_output(b"hello");
        let client = effects
            .iter()
            .find_map(|e| e.client_bytes())
            .expect("client output");
        let decoded = FrameDecoder::new().push(client);
        assert_eq!(decoded[0].frame_type, FrameType::Output);
        assert_eq!(decoded[0].payload, b"hello");
        assert!(harness
            .state()
            .terminal
            .replay_snapshot()
            .ends_with(b"hello"));
    }

    #[test]
    fn controller_resize_emits_ordered_effects_and_metadata_dimensions() {
        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        let effects = harness.resize(1, "dash", SurfaceKind::Dashboard, 100, 30);
        assert_eq!(effects.len(), 4, "resize effects: {effects:?}");
        assert_eq!(effects[0].pty_resize(), Some((100, 30)));
        let (patch, barrier) = effects[1].metadata().expect("metadata patch");
        assert!(!barrier, "dimension patch is not a barrier");
        assert_eq!(patch.cols, Some(100));
        assert_eq!(patch.rows, Some(30));
        let (cid, bytes) = effects[2].client_target().expect("pty size frame");
        assert_eq!(cid, 1);
        let decoded = FrameDecoder::new().push(bytes);
        assert_eq!(decoded[0].frame_type, FrameType::PtySize);
        let size: PtySizePayload = parse_json_payload(&decoded[0].payload).unwrap();
        assert_eq!((size.cols, size.rows), (100, 30));
        let (cid, bytes) = effects[3].client_target().expect("control frame");
        assert_eq!(cid, 1);
        let decoded = FrameDecoder::new().push(bytes);
        assert_eq!(decoded[0].frame_type, FrameType::Control);
        let control: ControlPayload = parse_json_payload(&decoded[0].payload).unwrap();
        assert_eq!(control.controller_id, "dash");
        assert_eq!((control.cols, control.rows), (100, 30));
    }

    #[test]
    fn second_client_initial_frames_are_pty_size_replay_control_in_order() {
        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 100, 30);
        let effects = harness.connect_initialized_dashboard(2, "dash2", 100, 30);
        assert_eq!(
            frame_types(&effects, 2),
            vec![FrameType::PtySize, FrameType::Replay, FrameType::Control]
        );
    }

    #[test]
    fn client_without_resize_initializes_on_ten_ms_timer() {
        let mut harness = ActorHarness::headless();
        harness.connect(1);
        let effects = harness.fire_timer_delay(Duration::from_millis(10));
        // No controller yet, so no Control frame is broadcast on init.
        assert_eq!(
            frame_types(&effects, 1),
            vec![FrameType::PtySize, FrameType::Replay]
        );
        // The client is now an initialized broadcast recipient.
        let output = harness.pty_output(b"x");
        assert_eq!(
            output
                .iter()
                .filter_map(|e| e.client_target())
                .map(|(cid, _)| cid)
                .collect::<Vec<_>>(),
            vec![1]
        );
    }

    #[test]
    fn broadcast_reaches_only_initialized_clients_with_unique_ops_and_shared_bytes() {
        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        harness.connect_initialized_dashboard(2, "dash2", 80, 24);
        harness.connect(3); // connected but never initialized
        let effects = harness.pty_output(b"shared");
        let sends: Vec<(u64, &[u8])> = effects.iter().filter_map(|e| e.client_target()).collect();
        assert_eq!(sends.len(), 2, "only initialized clients: {effects:?}");
        assert_eq!(
            sends[0].1, sends[1].1,
            "same frame bytes for all recipients"
        );
        let ops: Vec<_> = effects.iter().filter_map(|e| e.operation_id()).collect();
        assert_eq!(ops.len(), 2);
        assert_ne!(ops[0], ops[1], "each send gets a unique operation id");
    }

    #[test]
    fn socket_input_from_controller_forwards_to_pty_in_order() {
        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        let first = harness.client_input(1, b"first");
        let second = harness.client_input(1, b"second");
        assert_eq!(
            first
                .iter()
                .filter_map(|e| e.pty_input())
                .collect::<Vec<_>>(),
            vec![b"first".as_slice()]
        );
        assert_eq!(
            second
                .iter()
                .filter_map(|e| e.pty_input())
                .collect::<Vec<_>>(),
            vec![b"second".as_slice()]
        );
    }

    #[test]
    fn socket_input_from_non_controller_is_ignored() {
        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        harness.connect_initialized_dashboard(2, "dash2", 80, 24);
        let effects = harness.client_input(2, b"nope");
        assert!(
            effects.is_empty(),
            "non-controller input ignored: {effects:?}"
        );
    }

    #[test]
    fn matching_user_attention_acknowledgement_emits_acknowledged_patch() {
        use climon_proto::frame::AttentionPayload;
        use climon_proto::meta::SessionStatus;

        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        harness.set_clock(0, "2026-07-17T20:00:00.000Z");
        let flagged = harness.attention(
            1,
            &AttentionPayload {
                needs_attention: true,
                reason: Some("manual".to_string()),
                attention_matched_at: None,
            },
        );
        let (patch, barrier) = flagged
            .iter()
            .find_map(|e| e.metadata())
            .expect("flag patch");
        assert!(!barrier);
        assert_eq!(patch.status, Some(SessionStatus::NeedsAttention));

        harness.set_clock(1_000, "2026-07-17T20:00:01.000Z");
        let ack = harness.attention(
            1,
            &AttentionPayload {
                needs_attention: false,
                reason: None,
                attention_matched_at: Some("2026-07-17T20:00:00.000Z".to_string()),
            },
        );
        let (patch, barrier) = ack.iter().find_map(|e| e.metadata()).expect("ack patch");
        assert!(!barrier, "acknowledgement patch is not a barrier");
        assert_eq!(patch.status, Some(SessionStatus::Acknowledged));
        assert_eq!(patch.attention_matched_at, Some(None));
    }

    #[test]
    fn replay_request_sends_pty_size_then_replay_to_requester() {
        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 100, 30);
        harness.pty_output(b"content");
        let effects = harness.replay_request(1);
        assert_eq!(
            frame_types(&effects, 1),
            vec![FrameType::PtySize, FrameType::Replay]
        );
    }

    #[test]
    fn same_size_nonlocal_take_control_schedules_two_leg_jiggle() {
        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        // dash already controls at 80x24; taking control at the same size emits no
        // real resize, so a two-leg jiggle nudges the app to repaint.
        harness.take_control(1);
        let leg1 = harness.fire_timer_delay(Duration::from_millis(25));
        assert_eq!(
            leg1.iter()
                .filter_map(|e| e.pty_resize())
                .collect::<Vec<_>>(),
            vec![(79, 23)]
        );
        let leg2 = harness.fire_timer_delay(Duration::from_millis(25));
        assert_eq!(
            leg2.iter()
                .filter_map(|e| e.pty_resize())
                .collect::<Vec<_>>(),
            vec![(80, 24)]
        );
        assert!(
            harness.live_timer(Duration::from_millis(25)).is_none(),
            "jiggle completes after the back leg"
        );
    }

    #[test]
    fn departing_controller_falls_back_to_next_surface() {
        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 100, 30);
        harness.connect(2);
        harness.resize(2, "pwa", SurfaceKind::Pwa, 90, 28);
        let effects = harness.disconnect(1);
        assert!(
            effects.iter().any(|e| e.pty_resize() == Some((90, 28))),
            "fallback resizes to the new controller: {effects:?}"
        );
        let control = effects
            .iter()
            .filter_map(|e| e.client_target())
            .filter_map(|(_, bytes)| {
                let decoded = FrameDecoder::new().push(bytes);
                (decoded[0].frame_type == FrameType::Control)
                    .then(|| parse_json_payload::<ControlPayload>(&decoded[0].payload).unwrap())
            })
            .next()
            .expect("control frame");
        assert_eq!(control.controller_id, "pwa");
        assert_eq!((control.cols, control.rows), (90, 28));
    }

    #[test]
    fn title_and_progress_flush_as_one_debounced_patch_at_300ms() {
        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        let first = harness.pty_output(b"\x1b]0;first\x07");
        assert!(
            first.iter().find_map(|e| e.metadata()).is_none(),
            "title is not patched immediately"
        );
        assert!(
            harness.live_timer(Duration::from_millis(300)).is_some(),
            "metadata debounce timer scheduled"
        );
        let second = harness.pty_output(b"\x1b]0;second\x07");
        assert!(
            second.iter().find_map(|e| e.metadata()).is_none(),
            "second title change coalesces into the pending timer"
        );
        let flush = harness.fire_timer_delay(Duration::from_millis(300));
        let (patch, barrier) = flush
            .iter()
            .find_map(|e| e.metadata())
            .expect("debounced metadata patch");
        assert!(!barrier);
        assert_eq!(patch.terminal_title.as_deref(), Some("second"));
        // Nothing further changed, so no timer is rescheduled.
        assert!(harness.live_timer(Duration::from_millis(300)).is_none());
    }

    #[test]
    fn idle_timer_flags_attention_and_reschedules_each_second() {
        use climon_proto::meta::SessionStatus;

        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        harness.set_clock(0, "2026-07-17T20:00:00.000Z");
        let baseline = harness.fire_timer_delay(Duration::from_millis(1000));
        assert!(
            baseline.iter().find_map(|e| e.metadata()).is_none(),
            "first sample only baselines the detector"
        );
        assert!(
            harness.live_timer(Duration::from_millis(1000)).is_some(),
            "idle timer reschedules while running"
        );
        harness.set_clock(10_000, "2026-07-17T20:00:10.000Z");
        let flagged = harness.fire_timer_delay(Duration::from_millis(1000));
        let (patch, barrier) = flagged
            .iter()
            .find_map(|e| e.metadata())
            .expect("idle attention patch");
        assert!(!barrier);
        assert_eq!(patch.status, Some(SessionStatus::NeedsAttention));
        assert!(harness.live_timer(Duration::from_millis(1000)).is_some());
    }

    #[test]
    fn local_restore_stays_suppressed_until_console_write_completes() {
        let mut harness = ActorHarness::attached();
        harness.connect(2);
        harness.resize(2, "dash", SurfaceKind::Dashboard, 120, 40);
        // Dashboard seizes the (larger) grid: the local terminal is displaced.
        harness.take_control(2);
        assert!(
            harness.state().local_view.output_suppressed(),
            "displaced local terminal is suppressed"
        );
        // Space reclaims control to the local terminal, scheduling a restore.
        harness.local_input(b" ");
        assert!(
            harness.state().local_view.output_suppressed(),
            "output stays suppressed while the restore is pending"
        );
        let restore = harness.fire_timer_delay(Duration::from_millis(250));
        let op = restore
            .iter()
            .find(|e| e.console_bytes().is_some())
            .and_then(|e| e.operation_id())
            .expect("restore console write");
        assert!(
            harness.state().local_view.output_suppressed(),
            "output stays suppressed until the console write is confirmed"
        );
        harness.console_completed(op);
        assert!(
            !harness.state().local_view.output_suppressed(),
            "console completion resumes local output"
        );
    }

    fn barrier_metadata_op(
        effects: &[crate::engine::effect::Effect],
    ) -> crate::engine::effect::OperationId {
        effects
            .iter()
            .find(|e| e.metadata().map(|(_, barrier)| barrier).unwrap_or(false))
            .and_then(|e| e.operation_id())
            .expect("barrier metadata patch")
    }

    fn is_exit_frame(effect: &crate::engine::effect::Effect) -> bool {
        effect
            .client_target()
            .map(|(_, bytes)| FrameDecoder::new().push(bytes)[0].frame_type == FrameType::Exit)
            .unwrap_or(false)
    }

    #[test]
    fn pty_exit_emits_ordered_finalization_and_completes_session() {
        use climon_proto::meta::SessionStatus;

        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        let started = harness.pty_exited(0);
        let stop = started
            .iter()
            .position(|e| e.is_stop_accepting())
            .expect("stop accepting clients");
        let persist = started
            .iter()
            .position(|e| e.scrollback_bytes().is_some())
            .expect("persist scrollback");
        let patch_pos = started
            .iter()
            .position(|e| e.metadata().is_some())
            .expect("terminal patch");
        assert!(stop < persist && persist < patch_pos, "order: {started:?}");
        let (patch, barrier) = started[patch_pos].metadata().unwrap();
        assert!(barrier, "terminal status patch is a barrier");
        assert_eq!(patch.status, Some(SessionStatus::Completed));
        assert!(
            started.iter().find_map(|e| e.complete_code()).is_none(),
            "no completion until the barrier resolves"
        );
        assert!(!started.iter().any(is_exit_frame), "no exit frames yet");

        let finished = harness.metadata_completed(barrier_metadata_op(&started));
        let exit_pos = finished
            .iter()
            .position(is_exit_frame)
            .expect("exit frame to client");
        let close_pos = finished
            .iter()
            .position(|e| e.close_client() == Some(1))
            .expect("close client");
        let complete_pos = finished
            .iter()
            .position(|e| e.complete_code() == Some(0))
            .expect("complete session");
        assert!(
            exit_pos < close_pos && close_pos < complete_pos,
            "order: {finished:?}"
        );
    }

    #[test]
    fn pty_failure_finalizes_with_exit_code_one_and_error() {
        use climon_proto::meta::SessionStatus;

        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        let started = harness.pty_failed("spawn failed");
        let (patch, barrier) = started.iter().find_map(|e| e.metadata()).expect("patch");
        assert!(barrier);
        assert_eq!(patch.status, Some(SessionStatus::Failed));
        assert_eq!(patch.exit_code, Some(1));
        assert_eq!(patch.error.as_deref(), Some("spawn failed"));
        let finished = harness.metadata_completed(barrier_metadata_op(&started));
        assert_eq!(finished.iter().find_map(|e| e.complete_code()), Some(1));
    }

    #[test]
    fn attached_displaced_exit_writes_shared_local_restore_to_console() {
        use std::collections::HashMap;

        use crate::domain::local_view::local_exit_restore_bytes;
        use crate::test_support::trace::ObservableTrace;

        // The local terminal is attached at the host's 80x24; a dashboard then
        // seizes a larger grid, displacing (suppressing) the local terminal.
        let mut harness = ActorHarness::attached();
        harness.connect(2);
        harness.resize(2, "dash", SurfaceKind::Dashboard, 120, 40);
        harness.take_control(2);
        assert!(
            harness.state().local_view.output_suppressed(),
            "dashboard control displaces the local terminal"
        );

        // The command exits while the local terminal is still displaced.
        // Finalization pauses on the terminal-status barrier; resolving it drives
        // the ordered exit-frame send and then the local-screen restore write.
        let started = harness.pty_exited(0);
        let finished = harness.metadata_completed(barrier_metadata_op(&started));

        let mut trace = ObservableTrace::default();
        for effect in &finished {
            trace.record_effect(effect);
        }

        // The bytes the actor writes to the local console equal the shared
        // `local_exit_restore_bytes` the legacy host writes at exit for the same
        // displaced local terminal (an empty scrollback rebuilt at the host size,
        // with no mouse modes to reassert), proving byte-for-byte parity on the
        // displaced-exit local-restore path.
        let expected = local_exit_restore_bytes(true, true, &[], 80, 24, &HashMap::new())
            .expect("a displaced local terminal restores at exit");
        assert_eq!(
            trace.console_bytes(),
            expected,
            "actor's displaced-exit local restore matches the legacy shared bytes"
        );
    }

    #[test]
    fn shutdown_kills_pty_once_and_never_while_finalizing() {
        let mut harness = ActorHarness::headless();
        let first = harness.shutdown();
        assert_eq!(first.iter().filter(|e| e.is_kill_pty()).count(), 1);
        let second = harness.shutdown();
        assert!(!second.iter().any(|e| e.is_kill_pty()), "kill emitted once");
        harness.pty_exited(0);
        let after_exit = harness.shutdown();
        assert!(!after_exit.iter().any(|e| e.is_kill_pty()));
    }

    #[test]
    fn stale_timer_generation_is_ignored() {
        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        harness.set_clock(0, "2026-07-17T20:00:00.000Z");
        let (idle_id, stale_gen) = harness.live_timer(Duration::from_millis(1000)).unwrap();
        harness.fire_timer_delay(Duration::from_millis(1000)); // reschedules to a newer generation
        let stale = harness.fire_timer(idle_id, stale_gen);
        assert!(stale.is_empty(), "stale timer firing is ignored: {stale:?}");
    }

    #[test]
    fn stale_console_completion_is_ignored() {
        use crate::engine::effect::OperationId;

        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        let effects = harness.console_completed(OperationId(9_999));
        assert!(
            effects.is_empty(),
            "unmatched console completion is a no-op: {effects:?}"
        );
    }

    #[test]
    fn client_send_failure_isolates_the_client_and_falls_back() {
        use crate::engine::effect::OperationId;

        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 100, 30);
        harness.connect(2);
        harness.resize(2, "pwa", SurfaceKind::Pwa, 90, 28);
        let effects = harness.send_failed(1, OperationId(0));
        assert!(
            effects.iter().any(|e| e.pty_resize() == Some((90, 28))),
            "isolating the controller falls back to the next surface: {effects:?}"
        );
    }

    #[test]
    fn local_resize_while_displaced_recenters_the_notice() {
        let mut harness = ActorHarness::attached();
        harness.connect(2);
        harness.resize(2, "dash", SurfaceKind::Dashboard, 120, 40);
        harness.take_control(2); // local displaced, notice at 80x24
        let effects = harness.local_resized(100, 30);
        assert!(
            effects.iter().any(|e| e.console_bytes().is_some()),
            "notice re-renders at the new console size: {effects:?}"
        );
    }

    #[test]
    fn restore_console_failure_degrades_local_view_without_core_exit() {
        let mut harness = ActorHarness::attached();
        harness.connect(2);
        harness.resize(2, "dash", SurfaceKind::Dashboard, 120, 40);
        harness.take_control(2);
        harness.local_input(b" ");
        let restore = harness.fire_timer_delay(Duration::from_millis(250));
        let op = restore
            .iter()
            .find(|e| e.console_bytes().is_some())
            .and_then(|e| e.operation_id())
            .expect("restore console write");
        let effects = harness.console_failed(op);
        assert!(
            effects.iter().all(|e| e.complete_code().is_none()),
            "a failed restore never completes the session"
        );
        assert!(
            harness.state().local_view.degraded(),
            "restore failure degrades the local view"
        );
        assert!(
            harness.state().local_view.output_suppressed(),
            "a degraded local view stays suppressed"
        );
    }
}
