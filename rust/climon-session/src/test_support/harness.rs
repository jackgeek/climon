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
use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use climon_proto::frame::{
    encode_json_frame, AttentionPayload, DecodedFrame, FrameType, ResizePayload, SurfaceKind,
};
use climon_proto::meta::{PriorityReason, SessionMeta, SessionMetaPatch, SessionStatus};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::error::Elapsed;
use tokio_util::sync::CancellationToken;

use crate::adapters::local_terminal::{spawn_console_adapter, ConsoleWriter};
use crate::adapters::metadata::{spawn_metadata_adapter, MetadataStore};
use crate::engine::coordinator::{
    event_lanes_with_capacities, AppliedEventObserver, ControlEventSender, Coordinator,
    CoordinatorError, EffectReceivers, EffectRoutes, PtyEventSender, RouteCapacities,
    TransitionContextSource,
};
use crate::engine::effect::{ClientId, Effect, OperationId, TimerId};
use crate::engine::event::{EventKind, SessionEvent};
use crate::engine::state::{SessionState, SessionStateConfig, TransitionContext};
use crate::engine::{CLIENT_OUTPUT_CAPACITY, CONTROL_EVENT_CAPACITY, PTY_EVENT_CAPACITY};

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

// ---- bounded-queue stress / fault-injection harness --------------------

/// A deterministic transition-context source stamping every event with a fixed
/// clock, so the stress harness's transitions stay reproducible.
struct FixedContext {
    now_ms: i64,
    wall_time: String,
}

impl TransitionContextSource for FixedContext {
    fn next_context(&mut self) -> TransitionContext {
        TransitionContext {
            now_ms: self.now_ms,
            wall_time: self.wall_time.clone(),
        }
    }
}

/// Records every applied event's payload-free [`EventKind`] in application order,
/// so a stress test can assert arbitration ordering (e.g. that a shutdown landed
/// within the pty-drain burst) without ever seeing terminal/user bytes.
struct StressObserver {
    kinds: Arc<Mutex<Vec<EventKind>>>,
}

impl AppliedEventObserver for StressObserver {
    fn on_applied(&mut self, kind: EventKind) {
        self.kinds.lock().expect("kinds poisoned").push(kind);
    }
}

/// Peak occupancy gauges for every bounded queue the harness can observe: the
/// two event lanes (sampled from their senders) and the effect routes (sampled
/// from the fixture-owned receivers). Purely test-support instrumentation — no
/// production domain type exposes a depth API.
#[derive(Default)]
pub(crate) struct QueueDepths {
    pty_lane: AtomicUsize,
    control_lane: AtomicUsize,
    client_route: AtomicUsize,
    console_route: AtomicUsize,
    metadata_route: AtomicUsize,
    timer_route: AtomicUsize,
}

impl QueueDepths {
    fn record(gauge: &AtomicUsize, depth: usize) {
        gauge.fetch_max(depth, Ordering::Relaxed);
    }
}

/// A test-support wrapper *around a lane sender* that samples the lane's own
/// occupancy (`max_capacity - capacity`) on every send and keeps the running
/// peak. This is the only queue-depth instrumentation the stress suite uses; no
/// production domain type exposes a depth API.
#[derive(Clone)]
pub(crate) struct DepthTrackingPtySender {
    sender: PtyEventSender,
    depths: Arc<QueueDepths>,
}

impl DepthTrackingPtySender {
    fn new(sender: PtyEventSender, depths: Arc<QueueDepths>) -> Self {
        DepthTrackingPtySender { sender, depths }
    }

    /// Samples the lane's current occupancy into the peak gauge.
    fn sample(&self) {
        let occupancy = self.sender.max_capacity() - self.sender.capacity();
        QueueDepths::record(&self.depths.pty_lane, occupancy);
    }

    /// Sends a pty-lane event with bounded backpressure, sampling the lane's
    /// occupancy immediately before and after so the peak reflects the depth the
    /// event pushed the lane to.
    pub(crate) async fn send(&self, event: SessionEvent) -> Result<(), CoordinatorError> {
        self.sample();
        let result = self
            .sender
            .send(event)
            .await
            .map_err(|_| CoordinatorError::EventLanesClosed);
        self.sample();
        result
    }
}

