//! Session supervisor: the actor engine's runtime boundary and lifecycle owner.
//!
//! [`run`] is the single async entry point the runtime blocks on. It brings the
//! resource adapters up in a defined order (pty, local terminal, ipc socket,
//! metadata, timers, signals) behind a [`SessionBackend`] seam, spawns the
//! coordinator, and registers every spawned task in one [`TaskRegistry`] so
//! nothing is detached. On completion (or a partial-startup failure) it cancels
//! adapters, terminates the child, joins every task within a bounded deadline,
//! restores the local terminal, cleans the socket, and returns the exit code.
//!
//! The [`SessionBackend`] seam lets tests substitute the pty, socket, terminal,
//! metadata, timer, and signal resources with in-process fakes (and inject a
//! failure at any startup step) while exercising the real ordering, ownership,
//! and teardown logic.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use climon_proto::meta::SessionMeta;

use crate::adapters::ipc::{spawn_ipc_adapter, IpcAdapterError};
use crate::adapters::local_terminal::{
    setup_local_terminal, spawn_console_adapter, LocalTerminalError, LocalTerminalSetup,
    StdoutConsoleWriter,
};
use crate::adapters::metadata::{spawn_metadata_adapter, MetadataAdapterError, RealMetadataStore};
use crate::adapters::pty::{PtyAdapterError, PtyControlHandle};
use crate::adapters::signals::SignalAdapterError;
use crate::adapters::timers::{spawn_timer_adapter, TimerAdapterError};
use crate::engine::coordinator::{
    event_lanes, ControlEventSender, Coordinator, EffectReceivers, EffectRoutes,
    IgnoreAppliedEvents, PtyEventSender, SystemTransitionContext,
};
use crate::engine::effect::Effect;
use crate::engine::event::SessionEvent;
use crate::engine::state::{SessionState, SessionStateConfig};
use crate::error::{SessionError, SessionResult};
use crate::host::SessionHostOptions;

/// Scrollback shadow byte cap (mirrors the legacy host's `SCROLLBACK_CAP`).
const SCROLLBACK_CAP: usize = 256 * 1024;
/// Child env var carrying the session id (mirrors the legacy host).
const SESSION_ENV_VAR: &str = "CLIMON_SESSION_ID";
/// Child env var carrying the daemon nesting level (mirrors the legacy host).
const NEST_LEVEL_ENV_VAR: &str = "CLIMON_NEST_LEVEL";
/// Exit code persisted when the child could not be spawned (legacy parity).
const SPAWN_FAILURE_EXIT: i32 = 1;
/// Exit code used when the coordinator ended without a clean completion.
const CORE_FAILURE_EXIT: i32 = 1;
/// Error persisted with the terminal fallback patch when the coordinator could
/// not run its ordered finalization (a required task died first), so the session
/// is never left `running` after teardown.
const CORE_FAILURE_MESSAGE: &str = "session ended before the coordinator could finalize";
/// Bounded deadline for joining every owned task during teardown.
pub(crate) const JOIN_DEADLINE: Duration = Duration::from_secs(5);

/// Whether a session status is a terminal (finalized) outcome. `mark_failed`
/// uses this to stay idempotent: once the coordinator has written a terminal
/// patch (`completed`/`failed`/`disconnected`), the abnormal-teardown fallback
/// must not clobber it with `failed`/1.
fn is_terminal_status(status: climon_proto::meta::SessionStatus) -> bool {
    use climon_proto::meta::SessionStatus;
    matches!(
        status,
        SessionStatus::Completed | SessionStatus::Failed | SessionStatus::Disconnected
    )
}

/// Config-derived knobs resolved once before the actor starts.
#[derive(Debug, Clone)]
pub(crate) struct RuntimeConfig {
    /// Screen-idle threshold (`<= 0` disables idle attention detection).
    pub(crate) idle_seconds: i64,
    /// Whether smart-notification snippet extraction is enabled.
    pub(crate) snippet_enabled: bool,
    /// Scrollback shadow byte cap.
    pub(crate) scrollback_cap: usize,
}

/// A blocking, off-runtime child terminator. The supervisor's emergency handle
/// during teardown; kept behind a trait so tests can record a termination
/// without owning a real pty control channel.
pub(crate) trait ChildTerminator: Send + Sync + 'static {
    /// Terminates the child. Blocking, so the supervisor calls it via
    /// [`tokio::task::spawn_blocking`], never directly on a Tokio worker.
    fn terminate(&self);
}

impl ChildTerminator for PtyControlHandle {
    fn terminate(&self) {
        // The emergency handle stays retryable on a kill failure and reports
        // `Closed` once the child is already gone; both are fine to ignore here.
        let _ = PtyControlHandle::terminate(self);
    }
}

/// The owned pty pieces the supervisor registers and later joins: the two FIFO
/// workers plus a durable emergency terminator that survives the workers.
pub(crate) struct PtyLaunch {
    /// The child process id, if known (for `daemon_pid` metadata).
    pub(crate) pid: Option<u32>,
    /// The FIFO command worker (writer + resizer).
    pub(crate) command: JoinHandle<Result<(), PtyAdapterError>>,
    /// The child-owner lifecycle loop (reader + authoritative child + master).
    pub(crate) lifecycle: JoinHandle<Result<(), PtyAdapterError>>,
    /// The emergency child terminator, retained through teardown.
    pub(crate) terminator: Arc<dyn ChildTerminator>,
}

/// The owned ipc pieces the supervisor registers: the manager task plus the
/// resolved socket reference to persist and later clean up.
pub(crate) struct IpcLaunch {
    /// The async ipc manager task (owns clients + listener bridge).
    pub(crate) manager: JoinHandle<Result<(), IpcAdapterError>>,
    /// The resolved socket reference (an OS-assigned port for a `:0` bind).
    pub(crate) resolved_ref: String,
}

/// Identifies each supervised task for the join report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskName {
    PtyCommand,
    PtyLifecycle,
    Console,
    Ipc,
    Metadata,
    Timers,
    Signals,
    Coordinator,
}

/// A payload-safe failure synthesized into the coordinator's pty event lane when
/// the command worker dies *without* emitting its own [`SessionEvent::PtyFailed`]
/// (a panic), so ordered finalization and the child kill can still proceed. It
/// carries no terminal bytes.
const COMMAND_WORKER_LOST: &str = "pty command worker terminated unexpectedly";

/// The outcome of joining one supervised task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TaskOutcome {
    /// The task returned `Ok(())`.
    Completed,
    /// The task returned an adapter error (payload-free message).
    Failed(String),
    /// The task panicked.
    Panicked,
    /// The task's join handle was cancelled/aborted.
    Cancelled,
}

impl TaskOutcome {
    /// Whether this outcome is an abnormal termination — a returned error or a
    /// panic — as opposed to a clean completion or a deliberate cancellation.
    fn is_abnormal(&self) -> bool {
        matches!(self, TaskOutcome::Failed(_) | TaskOutcome::Panicked)
    }
}

/// The result of joining every supervised task under the deadline.
#[derive(Debug, Default)]
pub(crate) struct JoinReport {
    /// Tasks that joined within the deadline, with their outcome.
    pub(crate) joined: Vec<(TaskName, TaskOutcome)>,
    /// Tasks still running when the deadline expired.
    pub(crate) unjoined: Vec<TaskName>,
}

impl JoinReport {
    /// Whether any joined task panicked (mapped to [`SessionError::ActorTask`]).
    pub(crate) fn any_panicked(&self) -> bool {
        self.joined
            .iter()
            .any(|(_, outcome)| matches!(outcome, TaskOutcome::Panicked))
    }
}

/// Owns every spawned task in one [`JoinSet`] so none is detached. Each adapter's
/// typed join handle is wrapped in a forwarding task that maps its result (or a
/// panic) to a [`TaskOutcome`], giving one uniform, panic-safe join surface.
pub(crate) struct TaskRegistry {
    set: JoinSet<(TaskName, TaskOutcome)>,
    names: Vec<TaskName>,
    /// Outcomes already observed while supervising the running session, retained
    /// so the final [`JoinReport`] stays complete no matter when a task ended.
    joined: Vec<(TaskName, TaskOutcome)>,
}

impl TaskRegistry {
    fn new() -> Self {
        TaskRegistry {
            set: JoinSet::new(),
            names: Vec::new(),
            joined: Vec::new(),
        }
    }

    /// Registers a task by wrapping its handle in a forwarding task that maps
    /// completion/failure/panic to a [`TaskOutcome`]. The forwarding task itself
    /// never panics, so joining the set is always clean.
    fn register<E>(&mut self, name: TaskName, handle: JoinHandle<Result<(), E>>)
    where
        E: std::fmt::Display + Send + 'static,
    {
        self.names.push(name);
        self.set.spawn(async move {
            let outcome = match handle.await {
                Ok(Ok(())) => TaskOutcome::Completed,
                Ok(Err(error)) => TaskOutcome::Failed(error.to_string()),
                Err(join_error) if join_error.is_panic() => TaskOutcome::Panicked,
                Err(_) => TaskOutcome::Cancelled,
            };
            (name, outcome)
        });
    }

