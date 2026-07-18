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
/// Bounded deadline for joining every owned task during teardown.
const JOIN_DEADLINE: Duration = Duration::from_secs(5);

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
}

impl TaskRegistry {
    fn new() -> Self {
        TaskRegistry {
            set: JoinSet::new(),
            names: Vec::new(),
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

    /// Joins every registered task, waiting at most `deadline` in total. Tasks
    /// that have not joined by the deadline are reported as `unjoined` and their
    /// forwarding tasks aborted (a best-effort net; blocking work may outlive the
    /// process only until it exits).
    async fn join_all(mut self, deadline: Duration) -> JoinReport {
        let mut joined: Vec<(TaskName, TaskOutcome)> = Vec::new();
        let drain = async {
            while let Some(result) = self.set.join_next().await {
                if let Ok(entry) = result {
                    joined.push(entry);
                }
            }
        };
        let unjoined = match tokio::time::timeout(deadline, drain).await {
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

    /// Persists a `failed` session when the child could not be spawned.
    fn mark_failed(&mut self, id: &str, error: &str);

    /// Removes the session socket during teardown (no-op for a TCP reference).
    fn cleanup_socket(&mut self, resolved_ref: &str);

    /// Records the final join report (production ignores it; tests inspect it).
    fn record_join_report(&mut self, _report: &JoinReport) {}
}

/// Cancels adapters, terminates the child (off-runtime), joins every task under
/// the deadline, and restores the local terminal — the shared teardown for both
/// the normal completion path and every partial-startup unwind. `routes` and
/// `lanes` must already be closed (the coordinator drops them on completion; an
/// early failure drops them at the call site) so the registered adapters can
/// drain and exit.
async fn drain_and_join(
    root_cancel: &CancellationToken,
    terminator: Arc<dyn ChildTerminator>,
    registry: TaskRegistry,
    local: Option<LocalTerminalSetup>,
) -> JoinReport {
    // Stop the signal adapter and any cancellation-driven work.
    root_cancel.cancel();
    // Ensure the child is gone so the pty lifecycle loop can reach its join.
    // `terminate` is blocking, so it runs off the Tokio workers.
    let _ = tokio::task::spawn_blocking(move || terminator.terminate()).await;
    // Join every supervised task within the deadline.
    let report = registry.join_all(JOIN_DEADLINE).await;
    // Interrupt any blocked local input, join the input worker, and restore
    // terminal modes only after the workers have stopped.
    if let Some(local) = local {
        let _ = local.shutdown().await;
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
                let report = drain_and_join(&root_cancel, terminator, registry, None).await;
                backend.record_join_report(&report);
                return Err(error);
            }
        };
    let local_attached = local.attached;
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
            let report = drain_and_join(&root_cancel, terminator, registry, Some(local)).await;
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
            let report = drain_and_join(&root_cancel, terminator, registry, Some(local)).await;
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
            let report = drain_and_join(&root_cancel, terminator, registry, Some(local)).await;
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

    // The supervisor's own lane-sender clones are no longer needed; dropping them
    // lets the lanes close once the adapters drop theirs.
    drop(control_tx);
    drop(pty_tx);

    // --- Run: wait for the coordinator's completion effect ---
    // The completion route carries only `CompleteSession`; a `None` means the
    // coordinator ended (dropping the route) without completing — a core failure.
    let exit_code = match completion_rx.recv().await {
        Some(Effect::CompleteSession { exit_code }) => exit_code,
        _ => CORE_FAILURE_EXIT,
    };

    // --- Teardown: cancel, terminate, join, restore, clean, return ---
    let report = drain_and_join(&root_cancel, terminator, registry, Some(local)).await;
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
        let _ = climon_store::patch::patch_session_meta(
            &self.env,
            id,
            climon_proto::meta::SessionMetaPatch {
                status: Some(climon_proto::meta::SessionStatus::Failed),
                priority_reason: Some(climon_proto::meta::PriorityReason::Failed),
                completed_at: Some(now.clone()),
                exit_code: Some(SPAWN_FAILURE_EXIT),
                error: Some(error.to_string()),
                last_activity_at: Some(now),
                ..Default::default()
            },
        );
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
        /// Stay alive until cancelled (for partial-startup unwind tests).
        RunUntilCancelled,
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
    /// without touching the filesystem.
    struct FakeStore;

    impl MetadataStore for FakeStore {
        fn patch(&self, _patch: SessionMetaPatch) -> Result<(), String> {
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
        fail_at: FailPoint,
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
            let command = tokio::spawn(async move {
                while effects.recv().await.is_some() {}
                Ok::<(), PtyAdapterError>(())
            });
            // The lifecycle exits on this token so a partial-startup unwind (which
            // calls `terminate`) can join a `RunUntilCancelled` fake.
            let lifecycle_cancel = CancellationToken::new();
            let cancel_for_task = lifecycle_cancel.clone();
            let lifecycle = tokio::spawn(async move {
                match behavior {
                    PtyBehavior::ExitWith(code) => {
                        let _ = events.send(SessionEvent::PtyExited(code)).await;
                    }
                    PtyBehavior::ExitThenPanic(code) => {
                        let _ = events.send(SessionEvent::PtyExited(code)).await;
                        panic!("fake pty lifecycle panicked after a clean exit");
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
            Ok(spawn_metadata_adapter(effects, FakeStore, events))
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
            Ok(tokio::spawn(async move {
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
        }

        fn cleanup_socket(&mut self, _resolved_ref: &str) {
            self.obs.cleaned_socket.fetch_add(1, Ordering::SeqCst);
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
        fail_at: FailPoint,
    }

    impl SupervisorFixture {
        /// A session whose child exits cleanly with `code`.
        fn successful_exit(code: i32) -> Self {
            SupervisorFixture {
                obs: Arc::new(Observations::default()),
                behavior: PtyBehavior::ExitWith(code),
                fail_at: FailPoint::None,
            }
        }

        /// A session whose pty lifecycle task panics after a clean exit.
        fn pty_panics_after_exit(code: i32) -> Self {
            SupervisorFixture {
                obs: Arc::new(Observations::default()),
                behavior: PtyBehavior::ExitThenPanic(code),
                fail_at: FailPoint::None,
            }
        }

        /// A session whose child cannot be spawned.
        fn pty_spawn_fails() -> Self {
            SupervisorFixture {
                obs: Arc::new(Observations::default()),
                behavior: PtyBehavior::RunUntilCancelled,
                fail_at: FailPoint::Pty,
            }
        }

        /// A session that fails to establish the local terminal after the pty is
        /// running.
        fn local_terminal_setup_fails() -> Self {
            SupervisorFixture {
                obs: Arc::new(Observations::default()),
                behavior: PtyBehavior::RunUntilCancelled,
                fail_at: FailPoint::LocalTerminal,
            }
        }

        /// A session that fails to bind the ipc listener after the pty and local
        /// terminal are up.
        fn ipc_bind_fails() -> Self {
            SupervisorFixture {
                obs: Arc::new(Observations::default()),
                behavior: PtyBehavior::RunUntilCancelled,
                fail_at: FailPoint::Ipc,
            }
        }

        /// A session that fails to start the metadata adapter after the socket is
        /// bound.
        fn metadata_startup_fails() -> Self {
            SupervisorFixture {
                obs: Arc::new(Observations::default()),
                behavior: PtyBehavior::RunUntilCancelled,
                fail_at: FailPoint::Metadata,
            }
        }

        /// A session that fails to register the signal adapter after every other
        /// adapter is up.
        fn signal_startup_fails() -> Self {
            SupervisorFixture {
                obs: Arc::new(Observations::default()),
                behavior: PtyBehavior::RunUntilCancelled,
                fail_at: FailPoint::Signals,
            }
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
                fail_at: self.fail_at,
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
}