/// Builder for the bounded-queue stress / fault-injection harness. Configures the
/// event-lane and effect-route capacities, then [`start`](StressFixture::start)s
/// a real [`Coordinator`] over a real [`SessionState`] with fixture-driven
/// adapters, so a test exercises the actual arbitration and backpressure cores.
pub(crate) struct StressFixture {
    pty_capacity: usize,
    control_capacity: usize,
    client_capacity: usize,
    local_attached: bool,
    connect_client: bool,
    block_console: bool,
    failing_metadata: bool,
}

impl Default for StressFixture {
    fn default() -> Self {
        Self::new()
    }
}

impl StressFixture {
    /// A headless fixture at the production lane/route capacities.
    pub(crate) fn new() -> Self {
        StressFixture {
            pty_capacity: PTY_EVENT_CAPACITY,
            control_capacity: CONTROL_EVENT_CAPACITY,
            client_capacity: CLIENT_OUTPUT_CAPACITY,
            local_attached: false,
            connect_client: false,
            block_console: false,
            failing_metadata: false,
        }
    }

    /// Sets the pty event lane's bounded capacity.
    pub(crate) fn pty_capacity(mut self, capacity: usize) -> Self {
        self.pty_capacity = capacity;
        self
    }

    /// Sets the control event lane's bounded capacity.
    pub(crate) fn control_capacity(mut self, capacity: usize) -> Self {
        self.control_capacity = capacity;
        self
    }

    /// Sets the client output effect route's bounded capacity.
    pub(crate) fn client_capacity(mut self, capacity: usize) -> Self {
        self.client_capacity = capacity;
        self
    }

    /// Runs with an interactive local terminal attached, so pty output is echoed
    /// to the console route.
    pub(crate) fn attached(mut self) -> Self {
        self.local_attached = true;
        self
    }

    /// Connects and initializes a dashboard client before returning from
    /// [`start`](StressFixture::start), so pty output is broadcast to it.
    pub(crate) fn with_client(mut self) -> Self {
        self.connect_client = true;
        self
    }

    /// Wires the *real* console adapter to a writer wedged on its first write, so
    /// the console route fills and stays saturated — the "blocked console" fault.
    /// [`RunningStress::release_console`] unwedges it.
    pub(crate) fn block_console(mut self) -> Self {
        self.block_console = true;
        self
    }

    /// Wires the *real* metadata adapter to a store whose every operation fails,
    /// so every patch (including the finalization barrier) exhausts its retries —
    /// the "metadata retry exhaustion" fault, which must not stop the live pty.
    pub(crate) fn failing_metadata(mut self) -> Self {
        self.failing_metadata = true;
        self
    }

