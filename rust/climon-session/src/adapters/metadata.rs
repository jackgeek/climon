//! Ordered metadata adapter: the single async task that owns the metadata
//! effect route and applies each [`Effect::PatchMetadata`] /
//! [`Effect::PersistScrollback`] to the store in strict FIFO order.
//!
//! The coordinator dispatches metadata effects to a bounded `mpsc` route; this
//! adapter drains that receiver ([`EffectReceivers::metadata`]) directly, so no
//! extra bridge stands between the two. Every store call is blocking (`std::fs`
//! under `climon_store`), so each attempt is offloaded to
//! [`tokio::task::spawn_blocking`]; filesystem work never runs on a Tokio worker.
//! One command is fully resolved — including all retries — before the next is
//! read, preserving exact FIFO and the lifecycle barrier ordering. The first
//! implementation performs no coalescing, so a `barrier` patch is recognized but
//! never crossed or absorbed.
//!
//! On success the adapter emits [`SessionEvent::MetadataCompleted`] carrying the
//! original operation id; on exhausted failure it emits
//! [`SessionEvent::MetadataFailed`]. Both travel the injected control event
//! sink; a closed lane surfaces as an explicit [`MetadataAdapterError`] rather
//! than a silent exit.
//!
//! [`EffectReceivers::metadata`]: crate::engine::coordinator::EffectReceivers
//! [`Effect::PatchMetadata`]: crate::engine::effect::Effect::PatchMetadata
//! [`Effect::PersistScrollback`]: crate::engine::effect::Effect::PersistScrollback

// Every item below is exercised by this module's tests now and wired into the
// supervisor (Task 14) later, so — like the effect/event/coordinator vocabulary
// it builds on — the module carries a crate-staged `dead_code` allowance until
// that wiring lands.
#![allow(dead_code)]

use std::fmt;
use std::future::Future;
use std::sync::Arc;

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use climon_proto::meta::SessionMetaPatch;
use climon_store::meta::write_scrollback;
use climon_store::patch::patch_session_meta;
use climon_store::paths::Env;

use crate::engine::coordinator::ControlEventSender;
use crate::engine::effect::{Effect, OperationId};
use crate::engine::event::SessionEvent;

// ---- errors ------------------------------------------------------------

/// A failure that ends [`run_metadata_adapter`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MetadataAdapterError {
    /// An effect that is neither [`Effect::PatchMetadata`] nor
    /// [`Effect::PersistScrollback`] reached the metadata adapter. Carries the
    /// offending variant's payload-free name so no terminal/user bytes leak.
    UnexpectedEffect(&'static str),
    /// The control event lane closed, so a completion/failure event could not
    /// be delivered. The adapter reports this rather than exiting silently.
    EventLaneClosed,
}

impl fmt::Display for MetadataAdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MetadataAdapterError::UnexpectedEffect(name) => {
                write!(
                    f,
                    "unexpected non-metadata effect on the metadata route: {name}"
                )
            }
            MetadataAdapterError::EventLaneClosed => {
                write!(
                    f,
                    "control event lane closed before a metadata result was delivered"
                )
            }
        }
    }
}

impl std::error::Error for MetadataAdapterError {}

// ---- retry schedule ----------------------------------------------------

/// Backoff sleeps inserted *before* retries two, three, and four. The first
/// attempt runs immediately; a command therefore gets one initial attempt plus
/// three retries. There is no transient/permanent classification — the store
/// trait returns an opaque `String` — so every failure is retried identically.
const RETRY_BACKOFFS: [std::time::Duration; 3] = [
    std::time::Duration::from_millis(100),
    std::time::Duration::from_millis(250),
    std::time::Duration::from_millis(500),
];

// ---- injectable store --------------------------------------------------

/// The blocking metadata operations the adapter performs. Kept behind a trait
/// so tests can substitute an in-memory recorder for the real filesystem store.
pub(crate) trait MetadataStore: Send + Sync + 'static {
    /// Applies a metadata patch. Returns `Err` with an opaque message on
    /// failure so the adapter can retry without inspecting the cause.
    fn patch(&self, patch: SessionMetaPatch) -> Result<(), String>;

    /// Persists the final scrollback buffer.
    fn persist_scrollback(&self, bytes: Vec<u8>) -> Result<(), String>;
}

/// The production [`MetadataStore`]: it captures the resolved `$CLIMON_HOME`
/// [`Env`] and the session id and forwards to the existing `climon_store`
/// functions.
pub(crate) struct RealMetadataStore {
    env: Env,
    session_id: String,
}

impl RealMetadataStore {
    /// Captures the store environment and the session id this adapter writes.
    pub(crate) fn new(env: Env, session_id: String) -> RealMetadataStore {
        RealMetadataStore { env, session_id }
    }
}

