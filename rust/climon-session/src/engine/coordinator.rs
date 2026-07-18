//! Bounded actor coordinator: the single async task that owns [`SessionState`]
//! and mediates between the event lanes and the effect routes.
//!
//! Two bounded mpsc lanes feed the coordinator: a pty lane carrying only the
//! pty's own output/exit/failure, and a control lane carrying every other
//! event. One coordinator task drains them (bounding control-event latency),
//! applies each event to the pure [`SessionState`], and dispatches the
//! resulting [`Effect`]s to six route-specific bounded channels, awaiting
//! capacity so a slow adapter backpressures the actor rather than dropping
//! work.
//!
//! The coordinator performs no I/O of its own: adapters (a later task) own the
//! receiving end of every route and translate effects into real pty/socket/
//! console/store operations, feeding completions back as events.
//!
//! [`SessionState`]: crate::engine::state::SessionState
//! [`Effect`]: crate::engine::effect::Effect

// Every route/lane/coordinator item below is constructed by `test_support` now
// and by the adapters/supervisor that wire real I/O later, so they carry the
// same module-level `dead_code` allowance as the effect/event vocabulary.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::fmt;
use std::time::Instant;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::engine::effect::Effect;
use crate::engine::event::{EventKind, EventLane, SessionEvent};
use crate::engine::state::{SessionState, TransitionContext};
use crate::engine::{
    CLIENT_OUTPUT_CAPACITY, CONSOLE_OUTPUT_CAPACITY, CONTROL_EVENT_CAPACITY,
    METADATA_COMMAND_CAPACITY, PTY_COMMAND_CAPACITY, PTY_EVENT_CAPACITY,
};

/// Maximum number of consecutive pty-lane applications before the control lane
/// is checked, bounding the latency of a queued control event to at most this
/// many pty-output events. The count spans a pty event delivered by the
/// blocking select, so that event plus the drain that follows it never exceed
/// the bound before control is checked.
const PTY_DRAIN_BURST: usize = 16;

/// Timer route capacity. Timers are low-volume (a handful of live schedules),
/// so a modest bound is ample headroom.
const TIMER_COMMAND_CAPACITY: usize = 64;

/// Completion route capacity. The route only ever carries the single terminal
/// [`Effect::CompleteSession`], so a capacity of one is sufficient.
const COMPLETION_CAPACITY: usize = 1;

/// Error text stamped on the failure event synthesized when the console route
/// closes; the state degrades the local view rather than failing the core.
const CONSOLE_ROUTE_CLOSED: &str = "console route closed";

// ---- effect routing ----------------------------------------------------

/// The exact bounded effect route an [`Effect`] is dispatched to. Every effect
/// variant maps to exactly one route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EffectRoute {
    /// Pty stdin write, tty resize, child kill.
    Pty,
    /// Client frame send, client close, accept-loop stop.
    Client,
    /// Local console write.
    Console,
    /// Metadata patch, scrollback persist.
    Metadata,
    /// Timer schedule/cancel.
    Timer,
    /// Session completion.
    Completion,
}

impl EffectRoute {
    /// The route an effect must be dispatched to. Total over every variant so a
    /// new effect cannot silently fall through to the wrong adapter.
    pub(crate) fn of(effect: &Effect) -> EffectRoute {
        match effect {
            Effect::WritePty { .. } | Effect::ResizePty { .. } | Effect::KillPty { .. } => {
                EffectRoute::Pty
            }
            Effect::SendClient { .. }
            | Effect::CloseClient { .. }
            | Effect::StopAcceptingClients => EffectRoute::Client,
            Effect::WriteConsole { .. } => EffectRoute::Console,
            Effect::PatchMetadata { .. } | Effect::PersistScrollback { .. } => {
                EffectRoute::Metadata
            }
            Effect::ScheduleTimer { .. } | Effect::CancelTimer { .. } => EffectRoute::Timer,
            Effect::CompleteSession { .. } => EffectRoute::Completion,
        }
    }
}

// ---- errors ------------------------------------------------------------

/// A fatal coordinator failure that ends [`Coordinator::run`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CoordinatorError {
    /// A required effect route's receiver closed, so its effect could not be
    /// delivered and this layer cannot recover.
    RequiredEffectRouteClosed(EffectRoute),
    /// Both event lanes closed before the session completed.
    EventLanesClosed,
}

impl fmt::Display for CoordinatorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoordinatorError::RequiredEffectRouteClosed(route) => {
                write!(f, "required effect route closed: {route:?}")
            }
            CoordinatorError::EventLanesClosed => {
                write!(f, "both event lanes closed before completion")
            }
        }
    }
}

impl std::error::Error for CoordinatorError {}

// ---- event lanes -------------------------------------------------------

/// Reason a typed lane sender rejected an event without enqueuing it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LaneSendError {
    /// The event does not belong to this lane; it was not routed anywhere.
    WrongLane { lane: EventLane, kind: EventKind },
    /// The coordinator's receiver for this lane has closed.
    Closed(EventKind),
}

