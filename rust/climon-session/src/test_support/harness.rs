//! Deterministic in-process harness that drives [`SessionState`] one event at a
//! time for the actor engine's transition tests.
//!
//! The harness owns a [`SessionState`] plus a fixed [`TransitionContext`] (the
//! clock the pure state is never allowed to read itself) and mirrors the small
//! set of external inputs a coordinator would deliver: pty output, client
//! frames, local input/resize, timer firings, and effect completions. It also
//! tracks every scheduled timer so a test can fire one deterministically by its
//! delay without reaching into the state's private bookkeeping.
//!
//! [`SessionState`]: crate::engine::state::SessionState

use std::collections::HashMap;
use std::time::Duration;

use climon_proto::frame::{
    encode_json_frame, AttentionPayload, DecodedFrame, FrameType, ResizePayload, SurfaceKind,
};
use climon_proto::meta::{PriorityReason, SessionMeta, SessionMetaPatch, SessionStatus};

use crate::engine::effect::{ClientId, Effect, OperationId, TimerId};
use crate::engine::event::SessionEvent;
use crate::engine::state::{SessionState, SessionStateConfig, TransitionContext};

/// Builds the deterministic base [`SessionMeta`] every harness session starts
/// from: an 80x24 running session with a fixed id, so replay/idle/control math
/// is reproducible.
pub(crate) fn base_meta() -> SessionMeta {
    SessionMeta {
        id: "harness-session".to_string(),
        command: vec!["sh".to_string()],
        display_command: "sh".to_string(),
        cwd: "/".to_string(),
        status: SessionStatus::Running,
        priority_reason: PriorityReason::Running,
        daemon_pid: None,
        cols: 80,
        rows: 24,
        headless: None,
        socket_path: "tcp://127.0.0.1:0".to_string(),
        client_version: None,
        created_at: "1970-01-01T00:00:00.000Z".to_string(),
        updated_at: "1970-01-01T00:00:00.000Z".to_string(),
        last_activity_at: "1970-01-01T00:00:00.000Z".to_string(),
        attention_matched_at: None,
        attention_reason: None,
        completed_at: None,
        exit_code: None,
        error: None,
        origin: None,
        client_label: None,
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

pub(crate) fn base_config(local_attached: bool) -> SessionStateConfig {
    SessionStateConfig {
        idle_seconds: 10,
        snippet_enabled: false,
        headless: !local_attached,
        scrollback_cap: 256 * 1024,
    }
}

/// Drives a [`SessionState`] deterministically for transition tests.
pub(crate) struct ActorHarness {
    state: SessionState,
    ctx: TransitionContext,
    /// Live scheduled timers: `timer_id -> (generation, delay)`.
    timers: HashMap<TimerId, (u64, Duration)>,
}

impl ActorHarness {
    /// A headless session (no interactive local terminal).
    pub(crate) fn headless() -> Self {
        Self::build(false)
    }

    /// A session with an interactive local terminal attached.
    pub(crate) fn attached() -> Self {
        Self::build(true)
    }

    fn build(local_attached: bool) -> Self {
        let meta = base_meta();
        let mut state = SessionState::new(&meta, base_config(local_attached), local_attached);
        let init = state.start();
        let mut harness = ActorHarness {
            state,
            ctx: TransitionContext {
                now_ms: 0,
                wall_time: "1970-01-01T00:00:00.000Z".to_string(),
            },
            timers: HashMap::new(),
        };
        harness.record(&init);
        harness
    }

    /// Sets the transition clock (monotonic ms + ISO wall time) for subsequent
    /// events.
    pub(crate) fn set_clock(&mut self, now_ms: i64, wall_time: &str) {
        self.ctx.now_ms = now_ms;
        self.ctx.wall_time = wall_time.to_string();
    }

    /// Applies one event against the current clock, recording any scheduled or
    /// cancelled timers for later [`Self::fire_timer_delay`] calls.
    pub(crate) fn apply(&mut self, event: SessionEvent) -> Vec<Effect> {
        let effects = self.state.apply(event, &self.ctx);
        self.record(&effects);
        effects
    }

    /// Borrows the underlying state for post-transition assertions.
    pub(crate) fn state(&self) -> &SessionState {
        &self.state
    }

    // ---- event drivers --------------------------------------------------

    /// Feeds a chunk of pty output.
    pub(crate) fn pty_output(&mut self, data: &[u8]) -> Vec<Effect> {
        self.apply(SessionEvent::PtyOutput(data.to_vec()))
    }

    /// Connects a client (schedules its 10ms initial-frames timer).
    pub(crate) fn connect(&mut self, id: u64) -> Vec<Effect> {
        self.apply(SessionEvent::ClientConnected(ClientId(id)))
    }

    /// Sends a decoded frame from a client.
    pub(crate) fn client_frame(&mut self, id: u64, frame: DecodedFrame) -> Vec<Effect> {
        self.apply(SessionEvent::ClientFrame {
            client_id: ClientId(id),
            frame,
        })
    }

    /// Sends a `Resize` frame carrying a surface identity/kind/size.
    pub(crate) fn resize(
        &mut self,
        id: u64,
        viewer: &str,
        kind: SurfaceKind,
        cols: u16,
        rows: u16,
    ) -> Vec<Effect> {
        let payload = ResizePayload {
            cols,
            rows,
            kind: Some(kind),
            viewer_id: Some(viewer.to_string()),
        };
        self.client_frame(id, decoded(FrameType::Resize, &payload))
    }

    /// Sends an `Input` frame from a client.
    pub(crate) fn client_input(&mut self, id: u64, bytes: &[u8]) -> Vec<Effect> {
        self.client_frame(
            id,
            DecodedFrame {
                frame_type: FrameType::Input,
                payload: bytes.to_vec(),
            },
        )
    }

    /// Sends a `TakeControl` frame from a client.
    pub(crate) fn take_control(&mut self, id: u64) -> Vec<Effect> {
        self.client_frame(
            id,
            DecodedFrame {
                frame_type: FrameType::TakeControl,
                payload: Vec::new(),
            },
        )
    }

    /// Sends a `Replay` request frame from a client.
    pub(crate) fn replay_request(&mut self, id: u64) -> Vec<Effect> {
        self.client_frame(
            id,
            DecodedFrame {
                frame_type: FrameType::Replay,
                payload: Vec::new(),
            },
        )
    }

    /// Sends an `Attention` frame from a client.
    pub(crate) fn attention(&mut self, id: u64, payload: &AttentionPayload) -> Vec<Effect> {
        self.client_frame(id, decoded(FrameType::Attention, payload))
    }

    /// Disconnects a client.
    pub(crate) fn disconnect(&mut self, id: u64) -> Vec<Effect> {
        self.apply(SessionEvent::ClientDisconnected(ClientId(id)))
    }

    /// Reports a failed send to a client.
    pub(crate) fn send_failed(&mut self, id: u64, op: OperationId) -> Vec<Effect> {
        self.apply(SessionEvent::ClientSendFailed {
            client_id: ClientId(id),
            operation_id: op,
        })
    }

    /// Feeds local-terminal input.
    pub(crate) fn local_input(&mut self, bytes: &[u8]) -> Vec<Effect> {
        self.apply(SessionEvent::LocalInput(bytes.to_vec()))
    }

    /// Reports a local-console resize.
    pub(crate) fn local_resized(&mut self, cols: u16, rows: u16) -> Vec<Effect> {
        self.apply(SessionEvent::LocalResized { cols, rows })
    }

    /// Reports a console-write completion.
    pub(crate) fn console_completed(&mut self, op: OperationId) -> Vec<Effect> {
        self.apply(SessionEvent::ConsoleWriteCompleted(op))
    }

    /// Reports a console-write failure.
    pub(crate) fn console_failed(&mut self, op: OperationId) -> Vec<Effect> {
        self.apply(SessionEvent::ConsoleWriteFailed {
            operation_id: op,
            error: "console write failed".to_string(),
        })
    }

    /// Reports a metadata-patch completion.
    pub(crate) fn metadata_completed(&mut self, op: OperationId) -> Vec<Effect> {
        self.apply(SessionEvent::MetadataCompleted(op))
    }

    /// Signals the pty exited with `code`.
    pub(crate) fn pty_exited(&mut self, code: i32) -> Vec<Effect> {
        self.apply(SessionEvent::PtyExited(code))
    }

    /// Signals an unrecoverable pty/core failure.
    pub(crate) fn pty_failed(&mut self, error: &str) -> Vec<Effect> {
        self.apply(SessionEvent::PtyFailed(error.to_string()))
    }

    /// Requests a graceful shutdown.
    pub(crate) fn shutdown(&mut self) -> Vec<Effect> {
        self.apply(SessionEvent::ShutdownRequested)
    }

    // ---- timer control --------------------------------------------------

    /// Fires the (single) live timer scheduled for `delay`, using its current
    /// generation. Panics if no such timer is live.
    pub(crate) fn fire_timer_delay(&mut self, delay: Duration) -> Vec<Effect> {
        let (timer_id, generation) = self
            .live_timer(delay)
            .unwrap_or_else(|| panic!("no live timer scheduled for {delay:?}"));
        self.fire_timer(timer_id, generation)
    }

    /// Fires a specific timer id/generation (used to inject stale firings). A
    /// firing whose generation matches the live timer consumes it (one-shot);
    /// the handler may re-arm it by emitting a fresh `ScheduleTimer`.
    pub(crate) fn fire_timer(&mut self, timer_id: TimerId, generation: u64) -> Vec<Effect> {
        if let Some((gen, _)) = self.timers.get(&timer_id) {
            if *gen == generation {
                self.timers.remove(&timer_id);
            }
        }
        self.apply(SessionEvent::TimerFired {
            timer_id,
            generation,
        })
    }

    /// A live timer id/generation scheduled for `delay`, if any.
    pub(crate) fn live_timer(&self, delay: Duration) -> Option<(TimerId, u64)> {
        self.timers
            .iter()
            .find(|(_, (_, d))| *d == delay)
            .map(|(id, (gen, _))| (*id, *gen))
    }

    // ---- composite helpers ----------------------------------------------

    /// Connects a dashboard client and drives it through its first `Resize` so
    /// it is fully initialized (in broadcasts, surface known) on return.
    pub(crate) fn connect_initialized_dashboard(
        &mut self,
        id: u64,
        viewer: &str,
        cols: u16,
        rows: u16,
    ) -> Vec<Effect> {
        let mut effects = self.connect(id);
        effects.extend(self.resize(id, viewer, SurfaceKind::Dashboard, cols, rows));
        effects
    }

    // ---- internal -------------------------------------------------------

    fn record(&mut self, effects: &[Effect]) {
        for effect in effects {
            match effect {
                Effect::ScheduleTimer {
                    timer_id,
                    generation,
                    delay,
                } => {
                    self.timers.insert(*timer_id, (*generation, *delay));
                }
                Effect::CancelTimer {
                    timer_id,
                    generation,
                } => {
                    if let Some((gen, _)) = self.timers.get(timer_id) {
                        if gen == generation {
                            self.timers.remove(timer_id);
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

/// Encodes `value` and re-wraps its JSON body as the [`DecodedFrame`] a
/// coordinator would hand the state, without a socket round-trip.
fn decoded<T: serde::Serialize>(frame_type: FrameType, value: &T) -> DecodedFrame {
    let bytes = encode_json_frame(frame_type, value);
    DecodedFrame {
        frame_type,
        payload: bytes[5..].to_vec(),
    }
}

/// Test-only inspection helpers for [`Effect`], kept out of the production enum.
impl Effect {
    /// Bytes of a `SendClient` effect (encoded frame destined for a client).
    pub(crate) fn client_bytes(&self) -> Option<&[u8]> {
        match self {
            Effect::SendClient { bytes, .. } => Some(bytes),
            _ => None,
        }
    }

    /// `(client_id, bytes)` of a `SendClient` effect.
    pub(crate) fn client_target(&self) -> Option<(u64, &[u8])> {
        match self {
            Effect::SendClient {
                client_id, bytes, ..
            } => Some((client_id.0, bytes)),
            _ => None,
        }
    }

    /// Bytes of a `WritePty` effect.
    pub(crate) fn pty_input(&self) -> Option<&[u8]> {
        match self {
            Effect::WritePty { bytes, .. } => Some(bytes),
            _ => None,
        }
    }

    /// `(cols, rows)` of a `ResizePty` effect.
    pub(crate) fn pty_resize(&self) -> Option<(u16, u16)> {
        match self {
            Effect::ResizePty { cols, rows, .. } => Some((*cols, *rows)),
            _ => None,
        }
    }

    /// Bytes of a `WriteConsole` effect.
    pub(crate) fn console_bytes(&self) -> Option<&[u8]> {
        match self {
            Effect::WriteConsole { bytes, .. } => Some(bytes),
            _ => None,
        }
    }

    /// Bytes of a `PersistScrollback` effect.
    pub(crate) fn scrollback_bytes(&self) -> Option<&[u8]> {
        match self {
            Effect::PersistScrollback { bytes, .. } => Some(bytes),
            _ => None,
        }
    }

    /// `(patch, barrier)` of a `PatchMetadata` effect.
    pub(crate) fn metadata(&self) -> Option<(&SessionMetaPatch, bool)> {
        match self {
            Effect::PatchMetadata { patch, barrier, .. } => Some((patch, *barrier)),
            _ => None,
        }
    }

    /// The client id of a `CloseClient` effect.
    pub(crate) fn close_client(&self) -> Option<u64> {
        match self {
            Effect::CloseClient { client_id } => Some(client_id.0),
            _ => None,
        }
    }

    /// The exit code of a `CompleteSession` effect.
    pub(crate) fn complete_code(&self) -> Option<i32> {
        match self {
            Effect::CompleteSession { exit_code } => Some(*exit_code),
            _ => None,
        }
    }

    /// Whether this is a `KillPty` effect.
    pub(crate) fn is_kill_pty(&self) -> bool {
        matches!(self, Effect::KillPty { .. })
    }

    /// Whether this is a `StopAcceptingClients` effect.
    pub(crate) fn is_stop_accepting(&self) -> bool {
        matches!(self, Effect::StopAcceptingClients)
    }

    /// The correlating operation id of an effect that carries one.
    pub(crate) fn operation_id(&self) -> Option<OperationId> {
        match self {
            Effect::WritePty { operation_id, .. }
            | Effect::ResizePty { operation_id, .. }
            | Effect::KillPty { operation_id }
            | Effect::SendClient { operation_id, .. }
            | Effect::WriteConsole { operation_id, .. }
            | Effect::PatchMetadata { operation_id, .. }
            | Effect::PersistScrollback { operation_id, .. } => Some(*operation_id),
            _ => None,
        }
    }
}