impl MetadataStore for RealMetadataStore {
    fn patch(&self, patch: SessionMetaPatch) -> Result<(), String> {
        // A missing session (`Ok(None)`) is treated as success: it matches the
        // legacy client, which discards `patch_session_meta`'s returned meta.
        patch_session_meta(&self.env, &self.session_id, patch)
            .map(|_updated| ())
            .map_err(|error| error.to_string())
    }

    fn persist_scrollback(&self, bytes: Vec<u8>) -> Result<(), String> {
        write_scrollback(&self.env, &self.session_id, &bytes).map_err(|error| error.to_string())
    }
}

// ---- event sink --------------------------------------------------------

/// Delivers the two lifecycle events the adapter emits back to the coordinator.
/// Implemented for [`ControlEventSender`] in production; a closed lane must be
/// reported as [`MetadataAdapterError::EventLaneClosed`].
pub(crate) trait MetadataEventSink: Send + 'static {
    /// Emits `event`, resolving once it has been accepted (awaiting bounded
    /// capacity) or failing if the lane has closed.
    fn emit(
        &self,
        event: SessionEvent,
    ) -> impl Future<Output = Result<(), MetadataAdapterError>> + Send;
}

impl MetadataEventSink for ControlEventSender {
    // `async fn` cannot add the `+ Send` bound the spawned adapter task
    // requires on the returned future, so `emit` is desugared by hand.
    #[allow(clippy::manual_async_fn)]
    fn emit(
        &self,
        event: SessionEvent,
    ) -> impl Future<Output = Result<(), MetadataAdapterError>> + Send {
        async move {
            // `ControlEventSender::send` is the inherent method; only a closed
            // lane can reach the adapter (a metadata completion/failure is
            // always a control-lane event, so `WrongLane` is unreachable).
            self.send(event)
                .await
                .map_err(|_| MetadataAdapterError::EventLaneClosed)
        }
    }
}

// ---- commands ----------------------------------------------------------

/// The internal representation of a metadata effect after it has been validated
/// off the route. `barrier` is retained so a later coalescing implementation can
/// honour it; the first implementation never crosses or absorbs it.
// Mirrors `Effect::PatchMetadata`: the `Patch` variant's `SessionMetaPatch`
// payload dwarfs the other variant. Boxing it would only obscure the direct
// field access this crate-private enum is matched on, so — as for `Effect` —
// the size difference is accepted.
#[allow(clippy::large_enum_variant)]
#[derive(Clone)]
enum MetadataCommand {
    Patch {
        operation_id: OperationId,
        patch: SessionMetaPatch,
        barrier: bool,
    },
    PersistScrollback {
        operation_id: OperationId,
        bytes: Vec<u8>,
    },
}

impl MetadataCommand {
    /// Validates an effect off the metadata route, rejecting anything that is
    /// neither a metadata patch nor a scrollback persist.
    fn from_effect(effect: Effect) -> Result<MetadataCommand, MetadataAdapterError> {
        match effect {
            Effect::PatchMetadata {
                operation_id,
                patch,
                barrier,
            } => Ok(MetadataCommand::Patch {
                operation_id,
                patch,
                barrier,
            }),
            Effect::PersistScrollback {
                operation_id,
                bytes,
            } => Ok(MetadataCommand::PersistScrollback {
                operation_id,
                bytes,
            }),
            other => Err(MetadataAdapterError::UnexpectedEffect(effect_variant_name(
                &other,
            ))),
        }
    }

    /// The operation id the resulting completion/failure event must carry.
    fn operation_id(&self) -> OperationId {
        match self {
            MetadataCommand::Patch { operation_id, .. }
            | MetadataCommand::PersistScrollback { operation_id, .. } => *operation_id,
        }
    }
}

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

// ---- adapter loop ------------------------------------------------------

/// Runs the metadata adapter to completion: drain the metadata effect route in
/// FIFO order, execute each command (with retries) on a blocking thread, and
/// emit its completion/failure event. Returns `Ok(())` once the route closes
/// and every already-queued command has drained.
pub(crate) async fn run_metadata_adapter<S, E>(
    mut effects: mpsc::Receiver<Effect>,
    store: S,
    events: E,
) -> Result<(), MetadataAdapterError>
where
    S: MetadataStore,
    E: MetadataEventSink,
{
    let store = Arc::new(store);
    while let Some(effect) = effects.recv().await {
        let command = MetadataCommand::from_effect(effect)?;
        let operation_id = command.operation_id();
        let event = match execute_command(&store, &command).await {
            Ok(()) => SessionEvent::MetadataCompleted(operation_id),
            Err(error) => SessionEvent::MetadataFailed {
                operation_id,
                error,
            },
        };
        events.emit(event).await?;
    }
    Ok(())
}