impl fmt::Display for LaneSendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LaneSendError::WrongLane { lane, kind } => {
                write!(f, "event {kind:?} does not belong to the {lane:?} lane")
            }
            LaneSendError::Closed(kind) => write!(f, "event lane closed for {kind:?}"),
        }
    }
}

impl std::error::Error for LaneSendError {}

/// Sends pty output/exit/failure events to the coordinator's pty lane. Rejects
/// any non-pty event instead of silently routing it.
#[derive(Clone)]
pub(crate) struct PtyEventSender(mpsc::Sender<SessionEvent>);

impl PtyEventSender {
    /// Enqueues a pty-lane event, awaiting bounded capacity. Rejects a
    /// wrong-lane event with [`LaneSendError::WrongLane`].
    pub(crate) async fn send(&self, event: SessionEvent) -> Result<(), LaneSendError> {
        if event.lane() != EventLane::Pty {
            return Err(LaneSendError::WrongLane {
                lane: EventLane::Pty,
                kind: event.kind(),
            });
        }
        let kind = event.kind();
        self.0
            .send(event)
            .await
            .map_err(|_| LaneSendError::Closed(kind))
    }
}

/// Sends every non-pty event to the coordinator's control lane. Rejects a pty
/// event instead of silently routing it.
#[derive(Clone)]
pub(crate) struct ControlEventSender(mpsc::Sender<SessionEvent>);

impl ControlEventSender {
    /// Enqueues a control-lane event, awaiting bounded capacity. Rejects a
    /// wrong-lane (pty) event with [`LaneSendError::WrongLane`].
    pub(crate) async fn send(&self, event: SessionEvent) -> Result<(), LaneSendError> {
        if event.lane() != EventLane::Control {
            return Err(LaneSendError::WrongLane {
                lane: EventLane::Control,
                kind: event.kind(),
            });
        }
        let kind = event.kind();
        self.0
            .send(event)
            .await
            .map_err(|_| LaneSendError::Closed(kind))
    }
}

/// The coordinator-side receivers for the two event lanes.
pub(crate) struct EventLanes {
    pty: mpsc::Receiver<SessionEvent>,
    control: mpsc::Receiver<SessionEvent>,
}

/// Builds the two bounded event lanes using the module capacity constants,
/// returning the typed senders and the coordinator-side receivers.
pub(crate) fn event_lanes() -> (PtyEventSender, ControlEventSender, EventLanes) {
    let (pty_tx, pty_rx) = mpsc::channel(PTY_EVENT_CAPACITY);
    let (control_tx, control_rx) = mpsc::channel(CONTROL_EVENT_CAPACITY);
    (
        PtyEventSender(pty_tx),
        ControlEventSender(control_tx),
        EventLanes {
            pty: pty_rx,
            control: control_rx,
        },
    )
}

// ---- effect routes -----------------------------------------------------

/// Per-route bounded capacities for the six effect channels.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RouteCapacities {
    pub(crate) pty: usize,
    pub(crate) client: usize,
    pub(crate) console: usize,
    pub(crate) metadata: usize,
    pub(crate) timer: usize,
    pub(crate) completion: usize,
}

impl RouteCapacities {
    /// The production capacities drawn from the module constants.
    pub(crate) const DEFAULT: RouteCapacities = RouteCapacities {
        pty: PTY_COMMAND_CAPACITY,
        client: CLIENT_OUTPUT_CAPACITY,
        console: CONSOLE_OUTPUT_CAPACITY,
        metadata: METADATA_COMMAND_CAPACITY,
        timer: TIMER_COMMAND_CAPACITY,
        completion: COMPLETION_CAPACITY,
    };
}

impl Default for RouteCapacities {
    fn default() -> Self {
        RouteCapacities::DEFAULT
    }
}

/// The coordinator-side senders for the six effect routes.
pub(crate) struct EffectRoutes {
    pty: mpsc::Sender<Effect>,
    client: mpsc::Sender<Effect>,
    console: mpsc::Sender<Effect>,
    metadata: mpsc::Sender<Effect>,
    timer: mpsc::Sender<Effect>,
    completion: mpsc::Sender<Effect>,
}

/// The adapter-side receivers for the six effect routes.
pub(crate) struct EffectReceivers {
    pub(crate) pty: mpsc::Receiver<Effect>,
    pub(crate) client: mpsc::Receiver<Effect>,
    pub(crate) console: mpsc::Receiver<Effect>,
    pub(crate) metadata: mpsc::Receiver<Effect>,
    pub(crate) timer: mpsc::Receiver<Effect>,
    pub(crate) completion: mpsc::Receiver<Effect>,
}

impl EffectRoutes {
    /// Builds the six effect routes with the production capacities.
    pub(crate) fn bounded() -> (EffectRoutes, EffectReceivers) {
        Self::with_capacities(RouteCapacities::DEFAULT)
    }

