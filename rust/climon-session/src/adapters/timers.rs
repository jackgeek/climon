//! Timers adapter: the single async manager that owns the timer effect route and
//! turns [`Effect::ScheduleTimer`] / [`Effect::CancelTimer`] into
//! generation-safe [`SessionEvent::TimerFired`] events.
//!
//! The coordinator dispatches timer effects to a bounded `mpsc` route; this
//! manager drains that receiver directly and owns a [`tokio::task::JoinSet`] of
//! every live timer task plus a `TimerId -> {generation, cancel token}` map.
//! Each scheduled timer is one owned async task that
//! [`sleep_until`](tokio::time::sleep_until)s its deadline and then emits
//! `TimerFired { id, generation }`; scheduling the same id again cancels the
//! prior task first, so at most one task per id is live.
//!
//! Generation discipline keeps a stale schedule from firing or evicting the
//! current one:
//! - a **cancel** only cancels when its generation matches the live one exactly;
//!   a stale cancel is a no-op.
//! - a **reaped** task only removes its map entry when the entry still refers to
//!   that same generation, so reaping an old generation cannot evict the current.
//!
//! When the route closes the manager cancels and joins every task and returns
//! `Ok(())`. A non-timer effect stops it with a typed
//! [`TimerAdapterError::UnexpectedEffect`]; a timer task that finds the event
//! lane closed while emitting propagates [`TimerAdapterError::EventLaneClosed`]
//! *after* the manager has cancelled and joined the rest. No task is detached.
//!
//! [`Effect::ScheduleTimer`]: crate::engine::effect::Effect::ScheduleTimer
//! [`Effect::CancelTimer`]: crate::engine::effect::Effect::CancelTimer
//! [`SessionEvent::TimerFired`]: crate::engine::event::SessionEvent::TimerFired

// Every item below is exercised by this module's tests now and wired into the
// supervisor (Task 14) later, so — like the other adapters it mirrors — the
// module carries a crate-staged `dead_code` allowance until that wiring lands.
#![allow(dead_code)]

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use crate::engine::coordinator::ControlEventSender;
use crate::engine::effect::{Effect, TimerId};
use crate::engine::event::SessionEvent;

// ---- errors ------------------------------------------------------------

/// A failure that ends [`run_timer_adapter`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TimerAdapterError {
    /// An effect that is neither [`Effect::ScheduleTimer`] nor
    /// [`Effect::CancelTimer`] reached the timer route. Carries the offending
    /// variant's payload-free name.
    UnexpectedEffect(&'static str),
    /// The control event lane closed while a timer task was emitting a
    /// [`SessionEvent::TimerFired`], so it could not be delivered. The manager
    /// reports this (after cleanup) rather than exiting silently.
    EventLaneClosed,
}

impl fmt::Display for TimerAdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TimerAdapterError::UnexpectedEffect(name) => {
                write!(f, "unexpected non-timer effect on the timer route: {name}")
            }
            TimerAdapterError::EventLaneClosed => write!(
                f,
                "control event lane closed before a timer event was delivered"
            ),
        }
    }
}

impl std::error::Error for TimerAdapterError {}

/// A payload-free name for an effect variant, used only to describe an
/// unexpected effect without carrying its terminal/user bytes.
fn effect_variant_name(effect: &Effect) -> &'static str {
    match effect {
        Effect::WritePty { .. } => "WritePty",
        Effect::ResizePty { .. } => "ResizePty",
        Effect::KillPty { .. } => "KillPty",
        Effect::SendClient { .. } => "SendClient",
        Effect::CloseClient { .. } => "CloseClient",
        Effect::StopAcceptingClients => "StopAcceptingClients",
        Effect::WriteConsole { .. } => "WriteConsole",
        Effect::PatchMetadata { .. } => "PatchMetadata",
        Effect::PersistScrollback { .. } => "PersistScrollback",
        Effect::ScheduleTimer { .. } => "ScheduleTimer",
        Effect::CancelTimer { .. } => "CancelTimer",
        Effect::CompleteSession { .. } => "CompleteSession",
    }
}

// ---- event sink --------------------------------------------------------