/// Spawns [`run_metadata_adapter`] as an owned task and returns its handle. No
/// task is detached; the supervisor owns and later joins the returned handle.
pub(crate) fn spawn_metadata_adapter<S, E>(
    effects: mpsc::Receiver<Effect>,
    store: S,
    events: E,
) -> JoinHandle<Result<(), MetadataAdapterError>>
where
    S: MetadataStore,
    E: MetadataEventSink,
{
    tokio::spawn(run_metadata_adapter(effects, store, events))
}

/// Executes a command with the retry schedule: one immediate attempt, then up
/// to three retries separated by the [`RETRY_BACKOFFS`] sleeps. Any `Err` is
/// retried (there is no transient/permanent distinction); the first `Ok` stops
/// retrying, and the error from the final attempt is returned once the schedule
/// is exhausted. Because each attempt is awaited to completion before the next,
/// a later queued command waits through this command's entire retry sequence.
async fn execute_command<S: MetadataStore>(
    store: &Arc<S>,
    command: &MetadataCommand,
) -> Result<(), String> {
    let mut attempt = 0usize;
    loop {
        match run_store_attempt(store, command).await {
            Ok(()) => return Ok(()),
            Err(error) => match RETRY_BACKOFFS.get(attempt) {
                Some(backoff) => {
                    tokio::time::sleep(*backoff).await;
                    attempt += 1;
                }
                None => return Err(error),
            },
        }
    }
}