    /// Builds the six effect routes with explicit capacities (test knob for
    /// exercising backpressure with a small bound).
    pub(crate) fn with_capacities(caps: RouteCapacities) -> (EffectRoutes, EffectReceivers) {
        let (pty_tx, pty_rx) = mpsc::channel(caps.pty);
        let (client_tx, client_rx) = mpsc::channel(caps.client);
        let (console_tx, console_rx) = mpsc::channel(caps.console);
        let (metadata_tx, metadata_rx) = mpsc::channel(caps.metadata);
        let (timer_tx, timer_rx) = mpsc::channel(caps.timer);
        let (completion_tx, completion_rx) = mpsc::channel(caps.completion);
        (
            EffectRoutes {
                pty: pty_tx,
                client: client_tx,
                console: console_tx,
                metadata: metadata_tx,
                timer: timer_tx,
                completion: completion_tx,
            },
            EffectReceivers {
                pty: pty_rx,
                client: client_rx,
                console: console_rx,
                metadata: metadata_rx,
                timer: timer_rx,
                completion: completion_rx,
            },
        )
    }

    fn sender(&self, route: EffectRoute) -> &mpsc::Sender<Effect> {
        match route {
            EffectRoute::Pty => &self.pty,
            EffectRoute::Client => &self.client,
            EffectRoute::Console => &self.console,
            EffectRoute::Metadata => &self.metadata,
            EffectRoute::Timer => &self.timer,
            EffectRoute::Completion => &self.completion,
        }
    }
}

// ---- transition context source ----------------------------------------

/// Supplies the clock reading ([`TransitionContext`]) stamped on each event.
/// The pure [`SessionState`] never reads a clock itself; the coordinator injects
/// one per applied event so tests can drive it with deterministic values.
pub(crate) trait TransitionContextSource {
    /// The clock reading for the next event to be applied.
    fn next_context(&mut self) -> TransitionContext;
}

/// The production context source: monotonic milliseconds since construction for
/// the idle clock, plus an ISO-8601 wall-clock string for metadata timestamps.
/// Reading `now_iso` here (outside the pure state) is the intended boundary.
pub(crate) struct SystemTransitionContext {
    start: Instant,
}

impl SystemTransitionContext {
    /// Anchors the monotonic clock at the moment of construction.
    pub(crate) fn new() -> Self {
        SystemTransitionContext {
            start: Instant::now(),
        }
    }
}

impl Default for SystemTransitionContext {
    fn default() -> Self {
        SystemTransitionContext::new()
    }
}

impl TransitionContextSource for SystemTransitionContext {
    fn next_context(&mut self) -> TransitionContext {
        TransitionContext {
            now_ms: self.start.elapsed().as_millis() as i64,
            wall_time: climon_store::paths::now_iso(),
        }
    }
}

// ---- applied-event observer -------------------------------------------

/// Observes each event applied to the state, by payload-free [`EventKind`], so
/// terminal/user bytes never enter a trace or log. Production ignores the hook;
/// tests record the sequence.
pub(crate) trait AppliedEventObserver {
    /// Called once per event applied to the state, in application order.
    fn on_applied(&mut self, kind: EventKind);

    /// Called each time the coordinator is about to block on the arbitration
    /// select with both lanes drained. Production ignores it; a deterministic
    /// test uses it to observe the post-startup park before arranging
    /// simultaneous lane readiness. Defaults to a no-op.
    fn on_park(&mut self) {}
}

/// The production observer: applied events are not recorded anywhere.
pub(crate) struct IgnoreAppliedEvents;

impl AppliedEventObserver for IgnoreAppliedEvents {
    fn on_applied(&mut self, _kind: EventKind) {}
}

// ---- coordinator -------------------------------------------------------

/// The single async task that owns [`SessionState`], arbitrates the two event
/// lanes, and dispatches effects to their exact routes with bounded
/// backpressure.
pub(crate) struct Coordinator<S, O> {
    state: SessionState,
    context: S,
    observer: O,
    routes: EffectRoutes,
    pty_rx: mpsc::Receiver<SessionEvent>,
    control_rx: mpsc::Receiver<SessionEvent>,
    pty_open: bool,
    control_open: bool,
    completed: bool,
}