/// Delivers the single event kind the timer adapter emits
/// ([`SessionEvent::TimerFired`]) back to the coordinator. Implemented for
/// [`ControlEventSender`] in production; a closed lane must be reported as
/// [`TimerAdapterError::EventLaneClosed`]. Timer tasks are async, so `emit` is
/// async; it is cloned into each task, hence the `Clone` bound.
pub(crate) trait TimerEventSink: Clone + Send + 'static {
    /// Emits `event`, resolving once it has been accepted (awaiting bounded
    /// capacity) or failing if the lane has closed.
    fn emit(
        &self,
        event: SessionEvent,
    ) -> impl Future<Output = Result<(), TimerAdapterError>> + Send;
}

impl TimerEventSink for ControlEventSender {
    // `async fn` cannot add the `+ Send` bound the spawned timer tasks require on
    // the returned future, so `emit` is desugared by hand (as in the other
    // adapters).
    #[allow(clippy::manual_async_fn)]
    fn emit(
        &self,
        event: SessionEvent,
    ) -> impl Future<Output = Result<(), TimerAdapterError>> + Send {
        async move {
            // A `TimerFired` is always a control-lane event, so `WrongLane` is
            // unreachable; a closed lane is the only reachable failure.
            self.send(event)
                .await
                .map_err(|_| TimerAdapterError::EventLaneClosed)
        }
    }
}

// ---- commands ----------------------------------------------------------

/// The internal representation of a timer effect after it has been validated off
/// the route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TimerCommand {
    /// Schedule (or reschedule) `TimerId` at `generation` to fire after the
    /// delay.
    Schedule(TimerId, u64, Duration),
    /// Cancel `TimerId` if its live schedule is exactly `generation`.
    Cancel(TimerId, u64),
}

impl TimerCommand {
    /// Validates an effect off the timer route, rejecting anything that is not a
    /// schedule or cancel.
    fn from_effect(effect: Effect) -> Result<TimerCommand, TimerAdapterError> {
        match effect {
            Effect::ScheduleTimer {
                timer_id,
                generation,
                delay,
            } => Ok(TimerCommand::Schedule(timer_id, generation, delay)),
            Effect::CancelTimer {
                timer_id,
                generation,
            } => Ok(TimerCommand::Cancel(timer_id, generation)),
            other => Err(TimerAdapterError::UnexpectedEffect(effect_variant_name(
                &other,
            ))),
        }
    }
}

// ---- timer tasks -------------------------------------------------------

/// The result a timer task reports when it finishes, tagged with the id and
/// generation it belonged to so the manager can reconcile it against the live
/// map without evicting a newer schedule.
struct TimerOutcome {
    timer_id: TimerId,
    generation: u64,
    result: FireResult,
}

/// How a timer task ended.
enum FireResult {
    /// The deadline elapsed and `TimerFired` was delivered.
    Fired,
    /// The task was cancelled before its deadline (reschedule/cancel/teardown).
    Cancelled,
    /// The deadline elapsed but the event lane had closed, so the fire could not
    /// be delivered.
    LaneClosed,
}

/// The live bookkeeping for a scheduled id: its current generation and the token
/// that cancels its task.
struct LiveTimer {
    generation: u64,
    cancel: CancellationToken,
}

/// Applies one validated command to the live timer set.
///
/// A `Schedule` cancels any prior task for the id, spawns a new task that sleeps
/// to its deadline and emits `TimerFired`, and records it. A `Cancel` cancels and
/// removes the id **only** when its generation matches the live one exactly (a
/// stale cancel is a no-op).
fn apply_command<E: TimerEventSink>(
    join_set: &mut JoinSet<TimerOutcome>,
    live: &mut HashMap<TimerId, LiveTimer>,
    events: &E,
    command: TimerCommand,
) {
    match command {
        TimerCommand::Schedule(timer_id, generation, delay) => {
            // Reschedule replaces any prior schedule for this id.
            if let Some(previous) = live.remove(&timer_id) {
                previous.cancel.cancel();
            }
            let cancel = CancellationToken::new();
            let deadline = tokio::time::Instant::now() + delay;
            let task_events = events.clone();
            let task_cancel = cancel.clone();
            join_set.spawn(async move {
                tokio::select! {
                    _ = tokio::time::sleep_until(deadline) => {
                        match task_events
                            .emit(SessionEvent::TimerFired { timer_id, generation })
                            .await
                        {
                            Ok(()) => TimerOutcome {
                                timer_id,
                                generation,
                                result: FireResult::Fired,
                            },
                            Err(_) => TimerOutcome {
                                timer_id,
                                generation,
                                result: FireResult::LaneClosed,
                            },
                        }
                    }
                    _ = task_cancel.cancelled() => TimerOutcome {
                        timer_id,
                        generation,
                        result: FireResult::Cancelled,
                    },
                }
            });
            live.insert(timer_id, LiveTimer { generation, cancel });
        }
        TimerCommand::Cancel(timer_id, generation) => {
            if let Some(timer) = live.get(&timer_id) {
                // Only an exact-generation cancel cancels the live schedule; a
                // stale cancel cannot cancel the current one.
                if timer.generation == generation {
                    timer.cancel.cancel();
                    live.remove(&timer_id);
                }
            }
        }
    }
}

