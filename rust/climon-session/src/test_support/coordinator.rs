//! Deterministic async harness for the bounded actor [`Coordinator`].
//!
//! The fixture owns the un-spawned coordinator ingredients (the pure state, a
//! fixed-clock context source, and a recording observer) plus the lane senders
//! and route receivers a real adapter set would hold. A test arranges state by
//! seeding events directly (bypassing the channels), then spawns the
//! coordinator and drives it through the lanes/routes exactly as adapters would:
//! queueing events, reading dispatched effects, and feeding completions back.
//!
//! Recording is by payload-free [`EventKind`] only, so terminal/user bytes never
//! enter the trace.
//!
//! [`Coordinator`]: crate::engine::coordinator::Coordinator

#![allow(dead_code)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use climon_proto::frame::{encode_json_frame, DecodedFrame, FrameType, ResizePayload, SurfaceKind};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::engine::coordinator::{
    event_lanes, AppliedEventObserver, ControlEventSender, Coordinator, CoordinatorError,
    EffectRoute, EffectRoutes, EventLanes, PtyEventSender, RouteCapacities,
    TransitionContextSource,
};
use crate::engine::effect::{ClientId, Effect, OperationId, TimerId};
use crate::engine::event::{EventKind, SessionEvent};
use crate::engine::state::{SessionState, TransitionContext};
use crate::test_support::harness::{base_config, base_meta};

/// A deterministic context source: every event is stamped with the same fixed
/// monotonic/wall clock, so transitions are reproducible.
#[derive(Clone)]
pub(crate) struct StaticContext {
    now_ms: i64,
    wall_time: String,
}

impl TransitionContextSource for StaticContext {
    fn next_context(&mut self) -> TransitionContext {
        TransitionContext {
            now_ms: self.now_ms,
            wall_time: self.wall_time.clone(),
        }
    }
}

/// Records every applied event's payload-free [`EventKind`] and, once a
/// configured count is reached, cancels the coordinator so a test can run it for
/// exactly N applied events.
#[derive(Clone)]
pub(crate) struct RecordingObserver {
    kinds: Arc<Mutex<Vec<EventKind>>>,
    stop_after: Arc<AtomicUsize>,
    cancel: CancellationToken,
}

impl AppliedEventObserver for RecordingObserver {
    fn on_applied(&mut self, kind: EventKind) {
        let mut kinds = self.kinds.lock().expect("kinds poisoned");
        kinds.push(kind);
        if kinds.len() >= self.stop_after.load(Ordering::Relaxed) {
            self.cancel.cancel();
        }
    }
}

/// Drives a [`Coordinator`] deterministically for arbitration/dispatch tests.
pub(crate) struct CoordinatorFixture {
    // Ingredients moved into the coordinator when it is spawned.
    state: Option<SessionState>,
    context: Option<StaticContext>,
    observer: Option<RecordingObserver>,
    routes: Option<EffectRoutes>,
    lanes: Option<EventLanes>,

    // Lane senders (event inputs) retained for the test.
    pty_tx: Option<PtyEventSender>,
    control_tx: Option<ControlEventSender>,

    // Route receivers (effect outputs) retained for the test; dropping one
    // closes that route.
    pty_effects: Option<mpsc::Receiver<Effect>>,
    client_effects: Option<mpsc::Receiver<Effect>>,
    console_effects: Option<mpsc::Receiver<Effect>>,
    metadata_effects: Option<mpsc::Receiver<Effect>>,
    timer_effects: Option<mpsc::Receiver<Effect>>,
    completion_effects: Option<mpsc::Receiver<Effect>>,

    // Recording + lifecycle control.
    kinds: Arc<Mutex<Vec<EventKind>>>,
    stop_after: Arc<AtomicUsize>,
    cancel: CancellationToken,
    handle: Option<JoinHandle<Result<(), CoordinatorError>>>,
}

impl CoordinatorFixture {
    /// A headless session (no interactive local terminal).
    pub(crate) fn headless() -> Self {
        Self::build(false, RouteCapacities::DEFAULT)
    }

    /// A session with an interactive local terminal attached (local console
    /// output enabled).
    pub(crate) fn attached() -> Self {
        Self::build(true, RouteCapacities::DEFAULT)
    }

    /// A session with explicit route capacities (for exercising backpressure
    /// with a small bound).
    pub(crate) fn with_capacities(local_attached: bool, caps: RouteCapacities) -> Self {
        Self::build(local_attached, caps)
    }