    /// Waits for the coordinator to complete while concurrently watching every
    /// supervised task, so a core task that dies before completion cannot leave
    /// the supervisor blocked on a `CompleteSession` that will never arrive.
    ///
    /// It returns as soon as the completion route resolves — a `CompleteSession`,
    /// or the route closing because the coordinator ended — or the authoritative
    /// pty lifecycle dies abnormally before it could report the child exit (a
    /// [`SuperviseOutcome::RequiredTaskFailed`]). Every other early termination is
    /// recorded and tolerated rather than misclassified as a fatal failure, so the
    /// coordinator's in-flight finalization is never preempted — see
    /// [`classify_early_exit`]. In particular the command worker is *not* the
    /// child owner: an ordinary error means it already emitted its one
    /// `PtyFailed`, and an unexpected panic is repaired by synthesizing one into
    /// `pty_events` so finalization and the child kill still proceed. Every
    /// outcome observed here is retained for the final join report, so a panic
    /// still surfaces as [`SessionError::ActorTask`] after teardown.
    async fn supervise(
        &mut self,
        completion_rx: &mut mpsc::Receiver<Effect>,
        pty_events: &PtyEventSender,
    ) -> SuperviseOutcome {
        loop {
            tokio::select! {
                biased;
                completion = completion_rx.recv() => {
                    return match completion {
                        Some(Effect::CompleteSession { exit_code }) => {
                            SuperviseOutcome::Completed(exit_code)
                        }
                        _ => SuperviseOutcome::CoordinatorEnded,
                    };
                }
                joined = self.set.join_next(), if !self.set.is_empty() => {
                    if let Some(Ok((name, outcome))) = joined {
                        let disposition = classify_early_exit(name, &outcome);
                        // Retain every outcome first so the join report stays
                        // complete (a panic here still maps to `ActorTask`).
                        self.joined.push((name, outcome));
                        match disposition {
                            EarlyExit::Fatal => return SuperviseOutcome::RequiredTaskFailed,
                            EarlyExit::SynthesizeCommandFailure => {
                                // The command executor died without emitting its
                                // own `PtyFailed`; inject one so the coordinator
                                // can finalize (and its child kill can run) rather
                                // than waiting forever for a completion that will
                                // never come. A closed lane means the coordinator
                                // has already ended, handled by the completion arm.
                                let _ = pty_events
                                    .send(SessionEvent::PtyFailed(
                                        COMMAND_WORKER_LOST.to_string(),
                                    ))
                                    .await;
                            }
                            EarlyExit::Tolerate => {}
                        }
                    }
                }
            }
        }
    }

    /// Joins every remaining registered task, waiting until the shared teardown
    /// `deadline`. Tasks still running at the deadline are reported as `unjoined`
    /// and their forwarding tasks aborted (a best-effort net; blocking work may
    /// outlive the process only until it exits). Outcomes already observed during
    /// supervision are retained in the report.
    async fn join_all(mut self, deadline: tokio::time::Instant) -> JoinReport {
        let mut joined = std::mem::take(&mut self.joined);
        let drain = async {
            while let Some(result) = self.set.join_next().await {
                if let Ok(entry) = result {
                    joined.push(entry);
                }
            }
        };
        let unjoined = match tokio::time::timeout_at(deadline, drain).await {
            Ok(()) => Vec::new(),
            Err(_) => {
                let joined_names: Vec<TaskName> = joined.iter().map(|(name, _)| *name).collect();
                self.names
                    .iter()
                    .copied()
                    .filter(|name| !joined_names.contains(name))
                    .collect()
            }
        };
        self.set.abort_all();
        JoinReport { joined, unjoined }
    }
}

/// The result of [`TaskRegistry::supervise`]: how the running session ended.
enum SuperviseOutcome {
    /// The coordinator emitted `CompleteSession { exit_code }`.
    Completed(i32),
    /// The completion route closed without a completion effect — the coordinator
    /// ended (or panicked) without completing the session.
    CoordinatorEnded,
    /// The authoritative pty lifecycle terminated abnormally before it could
    /// report the child exit, so the coordinator can never complete.
    RequiredTaskFailed,
}

/// How [`TaskRegistry::supervise`] must react to a supervised task terminating
/// before the coordinator completed the session.
enum EarlyExit {
    /// Record and keep waiting for completion. This covers every peripheral task,
    /// the expected clean/cancelled return of a core worker (the pty lifecycle
    /// returns `Ok` right after reporting `PtyExited`), and — crucially — an
    /// *ordinary* command-worker error: the command worker always emits its one
    /// `PtyFailed` before returning `Err` (or finds the lane closed because the
    /// coordinator already ended), so its finalization is already in flight and
    /// must not be preempted.
    Tolerate,
    /// The command executor died via a panic, which may have happened *before* it
    /// emitted its own `PtyFailed`. Synthesize a `PtyFailed` into the coordinator
    /// so ordered finalization and the child kill still proceed, then keep
    /// waiting; the retained panic still maps to [`SessionError::ActorTask`].
    SynthesizeCommandFailure,
    /// The authoritative pty lifecycle — the sole owner of the child's real exit —
    /// died abnormally before reporting it. The coordinator can never observe
    /// `PtyExited`, so fail fast rather than wait forever.
    Fatal,
}

/// Classifies how a supervised task's early termination should be handled. The
/// two pty workers are the only *core* tasks (they own the child), but they are
/// handled differently: the lifecycle owns the authoritative exit and must fail
/// fast when it dies abnormally, whereas the command worker is a peripheral
/// executor whose loss must never preempt the coordinator's finalization — an
/// ordinary error is tolerated (it already emitted `PtyFailed`) and only a panic
/// (which may have skipped that emission) is repaired by synthesizing one.
fn classify_early_exit(name: TaskName, outcome: &TaskOutcome) -> EarlyExit {
    match name {
        TaskName::PtyLifecycle if outcome.is_abnormal() => EarlyExit::Fatal,
        TaskName::PtyCommand if matches!(outcome, TaskOutcome::Panicked) => {
            EarlyExit::SynthesizeCommandFailure
        }
        _ => EarlyExit::Tolerate,
    }
}

/// The startup and teardown side effects the supervisor delegates, behind a seam
/// so tests can substitute fakes and inject a failure at any step. Every method
/// is synchronous: the adapter spawners it calls are non-blocking and rely on the
/// ambient Tokio runtime the supervisor is already running inside.
pub(crate) trait SessionBackend {
    /// Spawns the pty adapter, or fails if the child cannot be spawned. On
    /// success the child process is running and its output/exit will arrive on
    /// the pty event lane.
    fn launch_pty(
        &mut self,
        id: &str,
        meta: &SessionMeta,
        effects: mpsc::Receiver<Effect>,
        events: PtyEventSender,
    ) -> SessionResult<PtyLaunch>;

    /// Establishes local raw mode and spawns the input worker, or fails. Owns the
    /// mode guard; must run before any pty output can be routed to the console.
    fn setup_local_terminal(
        &mut self,
        headless: bool,
        events: ControlEventSender,
        cancel: CancellationToken,
    ) -> SessionResult<LocalTerminalSetup>;

    /// Spawns the console adapter that drains the console effect route.
    fn launch_console(
        &mut self,
        effects: mpsc::Receiver<Effect>,
        events: ControlEventSender,
    ) -> JoinHandle<Result<(), LocalTerminalError>>;

    /// Binds the session listener and spawns the ipc adapter, or fails if the
    /// required listener cannot be bound.
    fn launch_ipc(
        &mut self,
        socket_ref: &str,
        effects: mpsc::Receiver<Effect>,
        events: ControlEventSender,
    ) -> SessionResult<IpcLaunch>;

    /// Spawns the metadata adapter, or fails if the store cannot be initialized.
    fn launch_metadata(
        &mut self,
        id: &str,
        effects: mpsc::Receiver<Effect>,
        events: ControlEventSender,
    ) -> SessionResult<JoinHandle<Result<(), MetadataAdapterError>>>;

    /// Spawns the timer adapter that drives scheduled deadlines.
    fn launch_timers(
        &mut self,
        effects: mpsc::Receiver<Effect>,
        events: ControlEventSender,
    ) -> JoinHandle<Result<(), TimerAdapterError>>;

    /// Spawns the platform signal/resize adapter, or fails if the signal source
    /// cannot be registered.
    fn launch_signals(
        &mut self,
        events: ControlEventSender,
        cancel: CancellationToken,
    ) -> SessionResult<JoinHandle<Result<(), SignalAdapterError>>>;

    /// Persists the resolved socket reference into the session metadata.
    fn patch_socket(&mut self, id: &str, resolved_ref: &str);

    /// Patches the session to `running` (preserving paused semantics) once the
    /// adapters are up, recording the child's `daemon_pid`.
    fn mark_running(&mut self, id: &str, meta: &SessionMeta, pid: Option<u32>);

    /// Persists a terminal `failed` session directly (bypassing the coordinator's
    /// ordered finalization): used when the child could not be spawned, and as the
    /// abnormal-teardown fallback when the coordinator ended before it could
    /// finalize, so the session is never left `running`. Idempotent: it only
    /// writes `failed` while the current status is non-terminal, so it never
    /// clobbers an already-terminal patch the coordinator raced ahead of it.
    fn mark_failed(&mut self, id: &str, error: &str);

    /// Removes the session socket during teardown (no-op for a TCP reference).
    fn cleanup_socket(&mut self, resolved_ref: &str);

    /// Records the final join report (production ignores it; tests inspect it).
    fn record_join_report(&mut self, _report: &JoinReport) {}
}