    /// Spawns the real coordinator plus fixture-driven adapters that drain every
    /// effect route and feed back the completions a real adapter set would (the
    /// pty exit after a kill, and the exit-barrier metadata completion), so the
    /// session can reach its ordered finalization. When [`block_console`] is set
    /// the real console adapter is wired to a wedged writer; when [`with_client`]
    /// is set a dashboard client is connected and initialized before returning.
    ///
    /// [`block_console`]: StressFixture::block_console
    /// [`with_client`]: StressFixture::with_client
    pub(crate) async fn start(self) -> RunningStress {
        let meta = base_meta();
        let config = SessionStateConfig {
            idle_seconds: 0,
            snippet_enabled: false,
            headless: !self.local_attached,
            scrollback_cap: 256 * 1024,
        };
        let state = SessionState::new(&meta, config, self.local_attached);
        let (pty_tx, control_tx, lanes) =
            event_lanes_with_capacities(self.pty_capacity, self.control_capacity);
        let caps = RouteCapacities {
            client: self.client_capacity,
            ..RouteCapacities::DEFAULT
        };
        let (routes, receivers) = EffectRoutes::with_capacities(caps);

        let kinds = Arc::new(Mutex::new(Vec::new()));
        let observer = StressObserver {
            kinds: kinds.clone(),
        };
        let context = FixedContext {
            now_ms: 0,
            wall_time: "1970-01-01T00:00:00.000Z".to_string(),
        };
        let coordinator = Coordinator::new(state, context, observer, routes, lanes);
        let cancel = CancellationToken::new();
        let coordinator = tokio::spawn(coordinator.run(cancel.clone()));

        let EffectReceivers {
            pty,
            client,
            console,
            metadata,
            timer,
            completion,
        } = receivers;

        let stopped = Arc::new(Notify::new());
        let client_sends = Arc::new(AtomicUsize::new(0));
        let depths = Arc::new(QueueDepths::default());
        let mut adapters = spawn_stress_adapters(
            pty,
            client,
            timer,
            completion,
            pty_tx.clone(),
            stopped.clone(),
            client_sends.clone(),
            depths.clone(),
        );

        // Metadata: either the real adapter over an always-failing store (the
        // "retry exhaustion" fault, which still drives finalization via
        // MetadataFailed), or a depth-sampling drainer that answers the barrier.
        if self.failing_metadata {
            adapters.push(wrap_result(spawn_metadata_adapter(
                metadata,
                FailingStore,
                control_tx.clone(),
            )));
        } else {
            let depths = depths.clone();
            let control_tx = control_tx.clone();
            adapters.push(tokio::spawn(async move {
                let mut metadata = metadata;
                loop {
                    QueueDepths::record(&depths.metadata_route, metadata.len());
                    let Some(effect) = metadata.recv().await else {
                        break;
                    };
                    if let Effect::PatchMetadata {
                        operation_id,
                        barrier: true,
                        ..
                    } = effect
                    {
                        let _ = control_tx
                            .send(SessionEvent::MetadataCompleted(operation_id))
                            .await;
                    }
                }
            }));
        }

        // Console: either the real adapter wedged on a blocking writer (the
        // "blocked console" fault), or a depth-sampling drainer.
        let console_gate = if self.block_console {
            let gate = Arc::new(ConsoleGate::new());
            let writer = BlockingConsoleWriter { gate: gate.clone() };
            let handle = spawn_console_adapter(console, writer, control_tx.clone());
            adapters.push(tokio::spawn(async move {
                let _ = handle.await;
            }));
            Some(gate)
        } else {
            let mut console = console;
            let depths = depths.clone();
            adapters.push(tokio::spawn(async move {
                loop {
                    QueueDepths::record(&depths.console_route, console.len());
                    if console.recv().await.is_none() {
                        break;
                    }
                }
            }));
            None
        };

        let running = RunningStress {
            pty_tx: DepthTrackingPtySender::new(pty_tx, depths.clone()),
            control_tx,
            depths,
            capacities: QueueCapacities {
                pty_lane: self.pty_capacity,
                control_lane: self.control_capacity,
                routes: caps,
            },
            kinds,
            shutdown_baseline: Arc::new(AtomicUsize::new(0)),
            stopped,
            client_sends,
            console_gate,
            coordinator: Some(coordinator),
            adapters,
            cancel,
        };

        if self.connect_client {
            running.connect_dashboard_client(1, "stress-viewer").await;
        }
        running
    }
}

/// The configured bounds of every queue the harness can observe, for asserting
/// that no queue exceeded its capacity.
struct QueueCapacities {
    pty_lane: usize,
    control_lane: usize,
    routes: RouteCapacities,
}

/// A started stress harness: the running coordinator, the fixture-driven
/// adapters, and the handles a test drives it with.
pub(crate) struct RunningStress {
    pty_tx: DepthTrackingPtySender,
    control_tx: ControlEventSender,
    depths: Arc<QueueDepths>,
    capacities: QueueCapacities,
    kinds: Arc<Mutex<Vec<EventKind>>>,
    /// The count of events already applied when a shutdown was requested, so the
    /// arbitration bound is measured from the request, not the start of the run.
    shutdown_baseline: Arc<AtomicUsize>,
    stopped: Arc<Notify>,
    /// How many `SendClient` effects the client-route drainer has observed.
    client_sends: Arc<AtomicUsize>,
    /// The wedged-console gate, present only when the console is blocked.
    console_gate: Option<Arc<ConsoleGate>>,
    coordinator: Option<JoinHandle<Result<(), CoordinatorError>>>,
    adapters: Vec<JoinHandle<()>>,
    cancel: CancellationToken,
}

impl RunningStress {
    /// Floods the pty event lane with `count` output chunks of `size` bytes each,
    /// with bounded backpressure — a send blocks until the coordinator drains the
    /// lane — so a producer faster than the coordinator cannot grow the lane
    /// beyond its configured bound.
    pub(crate) async fn flood_pty_output(&self, count: usize, size: usize) {
        for _ in 0..count {
            self.pty_tx
                .send(SessionEvent::PtyOutput(vec![b'x'; size]))
                .await
                .expect("pty lane accepts flood");
        }
    }