/// Reaps one finished timer task. The map entry is removed only when it still
/// refers to that task's exact generation, so reaping an *old* generation cannot
/// evict the current schedule. Returns [`TimerAdapterError::EventLaneClosed`]
/// when the task reported a closed lane.
fn reap(
    live: &mut HashMap<TimerId, LiveTimer>,
    joined: Result<TimerOutcome, tokio::task::JoinError>,
) -> Result<(), TimerAdapterError> {
    let outcome = match joined {
        Ok(outcome) => outcome,
        // A timer task never panics; a `JoinError` can only be a runtime abort
        // during teardown, which needs no bookkeeping.
        Err(_) => return Ok(()),
    };
    if let Some(timer) = live.get(&outcome.timer_id) {
        if timer.generation == outcome.generation {
            live.remove(&outcome.timer_id);
        }
    }
    match outcome.result {
        FireResult::LaneClosed => Err(TimerAdapterError::EventLaneClosed),
        FireResult::Fired | FireResult::Cancelled => Ok(()),
    }
}

/// Cancels every live timer (used during teardown before the join set is
/// drained).
fn cancel_all(live: &mut HashMap<TimerId, LiveTimer>) {
    for (_id, timer) in live.drain() {
        timer.cancel.cancel();
    }
}

// ---- adapter loop ------------------------------------------------------

/// Runs the timer manager to completion: drain the timer effect route, apply each
/// command to the owned join set / live map, and reap finished tasks. The route
/// closing is the normal end and returns `Ok(())`; an unexpected effect or a
/// closed event lane ends it with the corresponding typed error. In every case
/// it first cancels and joins every outstanding task, so no task is ever
/// detached.
pub(crate) async fn run_timer_adapter<E: TimerEventSink>(
    mut effects: mpsc::Receiver<Effect>,
    events: E,
) -> Result<(), TimerAdapterError> {
    let mut join_set: JoinSet<TimerOutcome> = JoinSet::new();
    let mut live: HashMap<TimerId, LiveTimer> = HashMap::new();

    let outcome = loop {
        tokio::select! {
            maybe_effect = effects.recv() => match maybe_effect {
                None => break Ok(()),
                Some(effect) => match TimerCommand::from_effect(effect) {
                    Ok(command) => apply_command(&mut join_set, &mut live, &events, command),
                    Err(error) => break Err(error),
                },
            },
            Some(joined) = join_set.join_next(), if !join_set.is_empty() => {
                if let Err(error) = reap(&mut live, joined) {
                    break Err(error);
                }
            }
        }
    };

    // Cleanup on every exit path: cancel every live timer and join all
    // outstanding tasks so none is detached.
    cancel_all(&mut live);
    while join_set.join_next().await.is_some() {}
    outcome
}