/// Cancels adapters, terminates the child (off-runtime), joins every owned
/// worker under one shared deadline, and restores the local terminal — the
/// shared teardown for both the normal completion path and every partial-startup
/// unwind. `routes` and `lanes` must already be closed (the coordinator drops
/// them on completion; an early failure drops them at the call site) so the
/// registered adapters can drain and exit.
///
/// One `deadline` budget bounds the joinable owned workers that can genuinely
/// block — the supervised-task drain and the local input worker's join — so no
/// single stuck worker (most importantly a local input read that ignores
/// cancellation) can wedge shutdown. The child reap runs first and is awaited
/// unconditionally: a kill is non-blocking, so the reap stays deterministic and
/// is never detached, and it must precede the task drain so the pty lifecycle
/// loop sees EOF and can reach its join. The terminal is restored regardless:
/// even if the local join is abandoned at the deadline, dropping the `shutdown`
/// future drops the mode guard. `deadline` is injected (production passes
/// [`JOIN_DEADLINE`]) so shutdown-timing tests can drive it deterministically
/// without wall-clock sleeps.
async fn drain_and_join(
    root_cancel: &CancellationToken,
    terminator: Arc<dyn ChildTerminator>,
    registry: TaskRegistry,
    local: Option<LocalTerminalSetup>,
    deadline: Duration,
) -> JoinReport {
    // Stop the signal adapter and any cancellation-driven work.
    root_cancel.cancel();
    // Ensure the child is gone so the pty lifecycle loop can reach its join.
    // `terminate` is a non-blocking kill run off the Tokio workers; it is awaited
    // unconditionally (a deterministic reap, never detached) before the joins.
    let _ = tokio::task::spawn_blocking(move || terminator.terminate()).await;
    // One absolute deadline shared by every remaining joinable owned worker.
    let deadline_at = tokio::time::Instant::now() + deadline;
    // Join every supervised task within the shared deadline.
    let report = registry.join_all(deadline_at).await;
    // Interrupt any blocked local input, join the input worker, and restore
    // terminal modes only after the workers have stopped — bounded by the same
    // deadline so a stuck read cannot outlast teardown. Even if the join is
    // abandoned at the deadline, dropping the `shutdown` future drops the mode
    // guard, so the terminal is still restored.
    if let Some(local) = local {
        let _ = tokio::time::timeout_at(deadline_at, local.shutdown()).await;
    }
    report
}

/// The async entry point the runtime blocks on: resolves config, initializes the
/// daemon logger, and runs the session against the real resource backend.
pub(crate) async fn run(
    id: String,
    meta: SessionMeta,
    options: SessionHostOptions,
) -> SessionResult<i32> {
    let env = climon_store::Env::from_env();
    let config_env = climon_config::config::Env::real();
    let config = climon_config::config::load_config(&config_env).map_err(SessionError::Config)?;

    // Route this daemon's diagnostics to `$CLIMON_HOME/logs/daemon/<id>.log`
    // (per-session), matching the legacy host and the TS daemon.
    climon_logging::logger::init_logger(
        climon_logging::sinks::LogRole::Daemon,
        climon_logging::logger::LoggerInitOptions {
            session_id: Some(id.clone()),
            ..Default::default()
        },
    );

    let runtime_config = RuntimeConfig {
        idle_seconds: cfg_i64(&config, "attention", "idleSeconds", 10),
        snippet_enabled: climon_config::features::is_feature_enabled(&config, "smartNotifications"),
        scrollback_cap: SCROLLBACK_CAP,
    };

    let backend = RealBackend { env };
    run_with(backend, runtime_config, id, meta, options).await
}

/// Runs the session against an injected [`SessionBackend`]: builds the event
/// lanes and effect routes, brings adapters up in ownership order, spawns the
/// coordinator, waits for completion, then tears everything down. A partial
/// startup failure unwinds every already-created resource before returning.
async fn run_with<B: SessionBackend>(
    mut backend: B,
    runtime_config: RuntimeConfig,
    id: String,
    meta: SessionMeta,
    options: SessionHostOptions,
) -> SessionResult<i32> {
    let (pty_tx, control_tx, lanes) = event_lanes();
    let (routes, receivers) = EffectRoutes::bounded();
    let EffectReceivers {
        pty: pty_effects,
        client: client_effects,
        console: console_effects,
        metadata: metadata_effects,
        timer: timer_effects,
        completion: mut completion_rx,
    } = receivers;

    let root_cancel = CancellationToken::new();
    let mut registry = TaskRegistry::new();

    // --- Step 2: resolve and spawn the pty (a spawn failure is terminal) ---
    let pty = match backend.launch_pty(&id, &meta, pty_effects, pty_tx.clone()) {
        Ok(pty) => pty,
        Err(error) => {
            // No task has been spawned yet: persist a failed session and return
            // the legacy spawn-failure exit code.
            backend.mark_failed(&id, &error.to_string());
            backend.record_join_report(&JoinReport::default());
            return Ok(SPAWN_FAILURE_EXIT);
        }
    };
    let pid = pty.pid;
    let terminator = pty.terminator.clone();
    registry.register(TaskName::PtyCommand, pty.command);
    registry.register(TaskName::PtyLifecycle, pty.lifecycle);

    // --- Step 3: establish local raw mode BEFORE any pty-to-console routing ---
    let local_cancel = CancellationToken::new();
    let local =
        match backend.setup_local_terminal(options.headless, control_tx.clone(), local_cancel) {
            Ok(local) => local,
            Err(error) => {
                // Only the pty is owned so far. Close the routes/lanes so its
                // command worker drains, then terminate and join it.
                drop(routes);
                drop(lanes);
                let report =
                    drain_and_join(&root_cancel, terminator, registry, None, JOIN_DEADLINE).await;
                backend.record_join_report(&report);
                return Err(error);
            }
        };
    let local_attached = local.attached;
    // Windows-only: `meta.cols`/`meta.rows` came from the launcher's
    // `terminal_size()` call, which is Unix-only and always reports the 80x24
    // placeholder on Windows (see `PlatformConfiguration::size`'s doc in
    // `adapters::local_terminal`). The Windows resize poller
    // (`adapters::signals::spawn_resize_adapter`) only reports *changes* from
    // its own initial sample, so without seeding the real size here the
    // pty/grid stay at that bogus 80x24 for the whole session unless the user
    // later resizes the window — this produced the reported diagonal `~` /
    // misplaced status line rendering in Vim. Feed the real size in as an
    // ordinary `LocalResized` event (the same event the poller emits on a real
    // change) so it is applied through the already-tested resize handling
    // before any pty output is produced. The lane cannot be closed this early
    // in startup, so a send failure here is intentionally ignored.
    #[cfg(windows)]
    if local_attached {
        let (cols, rows) = local.size;
        let _ = control_tx
            .send(SessionEvent::LocalResized { cols, rows })
            .await;
    }
    registry.register(
        TaskName::Console,
        backend.launch_console(console_effects, control_tx.clone()),
    );

    // --- Step 4: bind the ipc listener and persist its resolved reference ---
    let ipc = match backend.launch_ipc(&meta.socket_path, client_effects, control_tx.clone()) {
        Ok(ipc) => ipc,
        Err(error) => {
            drop(routes);
            drop(lanes);
            let report = drain_and_join(
                &root_cancel,
                terminator,
                registry,
                Some(local),
                JOIN_DEADLINE,
            )
            .await;
            backend.record_join_report(&report);
            return Err(error);
        }
    };
    let resolved_ref = ipc.resolved_ref.clone();
    registry.register(TaskName::Ipc, ipc.manager);
    backend.patch_socket(&id, &resolved_ref);

    // --- Metadata adapter (single owner of session patch + scrollback I/O) ---
    let metadata_handle = match backend.launch_metadata(&id, metadata_effects, control_tx.clone()) {
        Ok(handle) => handle,
        Err(error) => {
            drop(routes);
            drop(lanes);
            let report = drain_and_join(
                &root_cancel,
                terminator,
                registry,
                Some(local),
                JOIN_DEADLINE,
            )
            .await;
            backend.cleanup_socket(&resolved_ref);
            backend.record_join_report(&report);
            return Err(error);
        }
    };
    registry.register(TaskName::Metadata, metadata_handle);

    // --- Timer adapter (drives scheduled deadlines) ---
    registry.register(
        TaskName::Timers,
        backend.launch_timers(timer_effects, control_tx.clone()),
    );

    // --- Signal/resize adapter ---
    let signals = match backend.launch_signals(control_tx.clone(), root_cancel.clone()) {
        Ok(signals) => signals,
        Err(error) => {
            drop(routes);
            drop(lanes);
            let report = drain_and_join(
                &root_cancel,
                terminator,
                registry,
                Some(local),
                JOIN_DEADLINE,
            )
            .await;
            backend.cleanup_socket(&resolved_ref);
            backend.record_join_report(&report);
            return Err(error);
        }
    };
    registry.register(TaskName::Signals, signals);

    // --- Steps 5 & 6: construct state and spawn the coordinator ---
    let state = SessionState::new(
        &meta,
        SessionStateConfig {
            idle_seconds: runtime_config.idle_seconds,
            snippet_enabled: runtime_config.snippet_enabled,
            headless: options.headless,
            scrollback_cap: runtime_config.scrollback_cap,
        },
        local_attached,
    );
    let coordinator = Coordinator::new(
        state,
        SystemTransitionContext::new(),
        IgnoreAppliedEvents,
        routes,
        lanes,
    );
    registry.register(
        TaskName::Coordinator,
        tokio::spawn(coordinator.run(root_cancel.clone())),
    );

    // --- Step 7: mark running (respecting paused) now that adapters are up ---
    backend.mark_running(&id, &meta, pid);

    // The supervisor's own lane-sender clones are no longer needed for wiring;
    // drop the control sender now. Keep one pty-lane sender so `supervise` can
    // synthesize a `PtyFailed` if the command worker dies without emitting its
    // own (a panic). It is dropped right after supervision so the pty lane still
    // closes on adapter liveness during teardown.
    drop(control_tx);
    let pty_failure_injector = pty_tx.clone();
    drop(pty_tx);

    // --- Run: wait for completion while supervising the core tasks ---
    // The completion route carries only `CompleteSession`; a closed route means
    // the coordinator ended without completing — a core failure. Concurrently,
    // the authoritative pty lifecycle dying before it can report `PtyExited` is a
    // core failure too: watching for it here is what stops the supervisor from
    // blocking forever on a completion the coordinator can no longer produce. A
    // command-worker loss is handled without preempting finalization (an ordinary
    // error already emitted `PtyFailed`; a panic is repaired by synthesizing one).
    let exit_code = match registry
        .supervise(&mut completion_rx, &pty_failure_injector)
        .await
    {
        SuperviseOutcome::Completed(exit_code) => exit_code,
        SuperviseOutcome::CoordinatorEnded | SuperviseOutcome::RequiredTaskFailed => {
            // The coordinator could not run its ordered finalization, so the
            // terminal metadata patch it normally emits (via the metadata adapter)
            // never happened and the session would be stranded `running` after the
            // host and socket close. Persist a terminal failure patch directly as
            // a narrow fallback. This runs *only* on the abnormal outcomes — the
            // `Completed` path already wrote the terminal patch through the
            // coordinator — so it never duplicates the normal finalization.
            backend.mark_failed(&id, CORE_FAILURE_MESSAGE);
            CORE_FAILURE_EXIT
        }
    };
    // No longer needed: dropping it lets the pty lane close once the adapters drop
    // their own senders during teardown.
    drop(pty_failure_injector);

    // --- Teardown: cancel, terminate, join, restore, clean, return ---
    let report = drain_and_join(
        &root_cancel,
        terminator,
        registry,
        Some(local),
        JOIN_DEADLINE,
    )
    .await;
    backend.cleanup_socket(&resolved_ref);
    backend.record_join_report(&report);

    // A task that panicked (rather than returning an error value) is a violated
    // invariant: surface it instead of the exit code.
    if report.any_panicked() {
        return Err(SessionError::ActorTask);
    }
    Ok(exit_code)
}