    /// Requests a graceful shutdown on the control lane, first snapshotting how
    /// many events have already been applied so [`shutdown_applied_within_pty_events`]
    /// can measure the arbitration bound from this request.
    ///
    /// [`shutdown_applied_within_pty_events`]: RunningStress::shutdown_applied_within_pty_events
    pub(crate) async fn request_shutdown(&self) {
        let applied = self.kinds.lock().expect("kinds poisoned").len();
        self.shutdown_baseline.store(applied, Ordering::Relaxed);
        QueueDepths::record(
            &self.depths.control_lane,
            self.control_tx.max_capacity() - self.control_tx.capacity(),
        );
        self.control_tx
            .send(SessionEvent::ShutdownRequested)
            .await
            .expect("control lane accepts shutdown");
    }

    /// Waits until the session has finalized (a `CompleteSession` was dispatched),
    /// or times out after `within`.
    pub(crate) async fn wait_stopped(&self, within: Duration) -> Result<(), Elapsed> {
        tokio::time::timeout(within, self.stopped.notified()).await
    }

    /// The peak pty-lane occupancy sampled by the depth-tracking sender wrapper.
    pub(crate) fn max_pty_depth(&self) -> usize {
        self.depths.pty_lane.load(Ordering::Relaxed)
    }

    /// Whether every observed queue stayed within its configured capacity — i.e.
    /// no lane or route ever grew beyond its bound under the flood.
    pub(crate) fn queues_within_capacity(&self) -> bool {
        let depths = &self.depths;
        let caps = &self.capacities;
        depths.pty_lane.load(Ordering::Relaxed) <= caps.pty_lane
            && depths.control_lane.load(Ordering::Relaxed) <= caps.control_lane
            && depths.client_route.load(Ordering::Relaxed) <= caps.routes.client
            && depths.console_route.load(Ordering::Relaxed) <= caps.routes.console
            && depths.metadata_route.load(Ordering::Relaxed) <= caps.routes.metadata
            && depths.timer_route.load(Ordering::Relaxed) <= caps.routes.timer
    }

    /// Whether the shutdown, once requested, was applied after at most `budget`
    /// pty-output applications — i.e. the flood backlog never starved the queued
    /// control event beyond the arbitration bound. Only pty output may precede
    /// the shutdown after the request.
    pub(crate) fn shutdown_applied_within_pty_events(&self, budget: usize) -> bool {
        let kinds = self.kinds.lock().expect("kinds poisoned");
        let baseline = self.shutdown_baseline.load(Ordering::Relaxed);
        let Some(index) = kinds
            .iter()
            .position(|kind| *kind == EventKind::ShutdownRequested)
        else {
            return false;
        };
        if index < baseline {
            return false;
        }
        let only_pty_before = kinds[baseline..index]
            .iter()
            .all(|kind| *kind == EventKind::PtyOutput);
        only_pty_before && (index - baseline) <= budget
    }