    fn build(local_attached: bool, caps: RouteCapacities) -> Self {
        let meta = base_meta();
        let state = SessionState::new(&meta, base_config(local_attached), local_attached);
        let (pty_tx, control_tx, lanes) = event_lanes();
        let (routes, receivers) = EffectRoutes::with_capacities(caps);
        let kinds = Arc::new(Mutex::new(Vec::new()));
        let stop_after = Arc::new(AtomicUsize::new(usize::MAX));
        let cancel = CancellationToken::new();
        let observer = RecordingObserver {
            kinds: kinds.clone(),
            stop_after: stop_after.clone(),
            cancel: cancel.clone(),
        };
        let context = StaticContext {
            now_ms: 0,
            wall_time: "1970-01-01T00:00:00.000Z".to_string(),
        };
        CoordinatorFixture {
            state: Some(state),
            context: Some(context),
            observer: Some(observer),
            routes: Some(routes),
            lanes: Some(lanes),
            pty_tx: Some(pty_tx),
            control_tx: Some(control_tx),
            pty_effects: Some(receivers.pty),
            client_effects: Some(receivers.client),
            console_effects: Some(receivers.console),
            metadata_effects: Some(receivers.metadata),
            timer_effects: Some(receivers.timer),
            completion_effects: Some(receivers.completion),
            kinds,
            stop_after,
            cancel,
            handle: None,
        }
    }

    // ---- state seeding (pre-spawn, bypasses the channels) ----------------

    /// Applies an event directly to the pure state to arrange a starting
    /// condition, discarding the effects. Not recorded and not routed through
    /// the coordinator, so it never touches the lanes or routes.
    pub(crate) fn seed(&mut self, event: SessionEvent) {
        let ctx = self
            .context
            .as_mut()
            .expect("not yet spawned")
            .next_context();
        self.state
            .as_mut()
            .expect("not yet spawned")
            .apply(event, &ctx);
    }

    /// Seeds a connected, initialized dashboard client. On a headless session
    /// (no local controller) the first resize makes it controller; on an
    /// attached session use [`Self::seed_take_control`] to seize control.
    pub(crate) fn seed_connected_dashboard(&mut self, id: u64, viewer: &str, cols: u16, rows: u16) {
        self.seed(SessionEvent::ClientConnected(ClientId(id)));
        self.seed(SessionEvent::ClientFrame {
            client_id: ClientId(id),
            frame: resize_frame(viewer, SurfaceKind::Dashboard, cols, rows),
        });
    }

    /// Seeds a `TakeControl` frame from a client, promoting it to controller
    /// (displacing an attached local terminal).
    pub(crate) fn seed_take_control(&mut self, id: u64) {
        self.seed(SessionEvent::ClientFrame {
            client_id: ClientId(id),
            frame: DecodedFrame {
                frame_type: FrameType::TakeControl,
                payload: Vec::new(),
            },
        });
    }

    // ---- spawning / running ---------------------------------------------

    /// Spawns the coordinator as an owned task, moving the ingredients in.
    pub(crate) fn spawn(&mut self) {
        let coordinator = Coordinator::new(
            self.state.take().expect("already spawned"),
            self.context.take().expect("already spawned"),
            self.observer.take().expect("already spawned"),
            self.routes.take().expect("already spawned"),
            self.lanes.take().expect("already spawned"),
        );
        let cancel = self.cancel.clone();
        self.handle = Some(tokio::spawn(coordinator.run(cancel)));
    }

    /// Spawns and runs the coordinator until it has applied exactly `n` events
    /// (the observer cancels it), then joins. Events must already be queued.
    pub(crate) async fn run_until_applied(&mut self, n: usize) {
        self.stop_after.store(n, Ordering::Relaxed);
        self.spawn();
        let _ = self.join().await;
    }

    /// Awaits the coordinator task, returning its result.
    pub(crate) async fn join(&mut self) -> Result<(), CoordinatorError> {
        self.handle
            .take()
            .expect("coordinator not spawned")
            .await
            .expect("coordinator task panicked")
    }

    /// Cancels the coordinator and joins it (test teardown for a still-running
    /// coordinator).
    pub(crate) async fn finish(&mut self) -> Result<(), CoordinatorError> {
        self.cancel.cancel();
        self.join().await
    }