/// Reads an `i64` config value, falling back to `default` (mirrors the legacy
/// host's `cfg_i64`).
fn cfg_i64(config: &serde_json::Value, section: &str, key: &str, default: i64) -> i64 {
    config
        .get(section)
        .and_then(|section| section.get(key))
        .and_then(|value| value.as_i64())
        .unwrap_or(default)
}

/// Builds the child process environment, injecting the session id and an
/// incremented nesting level (mirrors the legacy host's `build_child_env`).
fn build_child_env(id: &str) -> std::collections::HashMap<String, String> {
    let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
    env.insert(SESSION_ENV_VAR.to_string(), id.to_string());
    let nest = std::env::var(NEST_LEVEL_ENV_VAR)
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0)
        + 1;
    env.insert(NEST_LEVEL_ENV_VAR.to_string(), nest.to_string());
    env
}

/// The production [`SessionBackend`]: real pty, terminal, socket, metadata,
/// timer, and signal resources, and the legacy startup metadata patches.
struct RealBackend {
    env: climon_store::Env,
}

impl SessionBackend for RealBackend {
    fn launch_pty(
        &mut self,
        id: &str,
        meta: &SessionMeta,
        effects: mpsc::Receiver<Effect>,
        events: PtyEventSender,
    ) -> SessionResult<PtyLaunch> {
        let (file, args) = climon_pty::resolve_command(&meta.command)?;
        let pty = climon_pty::Pty::spawn(&climon_pty::PtyOptions {
            command: file,
            args,
            cwd: std::path::PathBuf::from(&meta.cwd),
            cols: meta.cols,
            rows: meta.rows,
            env: Some(build_child_env(id)),
        })?;
        let parts = pty.into_parts()?;
        let handles = crate::adapters::pty::spawn_pty_adapter(parts, effects, events);
        Ok(PtyLaunch {
            pid: handles.pid,
            command: handles.command,
            lifecycle: handles.lifecycle,
            terminator: Arc::new(handles.control),
        })
    }

    fn setup_local_terminal(
        &mut self,
        headless: bool,
        events: ControlEventSender,
        cancel: CancellationToken,
    ) -> SessionResult<LocalTerminalSetup> {
        Ok(setup_local_terminal(headless, events, cancel))
    }

    fn launch_console(
        &mut self,
        effects: mpsc::Receiver<Effect>,
        events: ControlEventSender,
    ) -> JoinHandle<Result<(), LocalTerminalError>> {
        spawn_console_adapter(effects, StdoutConsoleWriter::new(), events)
    }

    fn launch_ipc(
        &mut self,
        socket_ref: &str,
        effects: mpsc::Receiver<Effect>,
        events: ControlEventSender,
    ) -> SessionResult<IpcLaunch> {
        let (listener, resolved_ref) = crate::socket::listen_on_session_socket(socket_ref)?;
        let handles = spawn_ipc_adapter(listener, effects, events);
        Ok(IpcLaunch {
            manager: handles.manager,
            resolved_ref,
        })
    }

    fn launch_metadata(
        &mut self,
        id: &str,
        effects: mpsc::Receiver<Effect>,
        events: ControlEventSender,
    ) -> SessionResult<JoinHandle<Result<(), MetadataAdapterError>>> {
        let store = RealMetadataStore::new(self.env.clone(), id.to_string());
        Ok(spawn_metadata_adapter(effects, store, events))
    }

    fn launch_timers(
        &mut self,
        effects: mpsc::Receiver<Effect>,
        events: ControlEventSender,
    ) -> JoinHandle<Result<(), TimerAdapterError>> {
        spawn_timer_adapter(effects, events)
    }

    #[cfg(unix)]
    fn launch_signals(
        &mut self,
        events: ControlEventSender,
        cancel: CancellationToken,
    ) -> SessionResult<JoinHandle<Result<(), SignalAdapterError>>> {
        crate::adapters::signals::spawn_signal_adapter(events, cancel).map_err(SessionError::Io)
    }

    #[cfg(windows)]
    fn launch_signals(
        &mut self,
        events: ControlEventSender,
        cancel: CancellationToken,
    ) -> SessionResult<JoinHandle<Result<(), SignalAdapterError>>> {
        Ok(crate::adapters::signals::spawn_resize_adapter(
            events, cancel,
        ))
    }

    fn patch_socket(&mut self, id: &str, resolved_ref: &str) {
        let _ = climon_store::patch::patch_session_meta(
            &self.env,
            id,
            climon_proto::meta::SessionMetaPatch {
                socket_path: Some(resolved_ref.to_string()),
                ..Default::default()
            },
        );
    }

    fn mark_running(&mut self, id: &str, _meta: &SessionMeta, pid: Option<u32>) {
        let _ = climon_store::patch::patch_session_meta_from_current(&self.env, id, |current| {
            if current.status == climon_proto::meta::SessionStatus::Paused {
                Some(climon_proto::meta::SessionMetaPatch {
                    daemon_pid: pid,
                    priority_reason: Some(climon_proto::meta::PriorityReason::Running),
                    ..Default::default()
                })
            } else {
                Some(climon_proto::meta::SessionMetaPatch {
                    status: Some(climon_proto::meta::SessionStatus::Running),
                    priority_reason: Some(climon_proto::meta::PriorityReason::Running),
                    daemon_pid: pid,
                    ..Default::default()
                })
            }
        });
    }

    fn mark_failed(&mut self, id: &str, error: &str) {
        let now = climon_store::paths::now_iso();
        let error = error.to_string();
        // Idempotent guard: never clobber an already-terminal session. Normal
        // finalization persists its terminal patch (e.g. `completed` with the
        // real exit code) *before* CompleteSession; if that acknowledgement is
        // lost the supervisor's abnormal fallback would otherwise overwrite the
        // correct terminal metadata with `failed`/1. Mark failure only while the
        // session is still non-terminal — spawn failure and genuine abnormal
        // teardown of a live session both start from a non-terminal status.
        let _ =
            climon_store::patch::patch_session_meta_from_current(&self.env, id, move |current| {
                if is_terminal_status(current.status) {
                    return None;
                }
                Some(climon_proto::meta::SessionMetaPatch {
                    status: Some(climon_proto::meta::SessionStatus::Failed),
                    priority_reason: Some(climon_proto::meta::PriorityReason::Failed),
                    completed_at: Some(now.clone()),
                    exit_code: Some(SPAWN_FAILURE_EXIT),
                    error: Some(error),
                    last_activity_at: Some(now),
                    ..Default::default()
                })
            });
    }

    fn cleanup_socket(&mut self, resolved_ref: &str) {
        crate::socket::cleanup_session_socket(resolved_ref);
    }

    fn record_join_report(&mut self, report: &JoinReport) {
        // Surface any teardown anomaly (a task that failed, panicked, or did not
        // join within the deadline) in the daemon log so a degraded shutdown is
        // visible rather than silent. The logger is already initialized by `run`.
        let mut anomalies: Vec<String> = report
            .unjoined
            .iter()
            .map(|name| format!("{name:?}=unjoined"))
            .collect();
        for (name, outcome) in &report.joined {
            match outcome {
                TaskOutcome::Failed(error) => anomalies.push(format!("{name:?}=failed({error})")),
                TaskOutcome::Panicked => anomalies.push(format!("{name:?}=panicked")),
                TaskOutcome::Completed | TaskOutcome::Cancelled => {}
            }
        }
        if anomalies.is_empty() {
            return;
        }
        climon_logging::logger::get_logger().warn(&format!(
            "actor session teardown anomalies: {}",
            anomalies.join(", ")
        ));
    }
}

#[cfg(test)]
mod tests {
    #![allow(dead_code)]

    use super::*;

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use climon_proto::meta::SessionMetaPatch;
    use tokio::runtime::Runtime;

    use crate::adapters::metadata::MetadataStore;
    use crate::engine::effect::OperationId;
    use crate::engine::event::SessionEvent;
    use crate::test_support::harness::base_meta;