/// Runs one blocking store attempt on a dedicated blocking thread so the Tokio
/// worker is never blocked. A panic or cancellation of the blocking task is
/// converted into an ordinary attempt failure rather than propagated.
async fn run_store_attempt<S: MetadataStore>(
    store: &Arc<S>,
    command: &MetadataCommand,
) -> Result<(), String> {
    let store = Arc::clone(store);
    let command = command.clone();
    let attempt = tokio::task::spawn_blocking(move || match command {
        MetadataCommand::Patch { patch, .. } => store.patch(patch),
        MetadataCommand::PersistScrollback { bytes, .. } => store.persist_scrollback(bytes),
    });
    match attempt.await {
        Ok(result) => result,
        Err(join_error) => Err(format!("metadata store task failed: {join_error}")),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::Future;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    use tokio::sync::mpsc;

    use super::{
        run_metadata_adapter, spawn_metadata_adapter, MetadataAdapterError, MetadataEventSink,
        MetadataStore, RealMetadataStore,
    };
    use crate::engine::effect::{Effect, OperationId};
    use crate::engine::event::SessionEvent;
    use crate::engine::METADATA_COMMAND_CAPACITY;

    use climon_proto::meta::{PriorityReason, SessionMeta, SessionMetaPatch, SessionStatus};
    use climon_store::meta::{read_scrollback, read_session_meta, write_session_meta};
    use climon_store::paths::{now_iso, Env};

    // ---- fakes -----------------------------------------------------------

    /// A recorded store operation, used to assert order and content.
    // Mirrors `MetadataCommand`: the `Patch` payload dominates, and boxing it
    // would only obscure the direct construction/matching these assertions use.
    #[allow(clippy::large_enum_variant)]
    #[derive(Clone, Debug, PartialEq, Eq)]
    enum RecordedOp {
        Patch(SessionMetaPatch),
        Scrollback(Vec<u8>),
    }

    /// A blocking gate: a store attempt parks in [`Gate::wait`] until a test
    /// calls [`Gate::release`], proving the call runs off the Tokio worker.
    struct Gate {
        permits: Mutex<usize>,
        cvar: Condvar,
    }

    impl Gate {
        fn new() -> Arc<Gate> {
            Arc::new(Gate {
                permits: Mutex::new(0),
                cvar: Condvar::new(),
            })
        }

        fn wait(&self) {
            let mut permits = self.permits.lock().expect("gate poisoned");
            while *permits == 0 {
                permits = self.cvar.wait(permits).expect("gate wait");
            }
            *permits -= 1;
        }

        fn release(&self) {
            let mut permits = self.permits.lock().expect("gate poisoned");
            *permits += 1;
            self.cvar.notify_one();
        }
    }

    struct RecordingInner {
        ops: Mutex<Vec<RecordedOp>>,
        outcomes: Mutex<VecDeque<Result<(), String>>>,
        attempts: Option<mpsc::UnboundedSender<RecordedOp>>,
        gate: Option<Arc<Gate>>,
        panic_on_call: bool,
    }

    /// An in-memory [`MetadataStore`] that records every attempt, replays a
    /// configured sequence of outcomes, and optionally signals/gates/panics.
    #[derive(Clone)]
    struct RecordingStore {
        inner: Arc<RecordingInner>,
    }

    #[derive(Default)]
    struct RecordingStoreBuilder {
        outcomes: VecDeque<Result<(), String>>,
        attempts: Option<mpsc::UnboundedSender<RecordedOp>>,
        gate: Option<Arc<Gate>>,
        panic_on_call: bool,
    }

    impl RecordingStoreBuilder {
        fn outcomes(mut self, outcomes: impl IntoIterator<Item = Result<(), String>>) -> Self {
            self.outcomes = outcomes.into_iter().collect();
            self
        }

        fn attempts(mut self, tx: mpsc::UnboundedSender<RecordedOp>) -> Self {
            self.attempts = Some(tx);
            self
        }

        fn gate(mut self, gate: Arc<Gate>) -> Self {
            self.gate = Some(gate);
            self
        }

        fn panic_on_call(mut self) -> Self {
            self.panic_on_call = true;
            self
        }

        fn build(self) -> RecordingStore {
            RecordingStore {
                inner: Arc::new(RecordingInner {
                    ops: Mutex::new(Vec::new()),
                    outcomes: Mutex::new(self.outcomes),
                    attempts: self.attempts,
                    gate: self.gate,
                    panic_on_call: self.panic_on_call,
                }),
            }
        }
    }

    impl RecordingStore {
        fn new() -> RecordingStore {
            RecordingStoreBuilder::default().build()
        }

        fn builder() -> RecordingStoreBuilder {
            RecordingStoreBuilder::default()
        }

        fn operations(&self) -> Vec<RecordedOp> {
            self.inner.ops.lock().expect("ops poisoned").clone()
        }

        fn record(&self, op: RecordedOp) -> Result<(), String> {
            // Signal that this attempt has started, before any gating/outcome,
            // so a test can observe attempt ordering/timing and know a blocking
            // call is in flight.
            if let Some(attempts) = &self.inner.attempts {
                let _ = attempts.send(op.clone());
            }
            if let Some(gate) = &self.inner.gate {
                gate.wait();
            }
            if self.inner.panic_on_call {
                panic!("injected metadata store panic");
            }
            self.inner.ops.lock().expect("ops poisoned").push(op);
            self.inner
                .outcomes
                .lock()
                .expect("outcomes poisoned")
                .pop_front()
                .unwrap_or(Ok(()))
        }
    }

    impl MetadataStore for RecordingStore {
        fn patch(&self, patch: SessionMetaPatch) -> Result<(), String> {
            self.record(RecordedOp::Patch(patch))
        }

        fn persist_scrollback(&self, bytes: Vec<u8>) -> Result<(), String> {
            self.record(RecordedOp::Scrollback(bytes))
        }
    }

    /// An in-memory [`MetadataEventSink`] recording every emitted event; the
    /// `closed` flag simulates a closed control lane.
    #[derive(Clone)]
    struct RecordingEvents {
        inner: Arc<Mutex<Vec<SessionEvent>>>,
        closed: Arc<AtomicBool>,
    }

    impl RecordingEvents {
        fn new() -> RecordingEvents {
            RecordingEvents {
                inner: Arc::new(Mutex::new(Vec::new())),
                closed: Arc::new(AtomicBool::new(false)),
            }
        }

        fn closed_lane() -> RecordingEvents {
            let events = RecordingEvents::new();
            events.closed.store(true, Ordering::SeqCst);
            events
        }

        fn completed_ids(&self) -> Vec<OperationId> {
            self.inner
                .lock()
                .expect("events poisoned")
                .iter()
                .filter_map(|event| match event {
                    SessionEvent::MetadataCompleted(op) => Some(*op),
                    _ => None,
                })
                .collect()
        }

        fn failures(&self) -> Vec<(OperationId, String)> {
            self.inner
                .lock()
                .expect("events poisoned")
                .iter()
                .filter_map(|event| match event {
                    SessionEvent::MetadataFailed {
                        operation_id,
                        error,
                    } => Some((*operation_id, error.clone())),
                    _ => None,
                })
                .collect()
        }
    }

    impl MetadataEventSink for RecordingEvents {
        #[allow(clippy::manual_async_fn)]
        fn emit(
            &self,
            event: SessionEvent,
        ) -> impl Future<Output = Result<(), MetadataAdapterError>> + Send {
            let inner = self.inner.clone();
            let closed = self.closed.clone();
            async move {
                if closed.load(Ordering::SeqCst) {
                    return Err(MetadataAdapterError::EventLaneClosed);
                }
                inner.lock().expect("events poisoned").push(event);
                Ok(())
            }
        }
    }

    // ---- patch builders --------------------------------------------------

    fn patch_cols(cols: u16, rows: u16) -> SessionMetaPatch {
        SessionMetaPatch {
            cols: Some(cols),
            rows: Some(rows),
            ..Default::default()
        }
    }

    fn completed_patch(exit_code: i32) -> SessionMetaPatch {
        SessionMetaPatch {
            status: Some(SessionStatus::Completed),
            exit_code: Some(exit_code),
            ..Default::default()
        }
    }

    // ---- tests -----------------------------------------------------------

    /// A lifecycle barrier patch must not be coalesced with, or reordered ahead
    /// of, an earlier non-barrier patch. Queueing a non-barrier cols patch then
    /// a barrier terminal-status patch must leave the store observing both, in
    /// that exact order, and the completion events must preserve `[1, 2]`.
    #[tokio::test]
    async fn lifecycle_barrier_prevents_patch_coalescing() {
        let store = RecordingStore::new();
        let events = RecordingEvents::new();
        let (tx, rx) = mpsc::channel::<Effect>(METADATA_COMMAND_CAPACITY);
        let handle = spawn_metadata_adapter(rx, store.clone(), events.clone());

        tx.send(Effect::PatchMetadata {
            operation_id: OperationId(1),
            patch: patch_cols(100, 30),
            barrier: false,
        })
        .await
        .unwrap();
        tx.send(Effect::PatchMetadata {
            operation_id: OperationId(2),
            patch: completed_patch(0),
            barrier: true,
        })
        .await
        .unwrap();
        drop(tx);

        handle.await.unwrap().unwrap();

        assert_eq!(
            store.operations(),
            vec![
                RecordedOp::Patch(patch_cols(100, 30)),
                RecordedOp::Patch(completed_patch(0)),
            ]
        );
        assert_eq!(events.completed_ids(), vec![OperationId(1), OperationId(2)]);
        assert!(events.failures().is_empty());
    }

    /// A patch, a scrollback persist, and a second patch must execute in the
    /// exact order queued, across the two operation types.
    #[tokio::test]
    async fn commands_execute_in_fifo_across_operation_types() {
        let store = RecordingStore::new();
        let events = RecordingEvents::new();
        let (tx, rx) = mpsc::channel::<Effect>(METADATA_COMMAND_CAPACITY);
        let handle = spawn_metadata_adapter(rx, store.clone(), events.clone());

        tx.send(Effect::PatchMetadata {
            operation_id: OperationId(1),
            patch: patch_cols(80, 24),
            barrier: false,
        })
        .await
        .unwrap();
        tx.send(Effect::PersistScrollback {
            operation_id: OperationId(2),
            bytes: b"scrollback".to_vec(),
        })
        .await
        .unwrap();
        tx.send(Effect::PatchMetadata {
            operation_id: OperationId(3),
            patch: completed_patch(0),
            barrier: true,
        })
        .await
        .unwrap();
        drop(tx);

        handle.await.unwrap().unwrap();

        assert_eq!(
            store.operations(),
            vec![
                RecordedOp::Patch(patch_cols(80, 24)),
                RecordedOp::Scrollback(b"scrollback".to_vec()),
                RecordedOp::Patch(completed_patch(0)),
            ]
        );
        assert_eq!(
            events.completed_ids(),
            vec![OperationId(1), OperationId(2), OperationId(3)]
        );
        assert!(events.failures().is_empty());
    }

    /// A single successful command emits exactly one completion carrying the
    /// original operation id, and no failure.
    #[tokio::test]
    async fn success_emits_single_completion_with_original_id() {
        let store = RecordingStore::new();
        let events = RecordingEvents::new();
        let (tx, rx) = mpsc::channel::<Effect>(METADATA_COMMAND_CAPACITY);
        let handle = spawn_metadata_adapter(rx, store.clone(), events.clone());

        tx.send(Effect::PatchMetadata {
            operation_id: OperationId(7),
            patch: patch_cols(120, 40),
            barrier: false,
        })
        .await
        .unwrap();
        drop(tx);

        handle.await.unwrap().unwrap();

        assert_eq!(events.completed_ids(), vec![OperationId(7)]);
        assert!(events.failures().is_empty());
        assert_eq!(
            store.operations(),
            vec![RecordedOp::Patch(patch_cols(120, 40))]
        );
    }

    /// A closed control lane surfaces as an explicit adapter error — and only
    /// after the store operation has already run, never as a silent exit.
    #[tokio::test]
    async fn closed_control_lane_returns_error_after_operation() {
        let store = RecordingStore::new();
        let events = RecordingEvents::closed_lane();
        let (tx, rx) = mpsc::channel::<Effect>(METADATA_COMMAND_CAPACITY);

        tx.send(Effect::PatchMetadata {
            operation_id: OperationId(1),
            patch: patch_cols(80, 24),
            barrier: false,
        })
        .await
        .unwrap();
        drop(tx);

        let result = run_metadata_adapter(rx, store.clone(), events).await;

        assert_eq!(result, Err(MetadataAdapterError::EventLaneClosed));
        assert_eq!(
            store.operations(),
            vec![RecordedOp::Patch(patch_cols(80, 24))]
        );
    }

    /// An effect that is neither a patch nor a scrollback persist is rejected
    /// with a typed error, and no store operation runs.
    #[tokio::test]
    async fn unexpected_effect_returns_typed_error_without_store_call() {
        let store = RecordingStore::new();
        let events = RecordingEvents::new();
        let (tx, rx) = mpsc::channel::<Effect>(METADATA_COMMAND_CAPACITY);

        tx.send(Effect::WriteConsole {
            operation_id: OperationId(1),
            bytes: vec![1, 2, 3],
        })
        .await
        .unwrap();
        drop(tx);

        let result = run_metadata_adapter(rx, store.clone(), events.clone()).await;

        assert_eq!(
            result,
            Err(MetadataAdapterError::UnexpectedEffect("WriteConsole"))
        );
        assert!(store.operations().is_empty());
        assert!(events.completed_ids().is_empty());
        assert!(events.failures().is_empty());
    }

    /// Dropping the effect sender must not abandon commands already queued: the
    /// adapter drains every buffered command, emits their events, then exits
    /// `Ok`.
    #[tokio::test]
    async fn dropping_sender_drains_queued_then_exits_ok() {
        let store = RecordingStore::new();
        let events = RecordingEvents::new();
        let (tx, rx) = mpsc::channel::<Effect>(METADATA_COMMAND_CAPACITY);

        for id in 1..=3u64 {
            tx.send(Effect::PatchMetadata {
                operation_id: OperationId(id),
                patch: patch_cols(80 + id as u16, 24),
                barrier: false,
            })
            .await
            .unwrap();
        }
        drop(tx);

        let handle = spawn_metadata_adapter(rx, store.clone(), events.clone());
        let result = handle.await.unwrap();

        assert_eq!(result, Ok(()));
        assert_eq!(
            events.completed_ids(),
            vec![OperationId(1), OperationId(2), OperationId(3)]
        );
        assert_eq!(store.operations().len(), 3);
    }

    /// A command whose every attempt fails must be retried on the exact backoff
    /// schedule — first attempt immediately, then after 100 ms, 250 ms, and
    /// 500 ms — and, after the fourth failed attempt, emit exactly one failure
    /// carrying the original operation id and the final error. Paused time plus
    /// the attempt notifier make the schedule observable without wall sleeps.
    #[tokio::test(start_paused = true)]
    async fn failed_command_retries_on_schedule_then_fails_once() {
        let (attempts_tx, mut attempts_rx) = mpsc::unbounded_channel::<RecordedOp>();
        let store = RecordingStore::builder()
            .outcomes(vec![
                Err("boom".to_string()),
                Err("boom".to_string()),
                Err("boom".to_string()),
                Err("boom".to_string()),
            ])
            .attempts(attempts_tx)
            .build();
        let events = RecordingEvents::new();
        let (tx, rx) = mpsc::channel::<Effect>(METADATA_COMMAND_CAPACITY);
        let handle = spawn_metadata_adapter(rx, store.clone(), events.clone());

        let start = tokio::time::Instant::now();
        tx.send(Effect::PatchMetadata {
            operation_id: OperationId(1),
            patch: patch_cols(80, 24),
            barrier: false,
        })
        .await
        .unwrap();
        drop(tx);

        // Observe each attempt as it starts; paused-time auto-advance jumps
        // exactly to each backoff deadline, so the recorded elapsed times are
        // the cumulative schedule.
        let mut elapsed = Vec::new();
        for _ in 0..4 {
            attempts_rx.recv().await.expect("attempt started");
            elapsed.push(start.elapsed());
        }

        handle.await.unwrap().unwrap();

        assert_eq!(
            elapsed,
            vec![
                Duration::from_millis(0),
                Duration::from_millis(100),
                Duration::from_millis(350),
                Duration::from_millis(850),
            ]
        );
        assert!(attempts_rx.try_recv().is_err(), "no fifth attempt");
        assert_eq!(
            events.failures(),
            vec![(OperationId(1), "boom".to_string())]
        );
        assert!(events.completed_ids().is_empty());
        assert_eq!(store.operations().len(), 4);
    }

    /// A command that fails twice then succeeds must stop retrying on the
    /// success: exactly one completion, no failure. With backoffs of 100 ms and
    /// 250 ms the success lands at 350 ms of virtual time, and no fourth attempt
    /// occurs.
    #[tokio::test(start_paused = true)]
    async fn transient_failure_then_success_emits_only_completion() {
        let (attempts_tx, mut attempts_rx) = mpsc::unbounded_channel::<RecordedOp>();
        let store = RecordingStore::builder()
            .outcomes(vec![
                Err("transient".to_string()),
                Err("transient".to_string()),
                Ok(()),
            ])
            .attempts(attempts_tx)
            .build();
        let events = RecordingEvents::new();
        let (tx, rx) = mpsc::channel::<Effect>(METADATA_COMMAND_CAPACITY);
        let handle = spawn_metadata_adapter(rx, store.clone(), events.clone());

        let start = tokio::time::Instant::now();
        tx.send(Effect::PatchMetadata {
            operation_id: OperationId(9),
            patch: patch_cols(90, 20),
            barrier: false,
        })
        .await
        .unwrap();
        drop(tx);

        let mut elapsed = Vec::new();
        for _ in 0..3 {
            attempts_rx.recv().await.expect("attempt started");
            elapsed.push(start.elapsed());
        }
        handle.await.unwrap().unwrap();

        assert_eq!(
            elapsed,
            vec![
                Duration::from_millis(0),
                Duration::from_millis(100),
                Duration::from_millis(350),
            ]
        );
        assert!(
            attempts_rx.try_recv().is_err(),
            "no fourth attempt after success"
        );
        assert_eq!(events.completed_ids(), vec![OperationId(9)]);
        assert!(events.failures().is_empty());
        assert_eq!(store.operations().len(), 3);
    }

    /// FIFO under retry: while command 1 is retrying (and sleeping between
    /// attempts), command 2 must not be attempted. Command 1 (a cols patch)
    /// fails twice then succeeds; only afterwards is command 2 (the terminal
    /// patch) attempted, then completed. Completions preserve `[1, 2]`.
    #[tokio::test(start_paused = true)]
    async fn later_command_waits_through_earlier_retries() {
        let (attempts_tx, mut attempts_rx) = mpsc::unbounded_channel::<RecordedOp>();
        let store = RecordingStore::builder()
            .outcomes(vec![
                Err("retry".to_string()), // command 1, attempt 1
                Err("retry".to_string()), // command 1, attempt 2
                Ok(()),                   // command 1, attempt 3 (succeeds)
                Ok(()),                   // command 2, attempt 1
            ])
            .attempts(attempts_tx)
            .build();
        let events = RecordingEvents::new();
        let (tx, rx) = mpsc::channel::<Effect>(METADATA_COMMAND_CAPACITY);
        let handle = spawn_metadata_adapter(rx, store.clone(), events.clone());

        let cols = patch_cols(70, 20);
        let terminal = completed_patch(0);
        tx.send(Effect::PatchMetadata {
            operation_id: OperationId(1),
            patch: cols.clone(),
            barrier: false,
        })
        .await
        .unwrap();
        tx.send(Effect::PatchMetadata {
            operation_id: OperationId(2),
            patch: terminal.clone(),
            barrier: true,
        })
        .await
        .unwrap();
        drop(tx);

        let mut order = Vec::new();
        for _ in 0..4 {
            order.push(attempts_rx.recv().await.expect("attempt started"));
        }
        handle.await.unwrap().unwrap();

        assert_eq!(
            order,
            vec![
                RecordedOp::Patch(cols.clone()),
                RecordedOp::Patch(cols.clone()),
                RecordedOp::Patch(cols.clone()),
                RecordedOp::Patch(terminal.clone()),
            ]
        );
        assert!(attempts_rx.try_recv().is_err(), "exactly four attempts");
        assert_eq!(events.completed_ids(), vec![OperationId(1), OperationId(2)]);
        assert!(events.failures().is_empty());
    }

    /// A blocking store call runs on a blocking thread, not a Tokio worker:
    /// while one store attempt is parked inside the store, another async task
    /// still runs to completion. Coordinated with a gate and an atomic — no
    /// timing sleep.
    #[tokio::test]
    async fn blocking_store_call_does_not_block_runtime() {
        let (entered_tx, mut entered_rx) = mpsc::unbounded_channel::<RecordedOp>();
        let gate = Gate::new();
        let store = RecordingStore::builder()
            .attempts(entered_tx)
            .gate(gate.clone())
            .build();
        let events = RecordingEvents::new();
        let (tx, rx) = mpsc::channel::<Effect>(METADATA_COMMAND_CAPACITY);
        let handle = spawn_metadata_adapter(rx, store.clone(), events.clone());

        tx.send(Effect::PatchMetadata {
            operation_id: OperationId(1),
            patch: patch_cols(80, 24),
            barrier: false,
        })
        .await
        .unwrap();
        drop(tx);

        // Wait until the store attempt is in flight (about to park on the gate).
        entered_rx.recv().await.expect("store attempt started");

        // The runtime is free while the blocking call is parked: another task
        // runs to completion.
        let progressed = Arc::new(AtomicBool::new(false));
        let flag = progressed.clone();
        tokio::spawn(async move {
            flag.store(true, Ordering::SeqCst);
        })
        .await
        .unwrap();
        assert!(
            progressed.load(Ordering::SeqCst),
            "runtime made progress while the store call was blocked"
        );

        // Release the store; the command completes.
        gate.release();
        handle.await.unwrap().unwrap();
        assert_eq!(events.completed_ids(), vec![OperationId(1)]);
        assert!(events.failures().is_empty());
    }

    /// A panic inside the blocking store task becomes an ordinary attempt
    /// failure: the adapter retries, exhausts the schedule, and emits exactly
    /// one failure — it never panics itself (the run returns `Ok`).
    #[tokio::test(start_paused = true)]
    async fn store_task_panic_becomes_failure_not_adapter_panic() {
        let (attempts_tx, mut attempts_rx) = mpsc::unbounded_channel::<RecordedOp>();
        let store = RecordingStore::builder()
            .panic_on_call()
            .attempts(attempts_tx)
            .build();
        let events = RecordingEvents::new();
        let (tx, rx) = mpsc::channel::<Effect>(METADATA_COMMAND_CAPACITY);
        let handle = spawn_metadata_adapter(rx, store.clone(), events.clone());

        tx.send(Effect::PatchMetadata {
            operation_id: OperationId(5),
            patch: patch_cols(80, 24),
            barrier: false,
        })
        .await
        .unwrap();
        drop(tx);

        let mut attempts = 0;
        for _ in 0..4 {
            attempts_rx.recv().await.expect("attempt started");
            attempts += 1;
        }
        // The adapter task itself returns Ok: it converted each panic into a
        // retryable failure rather than propagating it.
        handle.await.unwrap().unwrap();

        assert_eq!(attempts, 4);
        assert!(attempts_rx.try_recv().is_err(), "no fifth attempt");
        let failures = events.failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].0, OperationId(5));
        assert!(
            failures[0].1.contains("metadata store task failed"),
            "error text: {}",
            failures[0].1
        );
        assert!(events.completed_ids().is_empty());
    }

    // ---- RealMetadataStore integration -----------------------------------

    /// A unique `$CLIMON_HOME` scratch dir under `target/` (never the system
    /// temp dir), with its `sessions/` subdir created.
    fn scratch_env(tag: &str) -> (Env, String, std::path::PathBuf) {
        use std::sync::atomic::AtomicU64;
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let exe = std::env::current_exe().expect("current_exe");
        let target = exe
            .ancestors()
            .find(|p| p.file_name().map(|n| n == "target").unwrap_or(false))
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().expect("cwd"));
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let home = target
            .join("climon-session-adapter-test-tmp")
            .join(format!("{tag}-{}-{nanos}-{n}", std::process::id()));
        std::fs::create_dir_all(home.join("sessions")).expect("create sessions dir");
        (
            Env::with_home(&home),
            "adapter-metadata-session".to_string(),
            home,
        )
    }

    fn base_meta(id: &str) -> SessionMeta {
        let now = now_iso();
        SessionMeta {
            id: id.to_string(),
            command: vec!["sleep".into(), "1".into()],
            display_command: "sleep 1".into(),
            cwd: "/tmp".into(),
            status: SessionStatus::Running,
            priority_reason: PriorityReason::Running,
            daemon_pid: None,
            cols: 80,
            rows: 24,
            headless: Some(true),
            socket_path: "tcp://127.0.0.1:0".into(),
            client_version: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_activity_at: now,
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
            user_paused: None,
            theme: None,
            terminal_title: None,
            attention_snippet: None,
            progress: None,
        }
    }

    /// The production [`RealMetadataStore`] applies a patch and persists
    /// scrollback to the real on-disk layout under an isolated scratch `Env`.
    #[test]
    fn real_metadata_store_patches_and_persists_on_disk() {
        let (env, id, home) = scratch_env("real-store");
        let meta = base_meta(&id);
        write_session_meta(&env, &meta).expect("write base meta");

        let store = RealMetadataStore::new(env.clone(), id.clone());
        store
            .patch(SessionMetaPatch {
                status: Some(SessionStatus::Completed),
                priority_reason: Some(PriorityReason::Completed),
                cols: Some(132),
                rows: Some(43),
                exit_code: Some(0),
                ..Default::default()
            })
            .expect("patch applied");
        store
            .persist_scrollback(b"final scrollback".to_vec())
            .expect("scrollback persisted");

        let on_disk = read_session_meta(&env, &id)
            .expect("read meta")
            .expect("meta present");
        assert_eq!(on_disk.status, SessionStatus::Completed);
        assert_eq!(on_disk.priority_reason, PriorityReason::Completed);
        assert_eq!(on_disk.cols, 132);
        assert_eq!(on_disk.rows, 43);
        assert_eq!(on_disk.exit_code, Some(0));

        let scrollback = read_scrollback(&env, &id).expect("read scrollback");
        assert_eq!(scrollback.as_deref(), Some(b"final scrollback".as_slice()));

        let _ = std::fs::remove_dir_all(&home);
    }
}