    /// Yields the runtime until the coordinator has applied at least `n` events.
    pub(crate) async fn wait_for_applied(&self, n: usize) {
        for _ in 0..10_000 {
            if self.kinds.lock().expect("kinds poisoned").len() >= n {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!(
            "coordinator did not apply {n} events; applied {:?}",
            self.applied_kinds()
        );
    }

    // ---- event inputs ----------------------------------------------------

    /// Queues a pty-lane event, awaiting bounded capacity.
    pub(crate) async fn queue_pty(&self, event: SessionEvent) {
        self.pty_tx
            .as_ref()
            .expect("pty lane closed")
            .send(event)
            .await
            .expect("pty lane send");
    }

    /// Queues a control-lane event, awaiting bounded capacity.
    pub(crate) async fn queue_control(&self, event: SessionEvent) {
        self.control_tx
            .as_ref()
            .expect("control lane closed")
            .send(event)
            .await
            .expect("control lane send");
    }

    /// Queues a chunk of pty output.
    pub(crate) async fn queue_pty_output(&self, bytes: &[u8]) {
        self.queue_pty(SessionEvent::PtyOutput(bytes.to_vec()))
            .await;
    }

    /// Queues a pty exit.
    pub(crate) async fn queue_pty_exited(&self, code: i32) {
        self.queue_pty(SessionEvent::PtyExited(code)).await;
    }

    /// Queues a graceful shutdown request.
    pub(crate) async fn queue_shutdown(&self) {
        self.queue_control(SessionEvent::ShutdownRequested).await;
    }

    /// Queues a metadata-patch completion (adapter feedback).
    pub(crate) async fn queue_metadata_completed(&self, op: OperationId) {
        self.queue_control(SessionEvent::MetadataCompleted(op))
            .await;
    }

    /// Queues a timer firing (adapter feedback).
    pub(crate) async fn queue_timer_fired(&self, timer_id: TimerId, generation: u64) {
        self.queue_control(SessionEvent::TimerFired {
            timer_id,
            generation,
        })
        .await;
    }

    /// Drops both lane senders, closing the two event lanes.
    pub(crate) fn close_event_lanes(&mut self) {
        self.pty_tx = None;
        self.control_tx = None;
    }

    // ---- effect outputs --------------------------------------------------

    fn receiver(&mut self, route: EffectRoute) -> Option<&mut mpsc::Receiver<Effect>> {
        match route {
            EffectRoute::Pty => self.pty_effects.as_mut(),
            EffectRoute::Client => self.client_effects.as_mut(),
            EffectRoute::Console => self.console_effects.as_mut(),
            EffectRoute::Metadata => self.metadata_effects.as_mut(),
            EffectRoute::Timer => self.timer_effects.as_mut(),
            EffectRoute::Completion => self.completion_effects.as_mut(),
        }
    }

    /// Awaits the next effect dispatched to `route` (driving the coordinator).
    pub(crate) async fn next_effect(&mut self, route: EffectRoute) -> Option<Effect> {
        match self.receiver(route) {
            Some(rx) => rx.recv().await,
            None => None,
        }
    }

    /// Returns an immediately-available effect on `route`, if any.
    pub(crate) fn try_effect(&mut self, route: EffectRoute) -> Option<Effect> {
        match self.receiver(route) {
            Some(rx) => rx.try_recv().ok(),
            None => None,
        }
    }

    /// Drains every immediately-available effect on `route`, in order.
    pub(crate) fn drain(&mut self, route: EffectRoute) -> Vec<Effect> {
        let mut effects = Vec::new();
        if let Some(rx) = self.receiver(route) {
            while let Ok(effect) = rx.try_recv() {
                effects.push(effect);
            }
        }
        effects
    }

    /// Drops the receiver for `route`, closing that effect route.
    pub(crate) fn close_route(&mut self, route: EffectRoute) {
        match route {
            EffectRoute::Pty => self.pty_effects = None,
            EffectRoute::Client => self.client_effects = None,
            EffectRoute::Console => self.console_effects = None,
            EffectRoute::Metadata => self.metadata_effects = None,
            EffectRoute::Timer => self.timer_effects = None,
            EffectRoute::Completion => self.completion_effects = None,
        }
    }

    // ---- recording -------------------------------------------------------

    /// The payload-free kinds of every event applied so far, in order.
    pub(crate) fn applied_kinds(&self) -> Vec<EventKind> {
        self.kinds.lock().expect("kinds poisoned").clone()
    }
}

/// Builds the [`DecodedFrame`] a coordinator would hand the state for a client
/// `Resize`, carrying a surface identity/kind/size, without a socket round-trip.
fn resize_frame(viewer: &str, kind: SurfaceKind, cols: u16, rows: u16) -> DecodedFrame {
    let payload = ResizePayload {
        cols,
        rows,
        kind: Some(kind),
        viewer_id: Some(viewer.to_string()),
    };
    let bytes = encode_json_frame(FrameType::Resize, &payload);
    DecodedFrame {
        frame_type: FrameType::Resize,
        payload: bytes[5..].to_vec(),
    }
}