    /// Builds the multi-thread runtime the actor engine owns (shared shape with
    /// the production entry point so both cross the same boundary).
    fn build_runtime() -> Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("multi-thread runtime")
    }

    /// Runs `f` on a dedicated OS thread and fails the test if it does not finish
    /// within `bound` of real time. A supervision or teardown hang thus surfaces
    /// as a clean assertion failure instead of an indefinitely blocked (and
    /// undroppable) runtime. The worker thread is intentionally leaked on a hang;
    /// the test process reaps it on exit.
    fn run_bounded<T, F>(bound: Duration, f: F) -> T
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        match rx.recv_timeout(bound) {
            Ok(value) => value,
            Err(_) => {
                panic!("operation did not finish within {bound:?}: teardown/supervision hang")
            }
        }
    }

    /// A [`ChildTerminator`] that records nothing and does nothing, for teardown
    /// tests that do not model a real child.
    struct NoopTerminator;

    impl ChildTerminator for NoopTerminator {
        fn terminate(&self) {}
    }

    /// Which startup step the fake backend should fail at (for unwind tests).
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum FailPoint {
        None,
        Pty,
        Ipc,
        Metadata,
        LocalTerminal,
        Signals,
    }

    /// How the fake pty should behave once running.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum PtyBehavior {
        /// Emit `PtyExited(code)` then return (a naturally-exiting child).
        ExitWith(i32),
        /// Emit `PtyExited(code)` then panic (a task panic after a clean exit).
        ExitThenPanic(i32),
        /// Panic *before* emitting `PtyExited` (a required task dying before the
        /// coordinator can ever complete, so completion never arrives).
        PanicWithoutExit,
        /// Stay alive until cancelled (for partial-startup unwind tests).
        RunUntilCancelled,
    }

    /// How the fake pty *command* worker should behave once running. The command
    /// worker owns the writer/resizer; unlike the lifecycle it never owns the
    /// authoritative child exit, so its abnormal end must not preempt the
    /// coordinator's finalization.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum CommandBehavior {
        /// Drain the pty command route until it closes, then return `Ok` — the
        /// FIFO worker's normal end-of-session behavior.
        DrainUntilClosed,
        /// After the lifecycle has emitted its terminal event, emit one
        /// `PtyFailed` and return `Err` — the adapter's real write-failure path
        /// (`emit_failure`) racing an in-flight child exit. Ordering the failure
        /// after the lifecycle's `PtyExited` proves the coordinator keeps the real
        /// exit code instead of being forced to `CORE_FAILURE_EXIT`.
        FailAfterLifecycleTerminal,
        /// Panic *before* emitting any `PtyFailed` — an unexpected command-executor
        /// death. The supervisor must synthesize a `PtyFailed` so the coordinator
        /// can still finalize and the child is killed.
        PanicBeforeFailure,
    }

    /// Shared observations the fixture inspects after a run.
    #[derive(Default)]
    struct Observations {
        terminated: AtomicUsize,
        marked_running: AtomicUsize,
        marked_failed: AtomicUsize,
        patched_socket: AtomicUsize,
        cleaned_socket: AtomicUsize,
        local_cancel: Mutex<Option<CancellationToken>>,
        join_report: Mutex<Option<JoinReport>>,
        /// The `exit_code` of the terminal metadata patch (one carrying
        /// `completed_at`) once finalization's status barrier is applied, proving
        /// the ordered finalization actually ran rather than being preempted.
        terminal_patch_exit_code: Mutex<Option<i32>>,
        /// Ordered log of the terminal backend calls a test needs to sequence —
        /// `mark_failed` (the abnormal-teardown fallback terminal patch) and
        /// `cleanup_socket` — so a test can assert the fallback lands before the
        /// socket is removed.
        teardown_order: Mutex<Vec<&'static str>>,
        /// Every `(cols, rows)` the fake pty command worker observed on an
        /// `Effect::ResizePty`, in delivery order. Lets a test prove the pty was
        /// actually resized (e.g. seeded from the real local console size at
        /// startup) rather than left at the launch metadata's size.
        resized_to: Mutex<Vec<(u16, u16)>>,
    }

    /// A [`ChildTerminator`] that records how many times it was asked to kill the
    /// child and cancels the fake lifecycle's token, without owning a real pty
    /// control channel.
    struct FakeTerminator {
        obs: Arc<Observations>,
        lifecycle_cancel: CancellationToken,
    }

    impl ChildTerminator for FakeTerminator {
        fn terminate(&self) {
            self.obs.terminated.fetch_add(1, Ordering::SeqCst);
            self.lifecycle_cancel.cancel();
        }
    }

    /// An in-memory [`MetadataStore`] so finalization's status barrier resolves
    /// without touching the filesystem. It records the terminal patch's exit code
    /// so a test can prove the ordered finalization sequence actually reached the
    /// metadata status barrier.
    struct FakeStore {
        obs: Arc<Observations>,
    }

    impl MetadataStore for FakeStore {
        fn patch(&self, patch: SessionMetaPatch) -> Result<(), String> {
            // Only the terminal patch carries `completed_at`; record its exit code
            // so the finalization sequence is observable.
            if patch.completed_at.is_some() {
                *self.obs.terminal_patch_exit_code.lock().unwrap() = patch.exit_code;
            }
            Ok(())
        }

        fn persist_scrollback(&self, _bytes: Vec<u8>) -> Result<(), String> {
            Ok(())
        }
    }

    /// The test [`SessionBackend`]: real metadata/timer/console adapters (with an
    /// in-memory store), a real ephemeral-tcp ipc adapter, a fake pty and fake
    /// signal task, and configurable failure injection.
    struct FakeBackend {
        obs: Arc<Observations>,
        behavior: PtyBehavior,
        command: CommandBehavior,
        fail_at: FailPoint,
        /// When set, the (peripheral) signal adapter task panics right after it
        /// starts, modeling a peripheral adapter dying via a panic.
        panic_signal: bool,
        /// When set, `setup_local_terminal` reports an attached local terminal at
        /// this `(cols, rows)` instead of running the real (headless-only in
        /// tests) platform setup — modeling a real console whose visible size
        /// differs from the launch metadata.
        local_size_override: Option<(u16, u16)>,
    }

    impl SessionBackend for FakeBackend {
        fn launch_pty(
            &mut self,
            _id: &str,
            _meta: &SessionMeta,
            mut effects: mpsc::Receiver<Effect>,
            events: PtyEventSender,
        ) -> SessionResult<PtyLaunch> {
            if self.fail_at == FailPoint::Pty {
                return Err(SessionError::Config("pty spawn failed".to_string()));
            }
            let behavior = self.behavior;
            let command_behavior = self.command;
            // Lets the command worker order its own failure strictly after the
            // lifecycle has emitted its terminal event (a write failure racing an
            // in-flight child exit), so the pty lane carries `PtyExited` first.
            let terminal_emitted = Arc::new(tokio::sync::Notify::new());
            let terminal_emitted_for_command = terminal_emitted.clone();
            let events_for_command = events.clone();
            let obs_for_command = self.obs.clone();
            let command = tokio::spawn(async move {
                match command_behavior {
                    CommandBehavior::DrainUntilClosed => {
                        while let Some(effect) = effects.recv().await {
                            if let Effect::ResizePty { cols, rows, .. } = effect {
                                obs_for_command
                                    .resized_to
                                    .lock()
                                    .unwrap()
                                    .push((cols, rows));
                            }
                        }
                        Ok::<(), PtyAdapterError>(())
                    }
                    CommandBehavior::FailAfterLifecycleTerminal => {
                        // Keep the pty command route open (as a FIFO worker blocked
                        // on a write would) until after the lifecycle's terminal
                        // event, so the coordinator applies `PtyExited` before this
                        // `PtyFailed`.
                        let _effects = effects;
                        terminal_emitted_for_command.notified().await;
                        // The adapter emits its one payload-safe `PtyFailed` before
                        // it returns `Err`; model that exact ordering.
                        let _ = events_for_command
                            .send(SessionEvent::PtyFailed(
                                "pty input write failed".to_string(),
                            ))
                            .await;
                        Err(PtyAdapterError::Write {
                            operation_id: OperationId(1),
                            cause: "broken pipe".to_string(),
                        })
                    }
                    CommandBehavior::PanicBeforeFailure => {
                        // Die without emitting any `PtyFailed`: the supervisor must
                        // synthesize one so the coordinator can still finalize.
                        panic!("fake pty command worker panicked before emitting a failure");
                    }
                }
            });
            // The lifecycle exits on this token so a partial-startup unwind (which
            // calls `terminate`) can join a `RunUntilCancelled` fake.
            let lifecycle_cancel = CancellationToken::new();
            let cancel_for_task = lifecycle_cancel.clone();
            let lifecycle = tokio::spawn(async move {
                match behavior {
                    PtyBehavior::ExitWith(code) => {
                        let _ = events.send(SessionEvent::PtyExited(code)).await;
                        // Release any command worker waiting to fail after exit.
                        terminal_emitted.notify_one();
                    }
                    PtyBehavior::ExitThenPanic(code) => {
                        let _ = events.send(SessionEvent::PtyExited(code)).await;
                        panic!("fake pty lifecycle panicked after a clean exit");
                    }
                    PtyBehavior::PanicWithoutExit => {
                        // Panic before reporting the child exit: the coordinator
                        // never observes `PtyExited`, so it never emits
                        // `CompleteSession`. Only concurrent task supervision can
                        // notice this required task's death.
                        panic!("fake pty lifecycle panicked before reporting exit");
                    }
                    PtyBehavior::RunUntilCancelled => {
                        cancel_for_task.cancelled().await;
                    }
                }
                Ok::<(), PtyAdapterError>(())
            });
            Ok(PtyLaunch {
                pid: Some(4242),
                command,
                lifecycle,
                terminator: Arc::new(FakeTerminator {
                    obs: self.obs.clone(),
                    lifecycle_cancel,
                }),
            })
        }

        fn setup_local_terminal(
            &mut self,
            headless: bool,
            events: ControlEventSender,
            cancel: CancellationToken,
        ) -> SessionResult<LocalTerminalSetup> {
            *self.obs.local_cancel.lock().unwrap() = Some(cancel.clone());
            if self.fail_at == FailPoint::LocalTerminal {
                return Err(SessionError::Io(std::io::Error::other(
                    "local terminal setup failed",
                )));
            }
            if let Some(size) = self.local_size_override {
                return Ok(
                    crate::adapters::local_terminal::attached_local_terminal_for_test(size, cancel),
                );
            }
            // Headless real setup mutates no terminal modes and spawns no worker.
            Ok(setup_local_terminal(headless, events, cancel))
        }

        fn launch_console(
            &mut self,
            effects: mpsc::Receiver<Effect>,
            events: ControlEventSender,
        ) -> JoinHandle<Result<(), LocalTerminalError>> {
            spawn_console_adapter(effects, StdoutConsoleWriter::new(), events)
        }

        fn launch_ipc(
            &mut self,
            _socket_ref: &str,
            effects: mpsc::Receiver<Effect>,
            events: ControlEventSender,
        ) -> SessionResult<IpcLaunch> {
            if self.fail_at == FailPoint::Ipc {
                return Err(SessionError::Io(std::io::Error::other("ipc bind failed")));
            }
            let (listener, resolved_ref) =
                crate::socket::listen_on_session_socket("tcp://127.0.0.1:0")?;
            let handles = spawn_ipc_adapter(listener, effects, events);
            Ok(IpcLaunch {
                manager: handles.manager,
                resolved_ref,
            })
        }

        fn launch_metadata(
            &mut self,
            _id: &str,
            effects: mpsc::Receiver<Effect>,
            events: ControlEventSender,
        ) -> SessionResult<JoinHandle<Result<(), MetadataAdapterError>>> {
            if self.fail_at == FailPoint::Metadata {
                return Err(SessionError::Config("metadata startup failed".to_string()));
            }
            Ok(spawn_metadata_adapter(
                effects,
                FakeStore {
                    obs: self.obs.clone(),
                },
                events,
            ))
        }

        fn launch_timers(
            &mut self,
            effects: mpsc::Receiver<Effect>,
            events: ControlEventSender,
        ) -> JoinHandle<Result<(), TimerAdapterError>> {
            spawn_timer_adapter(effects, events)
        }

        fn launch_signals(
            &mut self,
            _events: ControlEventSender,
            cancel: CancellationToken,
        ) -> SessionResult<JoinHandle<Result<(), SignalAdapterError>>> {
            if self.fail_at == FailPoint::Signals {
                return Err(SessionError::Io(std::io::Error::other(
                    "signal registration failed",
                )));
            }
            let panic_signal = self.panic_signal;
            Ok(tokio::spawn(async move {
                if panic_signal {
                    // A peripheral adapter dying via a panic: the supervisor must
                    // observe it (never detach it) and join it during teardown.
                    panic!("fake signal adapter panicked");
                }
                cancel.cancelled().await;
                Ok::<(), SignalAdapterError>(())
            }))
        }

        fn patch_socket(&mut self, _id: &str, _resolved_ref: &str) {
            self.obs.patched_socket.fetch_add(1, Ordering::SeqCst);
        }

        fn mark_running(&mut self, _id: &str, _meta: &SessionMeta, _pid: Option<u32>) {
            self.obs.marked_running.fetch_add(1, Ordering::SeqCst);
        }

        fn mark_failed(&mut self, _id: &str, _error: &str) {
            self.obs.marked_failed.fetch_add(1, Ordering::SeqCst);
            self.obs.teardown_order.lock().unwrap().push("mark_failed");
        }

        fn cleanup_socket(&mut self, _resolved_ref: &str) {
            self.obs.cleaned_socket.fetch_add(1, Ordering::SeqCst);
            self.obs
                .teardown_order
                .lock()
                .unwrap()
                .push("cleanup_socket");
        }

        fn record_join_report(&mut self, report: &JoinReport) {
            let cloned = JoinReport {
                joined: report.joined.clone(),
                unjoined: report.unjoined.clone(),
            };
            *self.obs.join_report.lock().unwrap() = Some(cloned);
        }
    }

    /// Drives [`run_with`] against a [`FakeBackend`] on a runtime the fixture
    /// owns, then exposes the observations for assertions.
    struct SupervisorFixture {
        obs: Arc<Observations>,
        behavior: PtyBehavior,
        command: CommandBehavior,
        fail_at: FailPoint,
        panic_signal: bool,
        local_size_override: Option<(u16, u16)>,
    }

    impl SupervisorFixture {
        /// Base fixture: a fresh observations set with the given lifecycle and
        /// command-worker behavior and failure-injection point.
        fn new(behavior: PtyBehavior, command: CommandBehavior, fail_at: FailPoint) -> Self {
            SupervisorFixture {
                obs: Arc::new(Observations::default()),
                behavior,
                command,
                fail_at,
                panic_signal: false,
                local_size_override: None,
            }
        }

        /// A session whose child exits cleanly with `code` while a *peripheral*
        /// adapter (the signal task) panics: the supervisor must join every
        /// sibling during teardown and surface the panic as [`SessionError::ActorTask`].
        fn peripheral_adapter_panics(code: i32) -> Self {
            let mut fixture = Self::new(
                PtyBehavior::ExitWith(code),
                CommandBehavior::DrainUntilClosed,
                FailPoint::None,
            );
            fixture.panic_signal = true;
            fixture
        }

        /// A session whose child exits cleanly with `code`, while the local
        /// terminal reports it is attached at the real console `size` — modeling
        /// Windows, where the launcher's `meta.cols`/`meta.rows` come from a
        /// Unix-only `terminal_size()` call and are always the 80x24 placeholder
        /// (see `PlatformConfiguration::size`'s doc in `adapters::local_terminal`).
        fn successful_exit_with_local_size(code: i32, size: (u16, u16)) -> Self {
            let mut fixture = Self::new(
                PtyBehavior::ExitWith(code),
                CommandBehavior::DrainUntilClosed,
                FailPoint::None,
            );
            fixture.local_size_override = Some(size);
            fixture
        }

        /// A session whose child exits cleanly with `code`.
        fn successful_exit(code: i32) -> Self {
            Self::new(
                PtyBehavior::ExitWith(code),
                CommandBehavior::DrainUntilClosed,
                FailPoint::None,
            )
        }

        /// A session whose pty lifecycle task panics after a clean exit.
        fn pty_panics_after_exit(code: i32) -> Self {
            Self::new(
                PtyBehavior::ExitThenPanic(code),
                CommandBehavior::DrainUntilClosed,
                FailPoint::None,
            )
        }

        /// A session whose pty lifecycle task (a required core task) panics
        /// *before* reporting the child exit, so the coordinator never completes
        /// on its own — the supervisor must notice via concurrent supervision.
        fn pty_panics_before_exit() -> Self {
            Self::new(
                PtyBehavior::PanicWithoutExit,
                CommandBehavior::DrainUntilClosed,
                FailPoint::None,
            )
        }

        /// A session whose child exits cleanly with `code` while the pty *command*
        /// worker emits its one `PtyFailed` and then returns `Err` right after the
        /// exit — a write failure racing an in-flight child exit. The command
        /// worker does not own the authoritative child exit, so its abnormal end
        /// must not preempt finalization or override the real exit code.
        fn command_fails_after_child_exit(code: i32) -> Self {
            Self::new(
                PtyBehavior::ExitWith(code),
                CommandBehavior::FailAfterLifecycleTerminal,
                FailPoint::None,
            )
        }

        /// A session whose pty *command* worker panics *before* emitting any
        /// `PtyFailed`, while the child is still running. The supervisor must
        /// synthesize a `PtyFailed` so finalization runs and the child is killed,
        /// then surface the retained panic as [`SessionError::ActorTask`].
        fn command_panics_before_failure() -> Self {
            Self::new(
                PtyBehavior::RunUntilCancelled,
                CommandBehavior::PanicBeforeFailure,
                FailPoint::None,
            )
        }

        /// A session whose child cannot be spawned.
        fn pty_spawn_fails() -> Self {
            Self::new(
                PtyBehavior::RunUntilCancelled,
                CommandBehavior::DrainUntilClosed,
                FailPoint::Pty,
            )
        }

        /// A session that fails to establish the local terminal after the pty is
        /// running.
        fn local_terminal_setup_fails() -> Self {
            Self::new(
                PtyBehavior::RunUntilCancelled,
                CommandBehavior::DrainUntilClosed,
                FailPoint::LocalTerminal,
            )
        }

        /// A session that fails to bind the ipc listener after the pty and local
        /// terminal are up.
        fn ipc_bind_fails() -> Self {
            Self::new(
                PtyBehavior::RunUntilCancelled,
                CommandBehavior::DrainUntilClosed,
                FailPoint::Ipc,
            )
        }

        /// A session that fails to start the metadata adapter after the socket is
        /// bound.
        fn metadata_startup_fails() -> Self {
            Self::new(
                PtyBehavior::RunUntilCancelled,
                CommandBehavior::DrainUntilClosed,
                FailPoint::Metadata,
            )
        }

        /// A session that fails to register the signal adapter after every other
        /// adapter is up.
        fn signal_startup_fails() -> Self {
            Self::new(
                PtyBehavior::RunUntilCancelled,
                CommandBehavior::DrainUntilClosed,
                FailPoint::Signals,
            )
        }

        fn runtime_config() -> RuntimeConfig {
            RuntimeConfig {
                idle_seconds: 0,
                snippet_enabled: false,
                scrollback_cap: 256 * 1024,
            }
        }

        /// Builds the fake backend wired to the fixture's shared observations.
        fn backend(&self) -> FakeBackend {
            FakeBackend {
                obs: self.obs.clone(),
                behavior: self.behavior,
                command: self.command,
                fail_at: self.fail_at,
                panic_signal: self.panic_signal,
                local_size_override: self.local_size_override,
            }
        }

        /// Runs the supervisor to completion on an owned runtime, returning the
        /// session exit result.
        fn run_sync(&self) -> SessionResult<i32> {
            let backend = self.backend();
            let mut meta = base_meta();
            meta.headless = Some(true);
            let options = SessionHostOptions { headless: true };
            build_runtime().block_on(run_with(
                backend,
                Self::runtime_config(),
                meta.id.clone(),
                meta,
                options,
            ))
        }

        /// Whether every registered task joined (none left running).
        fn all_tasks_joined(&self) -> bool {
            match &*self.obs.join_report.lock().unwrap() {
                Some(report) => report.unjoined.is_empty(),
                None => false,
            }
        }

        /// How many times the child was terminated (emergency handle).
        fn terminated(&self) -> usize {
            self.obs.terminated.load(Ordering::SeqCst)
        }

        /// How many times the session was patched to `failed`.
        fn marked_failed(&self) -> usize {
            self.obs.marked_failed.load(Ordering::SeqCst)
        }

        /// How many times the session was patched to `running`.
        fn marked_running(&self) -> usize {
            self.obs.marked_running.load(Ordering::SeqCst)
        }

        /// How many times the socket was cleaned up.
        fn cleaned_socket(&self) -> usize {
            self.obs.cleaned_socket.load(Ordering::SeqCst)
        }

        /// Every `(cols, rows)` the fake pty command worker observed on an
        /// `Effect::ResizePty`, in delivery order.
        fn resized_to(&self) -> Vec<(u16, u16)> {
            self.obs.resized_to.lock().unwrap().clone()
        }

        /// How many times the resolved socket reference was persisted.
        fn patched_socket(&self) -> usize {
            self.obs.patched_socket.load(Ordering::SeqCst)
        }

        /// Whether the local terminal was set up and then shut down (its token
        /// was cancelled by `LocalTerminalSetup::shutdown`).
        fn local_terminal_shut_down(&self) -> bool {
            match &*self.obs.local_cancel.lock().unwrap() {
                Some(cancel) => cancel.is_cancelled(),
                None => false,
            }
        }

        /// Whether the local terminal setup was reached at all.
        fn local_terminal_set_up(&self) -> bool {
            self.obs.local_cancel.lock().unwrap().is_some()
        }
    }

    /// The actor engine owns its runtime and returns the child's exit code once
    /// the session has completed, having joined every task it spawned.
    #[test]
    fn actor_engine_owns_runtime_and_returns_exit_code() {
        let fixture = SupervisorFixture::successful_exit(7);
        let code = fixture.run_sync().unwrap();
        assert_eq!(code, 7);
        assert!(fixture.all_tasks_joined());
    }

    /// A task that panics is joined and surfaced as [`SessionError::ActorTask`]
    /// rather than a hang or a swallowed error.
    #[test]
    fn task_panic_is_reported_as_actor_task_error() {
        let fixture = SupervisorFixture::pty_panics_after_exit(3);
        let error = fixture.run_sync().unwrap_err();
        assert!(matches!(error, SessionError::ActorTask));
        assert!(fixture.all_tasks_joined());
    }

    /// A required core task that dies *before* the coordinator can complete (no
    /// `PtyExited` was reported, so no `CompleteSession` is ever produced) is
    /// observed concurrently with the completion route: the supervisor tears
    /// everything down and surfaces [`SessionError::ActorTask`] instead of
    /// blocking forever on `completion_rx`.
    #[test]
    fn required_task_panic_before_completion_is_reported_not_hung() {
        let fixture = SupervisorFixture::pty_panics_before_exit();
        let obs = fixture.obs.clone();
        let error = run_bounded(Duration::from_secs(10), move || fixture.run_sync()).unwrap_err();
        assert!(matches!(error, SessionError::ActorTask));
        let all_joined = matches!(
            &*obs.join_report.lock().unwrap(),
            Some(report) if report.unjoined.is_empty()
        );
        assert!(
            all_joined,
            "every supervised task must be joined during teardown"
        );
    }

    /// When a required task dies before the coordinator can complete the session,
    /// the coordinator's ordered finalization never runs, so the terminal
    /// metadata patch it normally emits is never produced and the session would be
    /// stranded `running` after the host and socket close (macOS DAR-08). The
    /// supervisor must persist exactly one terminal failure patch as a narrow
    /// fallback, and it must land *before* the socket is cleaned up so metadata is
    /// never left live once the socket is gone.
    #[test]
    fn abnormal_teardown_persists_terminal_metadata_before_socket_cleanup() {
        let fixture = SupervisorFixture::pty_panics_before_exit();
        let obs = fixture.obs.clone();
        let error = run_bounded(Duration::from_secs(10), move || fixture.run_sync()).unwrap_err();
        assert!(matches!(error, SessionError::ActorTask));
        // The coordinator never reached its ordered finalization, so no terminal
        // patch came through the metadata adapter...
        assert_eq!(
            *obs.terminal_patch_exit_code.lock().unwrap(),
            None,
            "the coordinator must not have run its ordered finalization"
        );
        // ...but the fallback persisted exactly one terminal failure patch, so the
        // session cannot remain `running`.
        assert_eq!(
            obs.marked_failed.load(Ordering::SeqCst),
            1,
            "abnormal actor teardown must persist exactly one terminal failure patch"
        );
        // And that patch landed before the socket was cleaned up.
        let order = obs.teardown_order.lock().unwrap().clone();
        let failed_idx = order.iter().position(|event| *event == "mark_failed");
        let cleanup_idx = order.iter().position(|event| *event == "cleanup_socket");
        assert!(
            matches!((failed_idx, cleanup_idx), (Some(failed), Some(cleanup)) if failed < cleanup),
            "the terminal failure patch must be persisted before socket cleanup, got {order:?}"
        );
    }

    /// A normally-completing session finalizes through the coordinator's ordered
    /// path — one terminal patch via the metadata adapter. The abnormal-teardown
    /// fallback must not fire, so there is no duplicate terminal failure patch.
    #[test]
    fn normal_completion_does_not_persist_fallback_terminal_patch() {
        let fixture = SupervisorFixture::successful_exit(0);
        let obs = fixture.obs.clone();
        let code = fixture.run_sync().unwrap();
        assert_eq!(code, 0);
        assert_eq!(
            *obs.terminal_patch_exit_code.lock().unwrap(),
            Some(0),
            "the coordinator's ordered finalization must run on a normal exit"
        );
        assert_eq!(
            obs.marked_failed.load(Ordering::SeqCst),
            0,
            "the fallback terminal patch must not fire when the coordinator completed"
        );
    }

    /// The pty command worker is not the authoritative child owner: when it emits
    /// its one `PtyFailed` and then returns `Err` *after* the lifecycle has
    /// already reported the real child exit, its abnormal end must not preempt the
    /// coordinator's finalization. The supervisor waits for `CompleteSession`, so
    /// the *real* exit code and the full ordered finalization (including the
    /// metadata status barrier) are preserved rather than forced to
    /// `CORE_FAILURE_EXIT`.
    #[test]
    fn command_failure_after_child_exit_preserves_real_exit_code() {
        let fixture = SupervisorFixture::command_fails_after_child_exit(42);
        let obs = fixture.obs.clone();
        let code = run_bounded(Duration::from_secs(10), move || fixture.run_sync())
            .expect("a command-worker failure after the child exit is not a supervisor error");
        assert_eq!(
            code, 42,
            "the real finalization exit code must be preserved, not forced to CORE_FAILURE_EXIT"
        );
        // Finalization ran to its status barrier with the real exit code.
        assert_eq!(
            *obs.terminal_patch_exit_code.lock().unwrap(),
            Some(42),
            "ordered finalization must reach the metadata status barrier with the real code"
        );
        let all_joined = matches!(
            &*obs.join_report.lock().unwrap(),
            Some(report) if report.unjoined.is_empty()
        );
        assert!(
            all_joined,
            "every supervised task must be joined during teardown"
        );
    }

    /// A pty command worker that panics *before* emitting any `PtyFailed` (the
    /// child still running) must not hang the session: the coordinator would
    /// otherwise never learn the executor is gone. The supervisor synthesizes a
    /// `PtyFailed` so finalization runs and the child is killed, retains the
    /// panic, and ultimately surfaces [`SessionError::ActorTask`] after a clean
    /// teardown.
    #[test]
    fn command_panic_before_failure_synthesizes_finalization_then_reports_actor_task() {
        let fixture = SupervisorFixture::command_panics_before_failure();
        let obs = fixture.obs.clone();
        let error = run_bounded(Duration::from_secs(10), move || fixture.run_sync()).unwrap_err();
        assert!(
            matches!(error, SessionError::ActorTask),
            "a panicked command worker must ultimately map to ActorTask"
        );
        assert_eq!(
            *obs.terminal_patch_exit_code.lock().unwrap(),
            Some(CORE_FAILURE_EXIT),
            "the synthesized failure must drive ordered finalization to the status barrier"
        );
        assert!(
            obs.terminated.load(Ordering::SeqCst) >= 1,
            "the child must be terminated during teardown"
        );
        let all_joined = matches!(
            &*obs.join_report.lock().unwrap(),
            Some(report) if report.unjoined.is_empty()
        );
        assert!(
            all_joined,
            "every supervised task must be joined during teardown"
        );
    }

    /// A *peripheral* adapter dying via a panic (here the signal task) must never
    /// be detached: the supervisor observes it, tears the session down, cancels
    /// and joins every sibling task, terminates the child, and surfaces the panic
    /// as [`SessionError::ActorTask`] after a clean teardown.
    #[test]
    fn peripheral_adapter_panic_joins_all_siblings_and_reports_actor_task() {
        let fixture = SupervisorFixture::peripheral_adapter_panics(9);
        let obs = fixture.obs.clone();
        let error = run_bounded(Duration::from_secs(10), move || fixture.run_sync()).unwrap_err();
        assert!(
            matches!(error, SessionError::ActorTask),
            "a panicked peripheral adapter must surface as ActorTask"
        );
        assert!(
            obs.terminated.load(Ordering::SeqCst) >= 1,
            "the child must be terminated during teardown"
        );
        let all_joined = matches!(
            &*obs.join_report.lock().unwrap(),
            Some(report) if report.unjoined.is_empty()
        );
        assert!(
            all_joined,
            "every sibling task must be joined during teardown — none detached"
        );
    }

    /// A pty spawn failure persists a `failed` session and returns exit code 1
    /// (legacy parity), with no tasks spawned or leaked.
    #[test]
    fn pty_spawn_failure_marks_failed_and_returns_one() {
        let fixture = SupervisorFixture::pty_spawn_fails();
        let code = fixture.run_sync().unwrap();
        assert_eq!(code, 1);
        assert_eq!(fixture.marked_failed(), 1);
        assert_eq!(fixture.marked_running(), 0);
        assert!(fixture.all_tasks_joined());
    }

    /// A local-terminal setup failure after the pty is running unwinds the pty:
    /// it is terminated exactly once and joined, and the error propagates.
    #[test]
    fn local_terminal_failure_unwinds_pty() {
        let fixture = SupervisorFixture::local_terminal_setup_fails();
        let error = fixture.run_sync().unwrap_err();
        assert!(matches!(error, SessionError::Io(_)));
        assert_eq!(fixture.terminated(), 1);
        assert_eq!(fixture.marked_running(), 0);
        assert_eq!(fixture.patched_socket(), 0);
        assert!(fixture.all_tasks_joined());
    }

    /// An ipc bind failure after the pty and local terminal are up unwinds both:
    /// the pty is terminated and joined, the local terminal is shut down, and no
    /// socket is patched or cleaned.
    #[test]
    fn ipc_bind_failure_unwinds_pty_and_local_terminal() {
        let fixture = SupervisorFixture::ipc_bind_fails();
        let error = fixture.run_sync().unwrap_err();
        assert!(matches!(error, SessionError::Io(_)));
        assert_eq!(fixture.terminated(), 1);
        assert!(fixture.local_terminal_shut_down());
        assert_eq!(fixture.patched_socket(), 0);
        assert_eq!(fixture.cleaned_socket(), 0);
        assert_eq!(fixture.marked_running(), 0);
        assert!(fixture.all_tasks_joined());
    }

    /// A metadata startup failure after the socket is bound unwinds every earlier
    /// resource: the pty is terminated and joined, the local terminal is shut
    /// down, and the bound socket is cleaned up exactly once.
    #[test]
    fn metadata_failure_unwinds_socket_local_and_pty() {
        let fixture = SupervisorFixture::metadata_startup_fails();
        let error = fixture.run_sync().unwrap_err();
        assert!(matches!(error, SessionError::Config(_)));
        assert_eq!(fixture.terminated(), 1);
        assert!(fixture.local_terminal_shut_down());
        assert_eq!(fixture.patched_socket(), 1);
        assert_eq!(fixture.cleaned_socket(), 1);
        assert_eq!(fixture.marked_running(), 0);
        assert!(fixture.all_tasks_joined());
    }

    /// A signal-adapter registration failure unwinds every already-started
    /// adapter and owned resource — no task is left detached during rollback.
    #[test]
    fn signal_failure_unwinds_all_started_adapters() {
        let fixture = SupervisorFixture::signal_startup_fails();
        let error = fixture.run_sync().unwrap_err();
        assert!(matches!(error, SessionError::Io(_)));
        assert_eq!(fixture.terminated(), 1);
        assert!(fixture.local_terminal_shut_down());
        assert_eq!(fixture.cleaned_socket(), 1);
        assert_eq!(fixture.marked_running(), 0);
        assert!(fixture.all_tasks_joined());
    }

    /// The teardown deadline must bound *every* joinable owned worker, including
    /// the local input worker. A worker that never honours cancellation or
    /// interruption must not wedge teardown: the injected deadline abandons the
    /// join, teardown still returns, and the mode guard still restores the
    /// terminal. The deadline is injected small so a real timer fires quickly
    /// (paused time cannot auto-advance past a pending `spawn_blocking` join),
    /// and a real-time watchdog turns any remaining hang into a failure.
    #[test]
    fn teardown_deadline_bounds_stuck_local_input() {
        let (unjoined_empty, restored) = run_bounded(Duration::from_secs(10), || {
            let rt = build_runtime();
            let result = rt.block_on(async {
                let root_cancel = CancellationToken::new();
                // No supervised tasks: isolate the local input worker's join so
                // the only thing the deadline can be bounding is `shutdown`.
                let registry = TaskRegistry::new();
                let terminator: Arc<dyn ChildTerminator> = Arc::new(NoopTerminator);
                let local_cancel = CancellationToken::new();
                let (local, restored) =
                    crate::adapters::local_terminal::stuck_local_terminal_for_test(local_cancel);

                let report = drain_and_join(
                    &root_cancel,
                    terminator,
                    registry,
                    Some(local),
                    Duration::from_millis(250),
                )
                .await;

                (report.unjoined.is_empty(), restored.load(Ordering::SeqCst))
            });
            // The stuck input worker is intentionally leaked; shut the runtime
            // down without waiting for it so this helper thread can return
            // (a real supervisor exits the process, reaping the worker).
            rt.shutdown_background();
            result
        });
        assert!(
            unjoined_empty,
            "no supervised tasks were registered, so none can be unjoined"
        );
        assert!(
            restored,
            "terminal modes must be restored even when the input worker is abandoned at the deadline"
        );
    }

    /// A unique `$CLIMON_HOME` scratch dir under `target/` (never the system
    /// temp dir), with its `sessions/` subdir created, for `RealBackend` store
    /// integration tests.
    fn scratch_home(tag: &str) -> (climon_store::Env, String) {
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
            .join("climon-session-supervisor-test-tmp")
            .join(format!("{tag}-{}-{nanos}-{n}", std::process::id()));
        std::fs::create_dir_all(home.join("sessions")).expect("create sessions dir");
        (
            climon_store::Env::with_home(&home),
            format!("supervisor-{tag}"),
        )
    }

    /// Normal finalization persists its terminal metadata patch (e.g. `completed`
    /// with the real exit code) *before* CompleteSession. If that patch is
    /// persisted but the coordinator completion is lost, supervision yields
    /// `CoordinatorEnded` and the abnormal fallback calls
    /// [`RealBackend::mark_failed`]. That fallback must be idempotent: it must
    /// NOT overwrite the already-terminal `completed`/real-exit-code metadata
    /// with `failed`/1.
    #[test]
    fn mark_failed_preserves_already_terminal_metadata() {
        use climon_proto::meta::{PriorityReason, SessionStatus};

        let (env, id) = scratch_home("terminal-guard");
        let mut meta = base_meta();
        meta.id = id.clone();
        meta.status = SessionStatus::Completed;
        meta.priority_reason = PriorityReason::Completed;
        meta.exit_code = Some(0);
        meta.completed_at = Some("1970-01-01T00:00:01.000Z".to_string());
        climon_store::meta::write_session_meta(&env, &meta).expect("write terminal meta");

        let mut backend = RealBackend { env: env.clone() };
        backend.mark_failed(&id, CORE_FAILURE_MESSAGE);

        let on_disk = climon_store::meta::read_session_meta(&env, &id)
            .expect("read meta")
            .expect("meta present");
        assert_eq!(
            on_disk.status,
            SessionStatus::Completed,
            "the fallback must not clobber an already-terminal status"
        );
        assert_eq!(
            on_disk.exit_code,
            Some(0),
            "the fallback must not overwrite the real exit code"
        );
        assert_eq!(
            on_disk.priority_reason,
            PriorityReason::Completed,
            "the fallback must not overwrite the terminal priority reason"
        );
        assert_eq!(
            on_disk.error, None,
            "the fallback must not attach a spurious error to a completed session"
        );
    }

    /// The guard must preserve spawn-failure and genuine abnormal-teardown
    /// behavior: when the session is still non-terminal (`running`),
    /// [`RealBackend::mark_failed`] must persist the terminal `failed` patch with
    /// the failure exit code and error.
    #[test]
    fn mark_failed_marks_non_terminal_session_failed() {
        use climon_proto::meta::{PriorityReason, SessionStatus};

        let (env, id) = scratch_home("live-failure");
        let mut meta = base_meta();
        meta.id = id.clone();
        meta.status = SessionStatus::Running;
        meta.priority_reason = PriorityReason::Running;
        climon_store::meta::write_session_meta(&env, &meta).expect("write running meta");

        let mut backend = RealBackend { env: env.clone() };
        backend.mark_failed(&id, "spawn failed");

        let on_disk = climon_store::meta::read_session_meta(&env, &id)
            .expect("read meta")
            .expect("meta present");
        assert_eq!(on_disk.status, SessionStatus::Failed);
        assert_eq!(on_disk.priority_reason, PriorityReason::Failed);
        assert_eq!(on_disk.exit_code, Some(SPAWN_FAILURE_EXIT));
        assert_eq!(on_disk.error.as_deref(), Some("spawn failed"));
        assert!(on_disk.completed_at.is_some());
    }

    /// DAR-01 regression: on Windows, the launcher's `meta.cols`/`meta.rows`
    /// come from a Unix-only `terminal_size()` call and are always the 80x24
    /// placeholder (`base_meta()` models this exactly). The Windows resize
    /// poller (`adapters::signals::spawn_resize_adapter`) only reports *changes*
    /// from its own initial sample, so without an explicit initial resize the
    /// pty/grid stayed at that bogus 80x24 for the whole session unless the user
    /// happened to resize the window later — this is exactly what produced the
    /// reported diagonal `~` / misplaced status line in Vim on a real Windows
    /// Terminal tab whose actual size was not 80x24. When the local terminal
    /// reports it is attached at a real size that differs from the launch
    /// metadata, the supervisor must seed the coordinator with that real size
    /// before the session is considered started, so the pty is resized to match
    /// the real console right away rather than waiting for a subsequent resize.
    #[cfg(windows)]
    #[test]
    fn windows_attached_local_terminal_seeds_real_console_size_at_startup() {
        let fixture = SupervisorFixture::successful_exit_with_local_size(0, (137, 51));
        let code = fixture.run_sync().expect("session completes");
        assert_eq!(code, 0);
        assert_eq!(
            fixture.resized_to(),
            vec![(137, 51)],
            "the pty must be resized to the real console size at startup instead of \
             staying at the launch metadata's 80x24"
        );
    }
}