/// Spawns [`run_timer_adapter`] as an owned async task and returns its handle. No
/// task is detached; the supervisor (Task 14) owns and later joins it.
pub(crate) fn spawn_timer_adapter<E: TimerEventSink>(
    effects: mpsc::Receiver<Effect>,
    events: E,
) -> JoinHandle<Result<(), TimerAdapterError>> {
    tokio::spawn(run_timer_adapter(effects, events))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::sync::mpsc;
    use tokio::task::JoinHandle;

    use super::{run_timer_adapter, TimerAdapterError, TimerCommand, TimerEventSink};
    use crate::engine::effect::{Effect, OperationId, TimerId};
    use crate::engine::event::SessionEvent;

    const CHANNEL_CAPACITY: usize = 64;
    const ANTI_HANG: Duration = Duration::from_secs(5);

    // ---- fake event sink -------------------------------------------------

    /// A [`TimerEventSink`] backed by a Tokio mpsc so tests can `recv().await`
    /// fired events; a `closed` flag simulates a closed control lane. It also
    /// carries a liveness token so a test can prove every task (and the manager)
    /// dropped its sink clone — i.e. nothing was detached.
    #[derive(Clone)]
    struct MpscTimerSink {
        tx: mpsc::Sender<SessionEvent>,
        closed: Arc<AtomicBool>,
        liveness: Arc<()>,
    }

    impl TimerEventSink for MpscTimerSink {
        #[allow(clippy::manual_async_fn)]
        fn emit(
            &self,
            event: SessionEvent,
        ) -> impl std::future::Future<Output = Result<(), TimerAdapterError>> + Send {
            let tx = self.tx.clone();
            let closed = self.closed.clone();
            async move {
                if closed.load(Ordering::SeqCst) {
                    return Err(TimerAdapterError::EventLaneClosed);
                }
                tx.send(event)
                    .await
                    .map_err(|_| TimerAdapterError::EventLaneClosed)
            }
        }
    }

    struct TimerHarness {
        sink: MpscTimerSink,
        events: mpsc::Receiver<SessionEvent>,
        closed: Arc<AtomicBool>,
        liveness: Arc<()>,
    }

    fn harness() -> TimerHarness {
        let (tx, events) = mpsc::channel(CHANNEL_CAPACITY);
        let closed = Arc::new(AtomicBool::new(false));
        let liveness = Arc::new(());
        TimerHarness {
            sink: MpscTimerSink {
                tx,
                closed: closed.clone(),
                liveness: liveness.clone(),
            },
            events,
            closed,
            liveness,
        }
    }

    /// A command-level sender for the timer manager: it converts a
    /// [`TimerCommand`] to its [`Effect`] and forwards it onto the production
    /// effect route, so a test can drive the manager with commands while
    /// production consumes `Effect` directly.
    struct TimerCommandSender {
        tx: mpsc::Sender<Effect>,
    }

    impl TimerCommandSender {
        async fn send(&self, command: TimerCommand) -> Result<(), mpsc::error::SendError<Effect>> {
            let effect = match command {
                TimerCommand::Schedule(timer_id, generation, delay) => Effect::ScheduleTimer {
                    timer_id,
                    generation,
                    delay,
                },
                TimerCommand::Cancel(timer_id, generation) => Effect::CancelTimer {
                    timer_id,
                    generation,
                },
            };
            self.tx.send(effect).await
        }
    }

    /// Spawns the timer manager wired to an mpsc event sink, returning the
    /// command sender, the event receiver, and the owned manager handle.
    fn spawn_timer_adapter() -> (
        TimerCommandSender,
        mpsc::Receiver<SessionEvent>,
        JoinHandle<Result<(), TimerAdapterError>>,
    ) {
        let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
        let TimerHarness { sink, events, .. } = harness();
        let handle = tokio::spawn(run_timer_adapter(rx, sink));
        (TimerCommandSender { tx }, events, handle)
    }

    /// Yields enough times that the spawned manager processes every already-sent
    /// command before the test advances the paused clock. No wall-clock time
    /// passes; this only reorders cooperative scheduling.
    async fn settle() {
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
    }

    // ---- tests -----------------------------------------------------------

    // Step 4 (plan RED → GREEN): a cancelled generation never fires.
    #[tokio::test(start_paused = true)]
    async fn cancelled_generation_never_fires() {
        let (tx, mut events, _task) = spawn_timer_adapter();
        tx.send(TimerCommand::Schedule(
            TimerId(2),
            1,
            Duration::from_secs(1),
        ))
        .await
        .unwrap();
        tx.send(TimerCommand::Cancel(TimerId(2), 1)).await.unwrap();
        tokio::time::advance(Duration::from_secs(2)).await;
        assert!(events.try_recv().is_err());
    }

    // A timer fires exactly at its deadline, carrying its id and generation.
    #[tokio::test(start_paused = true)]
    async fn fires_at_deadline_with_id_and_generation() {
        let (tx, mut events, _task) = spawn_timer_adapter();
        tx.send(TimerCommand::Schedule(
            TimerId(5),
            7,
            Duration::from_secs(2),
        ))
        .await
        .unwrap();
        settle().await;
        // Before the deadline: nothing has fired.
        tokio::time::advance(Duration::from_millis(1_999)).await;
        settle().await;
        assert!(events.try_recv().is_err());
        // At the deadline: exactly one TimerFired { 5, 7 }.
        tokio::time::advance(Duration::from_millis(1)).await;
        match tokio::time::timeout(ANTI_HANG, events.recv())
            .await
            .expect("fire timed out")
            .expect("event lane closed")
        {
            SessionEvent::TimerFired {
                timer_id,
                generation,
            } => {
                assert_eq!(timer_id, TimerId(5));
                assert_eq!(generation, 7);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    // Rescheduling the same id cancels the old generation; only the new fires.
    #[tokio::test(start_paused = true)]
    async fn reschedule_cancels_old_only_new_fires() {
        let (tx, mut events, _task) = spawn_timer_adapter();
        tx.send(TimerCommand::Schedule(
            TimerId(1),
            1,
            Duration::from_secs(5),
        ))
        .await
        .unwrap();
        settle().await;
        tx.send(TimerCommand::Schedule(
            TimerId(1),
            2,
            Duration::from_secs(1),
        ))
        .await
        .unwrap();
        settle().await;
        tokio::time::advance(Duration::from_secs(1)).await;
        match tokio::time::timeout(ANTI_HANG, events.recv())
            .await
            .expect("fire timed out")
            .expect("event lane closed")
        {
            SessionEvent::TimerFired {
                timer_id,
                generation,
            } => {
                assert_eq!(timer_id, TimerId(1));
                assert_eq!(generation, 2);
            }
            other => panic!("unexpected event: {other:?}"),
        }
        // Past the old generation's original deadline: it never fires.
        tokio::time::advance(Duration::from_secs(10)).await;
        settle().await;
        assert!(events.try_recv().is_err());
    }

    // A stale cancel cannot cancel the current generation; a matching one does.
    #[tokio::test(start_paused = true)]
    async fn stale_cancel_ignored_matching_cancels() {
        let (tx, mut events, _task) = spawn_timer_adapter();
        // Live generation 2; a cancel for generation 1 is stale and ignored.
        tx.send(TimerCommand::Schedule(
            TimerId(3),
            2,
            Duration::from_secs(1),
        ))
        .await
        .unwrap();
        settle().await;
        tx.send(TimerCommand::Cancel(TimerId(3), 1)).await.unwrap();
        settle().await;
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(matches!(
            tokio::time::timeout(ANTI_HANG, events.recv())
                .await
                .expect("fire timed out")
                .expect("event lane closed"),
            SessionEvent::TimerFired {
                timer_id: TimerId(3),
                generation: 2,
            }
        ));
        // A matching cancel does stop a live schedule.
        tx.send(TimerCommand::Schedule(
            TimerId(3),
            3,
            Duration::from_secs(1),
        ))
        .await
        .unwrap();
        settle().await;
        tx.send(TimerCommand::Cancel(TimerId(3), 3)).await.unwrap();
        settle().await;
        tokio::time::advance(Duration::from_secs(2)).await;
        settle().await;
        assert!(events.try_recv().is_err());
    }

    // Multiple ids fire in deadline order.
    #[tokio::test(start_paused = true)]
    async fn multiple_timers_fire_in_deadline_order() {
        let (tx, mut events, _task) = spawn_timer_adapter();
        tx.send(TimerCommand::Schedule(
            TimerId(10),
            1,
            Duration::from_secs(3),
        ))
        .await
        .unwrap();
        settle().await;
        tx.send(TimerCommand::Schedule(
            TimerId(11),
            1,
            Duration::from_secs(1),
        ))
        .await
        .unwrap();
        settle().await;
        tx.send(TimerCommand::Schedule(
            TimerId(12),
            1,
            Duration::from_secs(2),
        ))
        .await
        .unwrap();
        settle().await;
        tokio::time::advance(Duration::from_secs(3)).await;
        let mut order = Vec::new();
        for _ in 0..3 {
            match tokio::time::timeout(ANTI_HANG, events.recv())
                .await
                .expect("fire timed out")
                .expect("event lane closed")
            {
                SessionEvent::TimerFired { timer_id, .. } => order.push(timer_id),
                other => panic!("unexpected event: {other:?}"),
            }
        }
        assert_eq!(order, vec![TimerId(11), TimerId(12), TimerId(10)]);
    }

    // Simultaneous timers all fire (order unspecified).
    #[tokio::test(start_paused = true)]
    async fn simultaneous_timers_all_fire() {
        let (tx, mut events, _task) = spawn_timer_adapter();
        for id in [20u64, 21, 22] {
            tx.send(TimerCommand::Schedule(
                TimerId(id),
                1,
                Duration::from_secs(1),
            ))
            .await
            .unwrap();
            settle().await;
        }
        tokio::time::advance(Duration::from_secs(1)).await;
        let mut fired = Vec::new();
        for _ in 0..3 {
            match tokio::time::timeout(ANTI_HANG, events.recv())
                .await
                .expect("fire timed out")
                .expect("event lane closed")
            {
                SessionEvent::TimerFired { timer_id, .. } => fired.push(timer_id.0),
                other => panic!("unexpected event: {other:?}"),
            }
        }
        fired.sort_unstable();
        assert_eq!(fired, vec![20, 21, 22]);
    }

    // Closing the route cancels and joins every task, returning Ok — and no task
    // is left detached (every sink clone is dropped).
    #[tokio::test(start_paused = true)]
    async fn route_close_cancels_and_joins() {
        let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
        let TimerHarness {
            sink,
            mut events,
            liveness,
            ..
        } = harness();
        let handle = tokio::spawn(run_timer_adapter(rx, sink));
        let sender = TimerCommandSender { tx };
        sender
            .send(TimerCommand::Schedule(
                TimerId(1),
                1,
                Duration::from_secs(10),
            ))
            .await
            .unwrap();
        settle().await;
        // Close the route: the manager cancels + joins the outstanding timer.
        drop(sender);
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("manager join timed out")
            .expect("manager task panicked");
        assert_eq!(result, Ok(()));
        assert!(events.try_recv().is_err());
        // Every timer task and the manager dropped its sink clone: nothing was
        // detached, so only the test's liveness reference remains.
        assert_eq!(Arc::strong_count(&liveness), 1);
    }

    // A non-timer effect stops the manager with a typed error (after cleanup).
    #[tokio::test]
    async fn unexpected_effect_is_typed_error() {
        let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
        let TimerHarness { sink, .. } = harness();
        let handle = tokio::spawn(run_timer_adapter(rx, sink));
        tx.send(Effect::WritePty {
            operation_id: OperationId(1),
            bytes: b"x".to_vec(),
        })
        .await
        .unwrap();
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("manager join timed out")
            .expect("manager task panicked");
        assert_eq!(result, Err(TimerAdapterError::UnexpectedEffect("WritePty")));
    }

    // A timer that fires into a closed event lane propagates the typed error
    // through the manager after cleanup.
    #[tokio::test(start_paused = true)]
    async fn closed_lane_propagates_after_fire() {
        let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
        let TimerHarness {
            sink,
            closed,
            liveness,
            ..
        } = harness();
        let handle = tokio::spawn(run_timer_adapter(rx, sink));
        tx.send(Effect::ScheduleTimer {
            timer_id: TimerId(9),
            generation: 1,
            delay: Duration::from_secs(1),
        })
        .await
        .unwrap();
        settle().await;
        // Close the lane, then let the timer fire into it.
        closed.store(true, Ordering::SeqCst);
        tokio::time::advance(Duration::from_secs(1)).await;
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("manager join timed out")
            .expect("manager task panicked");
        assert_eq!(result, Err(TimerAdapterError::EventLaneClosed));
        // Cleanup joined every task first: nothing detached.
        assert_eq!(Arc::strong_count(&liveness), 1);
    }
}