impl<S, O> Coordinator<S, O>
where
    S: TransitionContextSource,
    O: AppliedEventObserver,
{
    /// Assembles a coordinator from the pure state, an injected context source,
    /// an applied-event observer, the effect-route senders, and the event-lane
    /// receivers.
    pub(crate) fn new(
        state: SessionState,
        context: S,
        observer: O,
        routes: EffectRoutes,
        lanes: EventLanes,
    ) -> Self {
        Coordinator {
            state,
            context,
            observer,
            routes,
            pty_rx: lanes.pty,
            control_rx: lanes.control,
            pty_open: true,
            control_open: true,
            completed: false,
        }
    }

    /// Runs the coordinator until the session completes (a
    /// [`Effect::CompleteSession`] is dispatched), cancellation is requested, or
    /// a fatal condition occurs (both lanes closed, or a required route closed).
    ///
    /// The arbitration bounds control-event latency to at most
    /// [`PTY_DRAIN_BURST`] consecutive pty-lane applications: each loop drains
    /// immediately-available pty events in FIFO order until the running burst
    /// reaches that bound or the lane empties, then processes one
    /// immediately-available control event (which restarts the burst). If
    /// neither lane is immediately ready it blocks on whichever produces the
    /// next event; a pty event that blocking select delivers counts as the
    /// first of the following burst, so the selected pty plus the drain after
    /// it never exceed the bound before control is checked.
    pub(crate) async fn run(mut self, cancel: CancellationToken) -> Result<(), CoordinatorError> {
        let startup = self.state.start();
        self.dispatch_effects(startup).await?;
        if self.completed {
            return Ok(());
        }

        // Consecutive pty-lane applications since the last control check. It is
        // carried across the blocking select so a pty event that select
        // delivers is counted as the first of the next burst rather than
        // starting a fresh bound after it.
        let mut pty_burst = 0usize;

        loop {
            if self.completed || cancel.is_cancelled() {
                return Ok(());
            }

            let mut progressed = false;

            while pty_burst < PTY_DRAIN_BURST {
                match self.pty_rx.try_recv() {
                    Ok(event) => {
                        self.apply_event(event).await?;
                        pty_burst += 1;
                        progressed = true;
                        if self.completed || cancel.is_cancelled() {
                            return Ok(());
                        }
                    }
                    Err(mpsc::error::TryRecvError::Empty) => break,
                    Err(mpsc::error::TryRecvError::Disconnected) => {
                        self.pty_open = false;
                        break;
                    }
                }
            }

            match self.control_rx.try_recv() {
                Ok(event) => {
                    self.apply_event(event).await?;
                    progressed = true;
                    if self.completed || cancel.is_cancelled() {
                        return Ok(());
                    }
                }
                Err(mpsc::error::TryRecvError::Empty) => {}
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    self.control_open = false;
                }
            }

            // Checking the control lane bounds the burst: the next one starts
            // fresh whether or not a control event was waiting.
            pty_burst = 0;

            if progressed {
                continue;
            }

            if !self.pty_open && !self.control_open {
                return Err(CoordinatorError::EventLanesClosed);
            }

            self.observer.on_park();

            let event = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Ok(()),
                maybe = self.pty_rx.recv(), if self.pty_open => match maybe {
                    Some(event) => {
                        // The selected pty event is event one of the next burst.
                        pty_burst = 1;
                        event
                    }
                    None => {
                        self.pty_open = false;
                        continue;
                    }
                },
                maybe = self.control_rx.recv(), if self.control_open => match maybe {
                    Some(event) => {
                        // A selected control event restarts pty burst accounting.
                        pty_burst = 0;
                        event
                    }
                    None => {
                        self.control_open = false;
                        continue;
                    }
                },
            };
            self.apply_event(event).await?;
        }
    }

    /// Applies one event to the state, records its payload-free kind, and
    /// dispatches the resulting effects in order.
    async fn apply_event(&mut self, event: SessionEvent) -> Result<(), CoordinatorError> {
        let kind = event.kind();
        let ctx = self.context.next_context();
        let effects = self.state.apply(event, &ctx);
        self.observer.on_applied(kind);
        self.dispatch_effects(effects).await
    }

    /// Dispatches a batch of effects in [`Vec`] order, awaiting bounded route
    /// capacity between effects. Recovery events synthesized for a closed
    /// console/client route are applied and their effects queued behind the
    /// current batch, which cannot loop because the state's recovery handlers
    /// never re-emit the same failing effect.
    async fn dispatch_effects(&mut self, effects: Vec<Effect>) -> Result<(), CoordinatorError> {
        let mut pending: VecDeque<Effect> = effects.into();
        while let Some(effect) = pending.pop_front() {
            self.dispatch_one(effect, &mut pending).await?;
            if self.completed {
                return Ok(());
            }
        }
        Ok(())
    }

    async fn dispatch_one(
        &mut self,
        effect: Effect,
        pending: &mut VecDeque<Effect>,
    ) -> Result<(), CoordinatorError> {
        match EffectRoute::of(&effect) {
            EffectRoute::Pty => self.send_required(EffectRoute::Pty, effect).await,
            EffectRoute::Metadata => self.send_required(EffectRoute::Metadata, effect).await,
            EffectRoute::Timer => self.send_required(EffectRoute::Timer, effect).await,
            EffectRoute::Completion => {
                self.send_required(EffectRoute::Completion, effect).await?;
                self.completed = true;
                Ok(())
            }
            EffectRoute::Console => self.dispatch_console(effect, pending).await,
            EffectRoute::Client => self.dispatch_client(effect, pending).await,
        }
    }

    /// Delivers an effect to a required route, mapping a closed route to a fatal
    /// [`CoordinatorError::RequiredEffectRouteClosed`].
    async fn send_required(
        &self,
        route: EffectRoute,
        effect: Effect,
    ) -> Result<(), CoordinatorError> {
        self.routes
            .sender(route)
            .send(effect)
            .await
            .map_err(|_| CoordinatorError::RequiredEffectRouteClosed(route))
    }

    /// Dispatches a console effect. A closed console route is recoverable: the
    /// original write's operation id is fed back as
    /// [`SessionEvent::ConsoleWriteFailed`] so the state degrades the local view
    /// rather than failing the core.
    async fn dispatch_console(
        &mut self,
        effect: Effect,
        pending: &mut VecDeque<Effect>,
    ) -> Result<(), CoordinatorError> {
        let operation_id = match &effect {
            Effect::WriteConsole { operation_id, .. } => Some(*operation_id),
            _ => None,
        };
        if self.routes.console.send(effect).await.is_err() {
            if let Some(operation_id) = operation_id {
                self.resynthesize(
                    SessionEvent::ConsoleWriteFailed {
                        operation_id,
                        error: CONSOLE_ROUTE_CLOSED.to_string(),
                    },
                    pending,
                );
            }
        }
        Ok(())
    }

    /// Dispatches a client effect. A closed client route feeds
    /// [`SessionEvent::ClientSendFailed`] back for a `SendClient` (isolating that
    /// client); `CloseClient`/`StopAcceptingClients` are best-effort and dropped
    /// once the client adapter has closed.
    async fn dispatch_client(
        &mut self,
        effect: Effect,
        pending: &mut VecDeque<Effect>,
    ) -> Result<(), CoordinatorError> {
        let send_target = match &effect {
            Effect::SendClient {
                client_id,
                operation_id,
                ..
            } => Some((*client_id, *operation_id)),
            _ => None,
        };
        if self.routes.client.send(effect).await.is_err() {
            if let Some((client_id, operation_id)) = send_target {
                self.resynthesize(
                    SessionEvent::ClientSendFailed {
                        client_id,
                        operation_id,
                    },
                    pending,
                );
            }
        }
        Ok(())
    }

    /// Applies a coordinator-synthesized recovery event to the state, records
    /// its kind, and queues the resulting effects behind the current batch.
    fn resynthesize(&mut self, event: SessionEvent, pending: &mut VecDeque<Effect>) {
        let kind = event.kind();
        let ctx = self.context.next_context();
        let effects = self.state.apply(event, &ctx);
        self.observer.on_applied(kind);
        pending.extend(effects);
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use climon_proto::frame::{FrameDecoder, FrameType};
    use climon_proto::meta::SessionMetaPatch;

    use super::{event_lanes, CoordinatorError, EffectRoute, LaneSendError};
    use crate::engine::effect::{ClientId, Effect, OperationId, TimerId};
    use crate::engine::event::{EventKind, EventLane, SessionEvent};
    use crate::test_support::coordinator::CoordinatorFixture;

    /// Arbitration guarantee: a queued control event is applied no later than
    /// after sixteen queued pty-output events. With 32 pty outputs and a single
    /// `ShutdownRequested` queued before the coordinator runs, the shutdown must
    /// land at applied index 16 at the latest, with only pty output before it.
    #[tokio::test(start_paused = true)]
    async fn control_event_runs_after_at_most_sixteen_pty_output_events() {
        let mut fixture = CoordinatorFixture::headless();
        for i in 0..32u8 {
            fixture.queue_pty_output(&[i]).await;
        }
        fixture.queue_shutdown().await;

        fixture.run_until_applied(17).await;

        let kinds = fixture.applied_kinds();
        assert_eq!(kinds.len(), 17, "applied kinds: {kinds:?}");
        let idx = kinds
            .iter()
            .position(|kind| *kind == EventKind::ShutdownRequested)
            .expect("shutdown was applied");
        assert!(idx <= 16, "shutdown applied at index {idx}");
        assert!(
            kinds[..idx]
                .iter()
                .all(|kind| *kind == EventKind::PtyOutput),
            "only pty output precedes shutdown: {kinds:?}"
        );
    }

    /// Arbitration guarantee across the blocking select: the pty event the
    /// biased select delivers is event one of the next bounded burst, so a
    /// control event queued together with a pty flood still lands after at most
    /// sixteen pty applications — not after the select's pty plus a fresh
    /// sixteen-event drain.
    ///
    /// Unlike the prequeued case above, this drives the coordinator to its
    /// post-startup park with empty lanes, then — from a single producer (this
    /// task) with no yields between sends, so the parked coordinator cannot
    /// interleave — enqueues one `ShutdownRequested` followed by seventeen pty
    /// outputs. Both lanes are therefore ready together when the coordinator
    /// wakes, and the biased select takes pty first. The shutdown must still be
    /// applied at index sixteen at the latest; regressed arbitration that starts
    /// a fresh sixteen-event drain after the selected pty lands it at index 17.
    #[tokio::test(start_paused = true)]
    async fn selected_pty_counts_toward_the_control_arbitration_bound() {
        let mut fixture = CoordinatorFixture::headless();
        fixture.spawn_until_parked().await;

        // Bounded sends complete immediately (lanes have ample capacity) and
        // this task never yields between them, so the parked coordinator stays
        // parked until both lanes hold their events.
        fixture.queue_shutdown().await;
        for i in 0..17u8 {
            fixture.queue_pty_output(&[i]).await;
        }

        fixture.wait_for_applied(18).await;

        let kinds = fixture.applied_kinds();
        let idx = kinds
            .iter()
            .position(|kind| *kind == EventKind::ShutdownRequested)
            .expect("shutdown was applied");
        assert!(
            idx <= 16,
            "shutdown applied at index {idx} (after {idx} pty events): {kinds:?}"
        );
        assert!(
            kinds[..idx]
                .iter()
                .all(|kind| *kind == EventKind::PtyOutput),
            "only pty output precedes shutdown: {kinds:?}"
        );

        let _ = fixture.finish().await;
    }

    // Test 1: pty FIFO — two outputs then an exit keep order, with the exit's
    // effects dispatched after both output effects on the shared client route.
    #[tokio::test(start_paused = true)]
    async fn pty_output_then_exit_preserves_order_with_exit_effects_last() {
        let mut fx = CoordinatorFixture::headless();
        fx.seed_connected_dashboard(1, "dash", 80, 24);
        fx.spawn();
        fx.queue_pty_output(b"1").await;
        fx.queue_pty_output(b"2").await;
        fx.queue_pty_exited(0).await;
        fx.wait_for_applied(3).await;

        let client = fx.drain(EffectRoute::Client);
        assert_eq!(client.len(), 3, "client effects: {client:?}");
        assert_eq!(output_payload(&client[0]), Some(b"1".to_vec()));
        assert_eq!(output_payload(&client[1]), Some(b"2".to_vec()));
        assert!(
            matches!(client[2], Effect::StopAcceptingClients),
            "exit effect after outputs: {:?}",
            client[2]
        );
        let _ = fx.finish().await;
    }

    // Test 2: a lone control event is applied immediately (no pty events, so it
    // is picked up on the first control probe, not via a blocking select).
    #[tokio::test(start_paused = true)]
    async fn control_only_event_is_applied_immediately() {
        let mut fx = CoordinatorFixture::headless();
        fx.queue_shutdown().await;

        fx.run_until_applied(1).await;

        assert_eq!(fx.applied_kinds(), vec![EventKind::ShutdownRequested]);
        let pty = fx.drain(EffectRoute::Pty);
        assert_eq!(pty.len(), 1, "pty effects: {pty:?}");
        assert!(matches!(pty[0], Effect::KillPty { .. }));
    }

    // Test 3: the typed lane senders reject wrong-lane events with an explicit
    // error and never enqueue them, while accepting correct-lane events.
    #[tokio::test]
    async fn lane_senders_reject_wrong_lane_events() {
        let (pty_tx, control_tx, _lanes) = event_lanes();

        let err = pty_tx
            .send(SessionEvent::ShutdownRequested)
            .await
            .unwrap_err();
        assert_eq!(
            err,
            LaneSendError::WrongLane {
                lane: EventLane::Pty,
                kind: EventKind::ShutdownRequested,
            }
        );

        let err = control_tx
            .send(SessionEvent::PtyExited(0))
            .await
            .unwrap_err();
        assert_eq!(
            err,
            LaneSendError::WrongLane {
                lane: EventLane::Control,
                kind: EventKind::PtyExited,
            }
        );

        assert!(pty_tx.send(SessionEvent::PtyOutput(vec![1])).await.is_ok());
        assert!(control_tx
            .send(SessionEvent::ShutdownRequested)
            .await
            .is_ok());
    }

    // Test 4a: every effect variant is categorized to exactly one route.
    #[test]
    fn every_effect_variant_maps_to_its_route() {
        use EffectRoute::*;
        let cases = [
            (
                Effect::WritePty {
                    operation_id: OperationId(0),
                    bytes: vec![],
                },
                Pty,
            ),
            (
                Effect::ResizePty {
                    operation_id: OperationId(0),
                    cols: 1,
                    rows: 1,
                },
                Pty,
            ),
            (
                Effect::KillPty {
                    operation_id: OperationId(0),
                },
                Pty,
            ),
            (
                Effect::SendClient {
                    client_id: ClientId(0),
                    operation_id: OperationId(0),
                    bytes: vec![],
                },
                Client,
            ),
            (
                Effect::CloseClient {
                    client_id: ClientId(0),
                },
                Client,
            ),
            (Effect::StopAcceptingClients, Client),
            (
                Effect::WriteConsole {
                    operation_id: OperationId(0),
                    bytes: vec![],
                },
                Console,
            ),
            (
                Effect::PatchMetadata {
                    operation_id: OperationId(0),
                    patch: SessionMetaPatch::default(),
                    barrier: false,
                },
                Metadata,
            ),
            (
                Effect::PersistScrollback {
                    operation_id: OperationId(0),
                    bytes: vec![],
                },
                Metadata,
            ),
            (
                Effect::ScheduleTimer {
                    timer_id: TimerId(0),
                    generation: 0,
                    delay: Duration::from_millis(1),
                },
                Timer,
            ),
            (
                Effect::CancelTimer {
                    timer_id: TimerId(0),
                    generation: 0,
                },
                Timer,
            ),
            (Effect::CompleteSession { exit_code: 0 }, Completion),
        ];
        for (effect, route) in cases {
            assert_eq!(EffectRoute::of(&effect), route, "{effect:?}");
        }
    }

    // Test 4b: effects sharing a route are dispatched in emission order.
    #[tokio::test(start_paused = true)]
    async fn dispatcher_preserves_effect_order_within_a_route() {
        let mut fx = CoordinatorFixture::headless();
        fx.spawn();
        fx.queue_pty_exited(0).await;

        // Finalization emits PersistScrollback before the terminal-status
        // barrier patch — both on the metadata route, in that order.
        let first = fx.next_effect(EffectRoute::Metadata).await.unwrap();
        let second = fx.next_effect(EffectRoute::Metadata).await.unwrap();
        assert!(
            matches!(first, Effect::PersistScrollback { .. }),
            "{first:?}"
        );
        assert!(
            matches!(second, Effect::PatchMetadata { barrier: true, .. }),
            "{second:?}"
        );
        let _ = fx.finish().await;
    }

    // Test 5: a full route backpressures the dispatcher (it awaits capacity)
    // and resumes once the adapter receives, with no timers or sleeps.
    #[tokio::test(start_paused = true)]
    async fn dispatcher_backpressures_on_full_route_and_resumes_after_receive() {
        let caps = super::RouteCapacities {
            client: 1,
            ..super::RouteCapacities::DEFAULT
        };
        let mut fx = CoordinatorFixture::with_capacities(false, caps);
        fx.seed_connected_dashboard(1, "dash", 80, 24);
        fx.seed_connected_dashboard(2, "dash2", 80, 24);
        fx.spawn();

        // One output broadcasts to both clients: two SendClient effects, but the
        // client route holds only one. The first is buffered; the second blocks.
        fx.queue_pty_output(b"x").await;
        fx.wait_for_applied(1).await;

        assert!(
            fx.try_effect(EffectRoute::Client).is_some(),
            "first buffered"
        );
        assert!(
            fx.try_effect(EffectRoute::Client).is_none(),
            "second blocked on capacity"
        );

        // Receiving the first frees capacity; the coordinator delivers the second.
        assert!(fx.next_effect(EffectRoute::Client).await.is_some());
        let _ = fx.finish().await;
    }

    // Test 6: a closed required route (pty) is a fatal coordinator error.
    #[tokio::test(start_paused = true)]
    async fn closed_pty_route_is_a_required_route_error() {
        let mut fx = CoordinatorFixture::headless();
        fx.close_route(EffectRoute::Pty);
        fx.spawn();
        fx.queue_shutdown().await; // -> KillPty -> closed pty route

        let result = fx.join().await;
        assert_eq!(
            result,
            Err(CoordinatorError::RequiredEffectRouteClosed(
                EffectRoute::Pty
            ))
        );
    }

    // Test 7: a closed console route is recoverable — the coordinator
    // synthesizes ConsoleWriteFailed with the original op, and finalization
    // still runs to completion with no core failure.
    #[tokio::test(start_paused = true)]
    async fn closed_console_route_synthesizes_failure_and_finalizes() {
        let mut fx = CoordinatorFixture::attached();
        // A dashboard takes control, displacing the local terminal so the
        // exit-time restore emits a console write.
        fx.seed_connected_dashboard(1, "dash", 80, 24);
        fx.seed_take_control(1);
        fx.close_route(EffectRoute::Console);
        fx.spawn();
        fx.queue_pty_exited(0).await;

        // Advance past the terminal-status barrier.
        let _persist = fx.next_effect(EffectRoute::Metadata).await.unwrap();
        let barrier = fx.next_effect(EffectRoute::Metadata).await.unwrap();
        let op = barrier_op(&barrier).expect("terminal-status barrier");
        fx.queue_metadata_completed(op).await;

        // The restore console write fails on the closed route; the synthesized
        // ConsoleWriteFailed advances teardown to completion.
        let complete = fx.next_effect(EffectRoute::Completion).await.unwrap();
        assert_eq!(complete_code(&complete), Some(0));
        assert!(
            fx.applied_kinds().contains(&EventKind::ConsoleWriteFailed),
            "console failure synthesized: {:?}",
            fx.applied_kinds()
        );
        assert_eq!(fx.join().await, Ok(()));
    }

    // Test 8: a closed client route isolates the failing client (via a
    // synthesized ClientSendFailed) without repeated failures, while healthy
    // routes keep flowing.
    #[tokio::test(start_paused = true)]
    async fn closed_client_route_isolates_client_and_continues() {
        let mut fx = CoordinatorFixture::headless();
        fx.seed_connected_dashboard(1, "dash", 80, 24);
        fx.close_route(EffectRoute::Client);
        fx.spawn();

        // First broadcast: the send fails, the client is isolated.
        fx.queue_pty_output(b"a").await;
        fx.wait_for_applied(2).await; // PtyOutput + synthesized ClientSendFailed
                                      // Second broadcast: the client is gone, so no further send/failure.
        fx.queue_pty_output(b"b").await;
        fx.wait_for_applied(3).await;

        let kinds = fx.applied_kinds();
        let failures = kinds
            .iter()
            .filter(|k| **k == EventKind::ClientSendFailed)
            .count();
        assert_eq!(failures, 1, "client isolated after one failure: {kinds:?}");

        // Healthy effects continue: a pty exit still drives metadata effects.
        fx.queue_pty_exited(0).await;
        assert!(
            fx.next_effect(EffectRoute::Metadata).await.is_some(),
            "healthy metadata route keeps flowing"
        );
        assert_eq!(fx.finish().await, Ok(()));
    }

    // Test 9: firing a timer at a stale generation produces no effects through
    // the real coordinator (the state's generation guard rejects it).
    #[tokio::test(start_paused = true)]
    async fn stale_timer_generation_produces_no_effects() {
        let mut fx = CoordinatorFixture::headless();
        fx.spawn();

        // Startup schedules the idle timer at generation 0.
        let schedule = fx.next_effect(EffectRoute::Timer).await.unwrap();
        let (timer_id, generation) = match schedule {
            Effect::ScheduleTimer {
                timer_id,
                generation,
                ..
            } => (timer_id, generation),
            other => panic!("expected idle schedule, got {other:?}"),
        };

        // Firing the live generation reschedules (bumping to a new generation).
        fx.queue_timer_fired(timer_id, generation).await;
        let reschedule = fx.next_effect(EffectRoute::Timer).await.unwrap();
        assert!(matches!(reschedule, Effect::ScheduleTimer { .. }));

        // Firing the now-stale old generation yields nothing on any route.
        fx.queue_timer_fired(timer_id, generation).await;
        fx.wait_for_applied(2).await;
        assert!(fx.try_effect(EffectRoute::Timer).is_none());
        assert!(fx.try_effect(EffectRoute::Metadata).is_none());
        assert!(fx.try_effect(EffectRoute::Pty).is_none());
        let _ = fx.finish().await;
    }

    // Test 10: if both event lanes close before completion, the coordinator
    // ends with an explicit EventLanesClosed error.
    #[tokio::test(start_paused = true)]
    async fn both_event_lanes_closed_before_completion_errors() {
        let mut fx = CoordinatorFixture::headless();
        fx.spawn();
        fx.close_event_lanes();

        assert_eq!(fx.join().await, Err(CoordinatorError::EventLanesClosed));
    }

    // Test 11: CompleteSession is dispatched exactly once, after which the
    // coordinator exits cleanly and the completion route closes.
    #[tokio::test(start_paused = true)]
    async fn complete_session_is_dispatched_once_and_coordinator_exits() {
        let mut fx = CoordinatorFixture::headless();
        fx.spawn();
        fx.queue_pty_exited(7).await;

        let _persist = fx.next_effect(EffectRoute::Metadata).await.unwrap();
        let barrier = fx.next_effect(EffectRoute::Metadata).await.unwrap();
        let op = barrier_op(&barrier).expect("terminal-status barrier");
        fx.queue_metadata_completed(op).await;

        let complete = fx.next_effect(EffectRoute::Completion).await.unwrap();
        assert_eq!(complete_code(&complete), Some(7));
        assert!(
            fx.next_effect(EffectRoute::Completion).await.is_none(),
            "completion route closes as the coordinator exits"
        );
        assert_eq!(fx.join().await, Ok(()));
    }

    // ---- test helpers ----------------------------------------------------

    /// The decoded payload of a `SendClient` effect carrying an `Output` frame.
    fn output_payload(effect: &Effect) -> Option<Vec<u8>> {
        let Effect::SendClient { bytes, .. } = effect else {
            return None;
        };
        let frames = FrameDecoder::new().push(bytes);
        let frame = frames.first()?;
        (frame.frame_type == FrameType::Output).then(|| frame.payload.clone())
    }

    /// The operation id of a barrier `PatchMetadata` effect.
    fn barrier_op(effect: &Effect) -> Option<OperationId> {
        match effect {
            Effect::PatchMetadata {
                operation_id,
                barrier: true,
                ..
            } => Some(*operation_id),
            _ => None,
        }
    }

    /// The exit code of a `CompleteSession` effect.
    fn complete_code(effect: &Effect) -> Option<i32> {
        match effect {
            Effect::CompleteSession { exit_code } => Some(*exit_code),
            _ => None,
        }
    }
}