    /// Connects and initializes a dashboard client through the control lane,
    /// waiting until its `Resize` is applied (which initializes it and adds it to
    /// the broadcast set) before returning.
    async fn connect_dashboard_client(&self, id: u64, viewer: &str) {
        self.control_tx
            .send(SessionEvent::ClientConnected(ClientId(id)))
            .await
            .expect("control lane accepts client connect");
        let baseline = self.kinds.lock().expect("kinds poisoned").len();
        self.control_tx
            .send(SessionEvent::ClientFrame {
                client_id: ClientId(id),
                frame: decoded(
                    FrameType::Resize,
                    &ResizePayload {
                        cols: 80,
                        rows: 24,
                        kind: Some(SurfaceKind::Dashboard),
                        viewer_id: Some(viewer.to_string()),
                    },
                ),
            })
            .await
            .expect("control lane accepts client resize");
        // Wait until both the connect and the resize have been applied.
        for _ in 0..10_000 {
            if self.kinds.lock().expect("kinds poisoned").len() > baseline + 1 {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("dashboard client was not initialized");
    }

    /// How many `SendClient` effects the client route has received so far.
    pub(crate) fn client_sends_received(&self) -> usize {
        self.client_sends.load(Ordering::Relaxed)
    }

    /// Unwedges a blocked console so its adapter drains and can exit. A no-op when
    /// the console was not blocked.
    pub(crate) fn release_console(&self) {
        if let Some(gate) = &self.console_gate {
            gate.release();
        }
    }
}

impl Drop for RunningStress {
    fn drop(&mut self) {
        // Nothing is left detached: release any wedged console so its blocking
        // worker can exit, cancel the coordinator, and abort every fixture
        // adapter so a test that ends before finalization still tears down.
        if let Some(gate) = &self.console_gate {
            gate.release();
        }
        self.cancel.cancel();
        if let Some(coordinator) = &self.coordinator {
            coordinator.abort();
        }
        for adapter in &self.adapters {
            adapter.abort();
        }
    }
}

/// A gate a [`BlockingConsoleWriter`] parks on until a test releases it, modeling
/// a console peripheral wedged on its own I/O.
struct ConsoleGate {
    released: Mutex<bool>,
    cond: Condvar,
}

impl ConsoleGate {
    fn new() -> Self {
        ConsoleGate {
            released: Mutex::new(false),
            cond: Condvar::new(),
        }
    }

    fn release(&self) {
        let mut released = self.released.lock().expect("console gate poisoned");
        *released = true;
        self.cond.notify_all();
    }
}

/// A [`ConsoleWriter`] that blocks its worker thread on the first write until the
/// gate is released, then accepts everything — the fault seam for a blocked
/// console. It never records the bytes.
struct BlockingConsoleWriter {
    gate: Arc<ConsoleGate>,
}

impl ConsoleWriter for BlockingConsoleWriter {
    fn write_all(&mut self, _bytes: &[u8]) -> io::Result<()> {
        let mut released = self.gate.released.lock().expect("console gate poisoned");
        while !*released {
            released = self
                .gate
                .cond
                .wait(released)
                .expect("console gate poisoned");
        }
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Spawns one drain task per non-console effect route. The pty and metadata tasks
/// feed back the two completions finalization awaits (a clean child exit after a
/// kill, and the exit-barrier metadata completion); the client task counts every
/// `SendClient`; the timer route is drained best-effort. Each task ends when its
/// route closes (the coordinator dropped the routes on completion), so none is
/// detached. The console route is wired by the caller (real adapter or drainer).
#[allow(clippy::too_many_arguments)]
fn spawn_stress_adapters(
    pty: tokio::sync::mpsc::Receiver<Effect>,
    client: tokio::sync::mpsc::Receiver<Effect>,
    timer: tokio::sync::mpsc::Receiver<Effect>,
    completion: tokio::sync::mpsc::Receiver<Effect>,
    pty_tx: PtyEventSender,
    stopped: Arc<Notify>,
    client_sends: Arc<AtomicUsize>,
    depths: Arc<QueueDepths>,
) -> Vec<JoinHandle<()>> {
    let mut handles = Vec::new();

    // Pty command route: a kill request is answered with a clean child exit so
    // finalization can begin.
    handles.push(tokio::spawn(async move {
        let mut pty = pty;
        while let Some(effect) = pty.recv().await {
            if let Effect::KillPty { .. } = effect {
                let _ = pty_tx.send(SessionEvent::PtyExited(0)).await;
            }
        }
    }));

    // Client route: drained fast (an isolating, non-blocking real adapter), and
    // every broadcast is counted so a test can prove client output kept flowing.
    {
        let depths = depths.clone();
        handles.push(tokio::spawn(async move {
            let mut client = client;
            loop {
                QueueDepths::record(&depths.client_route, client.len());
                let Some(effect) = client.recv().await else {
                    break;
                };
                if let Effect::SendClient { .. } = effect {
                    client_sends.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }

    // Timer route drained best-effort (timers are never fired here).
    {
        let depths = depths.clone();
        handles.push(tokio::spawn(async move {
            let mut timer = timer;
            loop {
                QueueDepths::record(&depths.timer_route, timer.len());
                if timer.recv().await.is_none() {
                    break;
                }
            }
        }));
    }

    // Completion route: the session finalized.
    handles.push(tokio::spawn(async move {
        let mut completion = completion;
        while let Some(effect) = completion.recv().await {
            if let Effect::CompleteSession { .. } = effect {
                stopped.notify_one();
            }
        }
    }));

    handles
}

/// Adapts a typed adapter join handle to the harness's `JoinHandle<()>` list,
/// so a real adapter (which returns a `Result`) can be owned and joined
/// alongside the fixture's own drain tasks; none is detached.
fn wrap_result<T: Send + 'static>(handle: JoinHandle<T>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let _ = handle.await;
    })
}

/// A [`MetadataStore`] whose every operation fails, so each command exhausts the
/// adapter's retry schedule — the "metadata retry exhaustion" fault seam. It
/// never records the bytes.
struct FailingStore;

impl MetadataStore for FailingStore {
    fn patch(&self, _patch: SessionMetaPatch) -> Result<(), String> {
        Err("metadata store unavailable".to_string())
    }

    fn persist_scrollback(&self, _bytes: Vec<u8>) -> Result<(), String> {
        Err("metadata store unavailable".to_string())
    }
}
