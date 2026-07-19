//! Exclusively-owned PTY adapter: the tasks that own the split
//! [`climon_pty::PtyParts`] and translate pty effects into real I/O, feeding
//! output/exit/failure back to the coordinator's pty event lane.
//!
//! Two owned workers share the parts with no `Arc<Mutex>` around any PTY
//! resource, coordinated by a **durable child-control channel** so the child
//! can always be terminated and reaped:
//!
//! - a **FIFO command worker** owns the writer and resizer. It drains the
//!   coordinator's pty effect route ([`EffectReceivers::pty`]) directly and
//!   executes [`Effect::WritePty`] (write then flush), [`Effect::ResizePty`],
//!   and [`Effect::KillPty`] serially, off the Tokio workers (a dedicated
//!   `spawn_blocking` that uses `blocking_recv`). It does **not** own the child:
//!   a [`Effect::KillPty`] sends a synchronous kill request to the child-owner
//!   loop and waits for the result before processing any later command, so the
//!   authoritative kill stays serialized through the FIFO worker.
//! - a **child-owner lifecycle loop** owns the reader, the authoritative
//!   [`climon_pty::PtyWaiter`] child handle (its original-child
//!   `try_wait`/`kill`, not the weaker cloned killer), and the last strong
//!   master. It concurrently owns three things — the child owner/master, the
//!   reader thread's outcome channel, and the durable kill-request channel — and
//!   drives them in a responsive poll loop rather than blocking forever in
//!   `wait`. It reads output as [`SessionEvent::PtyOutput`], observes the child
//!   exit / a reader error/panic / a kill request promptly, releases the master
//!   so a Windows ConPTY reader can EOF, and emits exactly one terminal event
//!   ([`SessionEvent::PtyExited`] or [`SessionEvent::PtyFailed`]). It owns the
//!   reader thread for its whole life and **always joins it** before returning —
//!   the reader is never detached.
//!
//! ## Single terminal event per root failure
//! A command failure (write/flush error, kill error, unexpected effect) is
//! emitted **by the command worker** as one [`SessionEvent::PtyFailed`]; the
//! command worker requests child termination through the durable channel and the
//! child-owner loop then converges *silently* (no second terminal event). A
//! spontaneous failure the loop observes itself (reader error/panic, wait error)
//! is emitted by the loop.
//!
//! ## Durable teardown: a failed kill stays recoverable
//! A [`climon_pty::PtyWaiter::kill`] is an authoritative *attempt*, not a
//! guarantee — it can return an error. A failed kill therefore does **not** tear
//! the loop down: it replies with the error (so the command worker emits its one
//! failure and exits), cedes the terminal event, and keeps owning the child, the
//! reader, and the durable receiver — staying alive and retryable. A later
//! emergency [`PtyControlHandle::terminate`], or the child's natural exit, can
//! then still reap the child, after which the loop drains and joins the reader
//! and returns. It never abandons (detaches) the reader to escape a stuck child.
//!
//! ## Emergency control survives the command worker
//! [`PtyAdapterHandles`] retains a cloneable [`PtyControlHandle`] to the same
//! durable channel, so the supervisor (Task 14) can terminate the child even
//! after the command worker has exited or its route has closed — the child-owner
//! loop, not the command worker, owns the receiver. The handle owns no PTY
//! resource and no mutex.
//!
//! Terminal input/output bytes never enter an error, log, or debug trace.
//!
//! [`EffectReceivers::pty`]: crate::engine::coordinator::EffectReceivers
//! [`Effect::WritePty`]: crate::engine::effect::Effect::WritePty
//! [`Effect::ResizePty`]: crate::engine::effect::Effect::ResizePty
//! [`Effect::KillPty`]: crate::engine::effect::Effect::KillPty

// Every item below is exercised by this module's tests now and wired into the
// supervisor (Task 14) later, so — like the metadata adapter it mirrors — the
// module carries a crate-staged `dead_code` allowance until that wiring lands.
#![allow(dead_code)]

use std::fmt;
use std::io::{Read, Write};
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::task::{spawn_blocking, JoinHandle};

use climon_pty::{PtyResizer, PtyWaiter};

use crate::engine::coordinator::{LaneSendError, PtyEventSender};
use crate::engine::effect::{Effect, OperationId};
use crate::engine::event::SessionEvent;

/// The largest output chunk the reader bridge forwards per read, matching the
/// legacy host's reader buffer so Windows ConPTY behaviour is unchanged.
const PTY_READ_CHUNK: usize = 65536;

/// How long the child-owner loop parks waiting for a kill request before
/// re-polling the child/reader. A kill request wakes it immediately; the timeout
/// only bounds how stale a child-exit or reader outcome poll can be. Small enough
/// to stay responsive, large enough not to busy-spin.
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(20);

// ---- errors ------------------------------------------------------------

/// A failure that ends a pty adapter worker.
///
/// Every variant is payload-free: it names the failed operation (and, where
/// useful, its operation id) and carries only an already payload-safe cause
/// string — never terminal input or output bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PtyAdapterError {
    /// An effect other than [`Effect::WritePty`] / [`Effect::ResizePty`] /
    /// [`Effect::KillPty`] reached the pty command route. Carries the offending
    /// variant's payload-free name.
    UnexpectedEffect(&'static str),
    /// The pty event lane closed, so a pty event could not be delivered. The
    /// worker reports this rather than retrying or exiting silently.
    EventLaneClosed,
    /// Writing pty input (`write_all` or the following `flush`) failed.
    Write {
        operation_id: OperationId,
        cause: String,
    },
    /// Killing the pty child failed.
    Kill {
        operation_id: OperationId,
        cause: String,
    },
    /// Reading pty output failed.
    Read { cause: String },
    /// Waiting for the pty child to exit failed.
    Wait { cause: String },
    /// The blocking reader thread panicked.
    ReaderPanic,
}

impl fmt::Display for PtyAdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PtyAdapterError::UnexpectedEffect(name) => {
                write!(
                    f,
                    "unexpected non-pty effect on the pty command route: {name}"
                )
            }
            PtyAdapterError::EventLaneClosed => {
                write!(f, "pty event lane closed before a pty event was delivered")
            }
            PtyAdapterError::Write {
                operation_id,
                cause,
            } => write!(
                f,
                "pty input write failed (operation {}): {cause}",
                operation_id.0
            ),
            PtyAdapterError::Kill {
                operation_id,
                cause,
            } => write!(f, "pty kill failed (operation {}): {cause}", operation_id.0),
            PtyAdapterError::Read { cause } => write!(f, "pty read failed: {cause}"),
            PtyAdapterError::Wait { cause } => write!(f, "pty wait failed: {cause}"),
            PtyAdapterError::ReaderPanic => write!(f, "pty reader thread panicked"),
        }
    }
}

impl std::error::Error for PtyAdapterError {}

// ---- commands ----------------------------------------------------------

/// The internal representation of a pty command effect after it has been
/// validated off the route. Each variant retains its `operation_id` for
/// observability, even where no completion event is produced (there are no
/// command-success events in the pty event model).
enum PtyCommand {
    Input {
        operation_id: OperationId,
        bytes: Vec<u8>,
    },
    Resize {
        operation_id: OperationId,
        cols: u16,
        rows: u16,
    },
    Kill {
        operation_id: OperationId,
    },
}

impl PtyCommand {
    /// Validates an effect off the pty command route, rejecting anything that is
    /// not a write, resize, or kill.
    fn from_effect(effect: Effect) -> Result<PtyCommand, PtyAdapterError> {
        match effect {
            Effect::WritePty {
                operation_id,
                bytes,
            } => Ok(PtyCommand::Input {
                operation_id,
                bytes,
            }),
            Effect::ResizePty {
                operation_id,
                cols,
                rows,
            } => Ok(PtyCommand::Resize {
                operation_id,
                cols,
                rows,
            }),
            Effect::KillPty { operation_id } => Ok(PtyCommand::Kill { operation_id }),
            other => Err(PtyAdapterError::UnexpectedEffect(effect_variant_name(
                &other,
            ))),
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

// ---- event sink --------------------------------------------------------

/// Blocking delivery of pty-lane events. Every pty worker runs off the Tokio
/// workers (a `spawn_blocking` task or a scoped std reader thread), so events
/// are emitted with a blocking call. Implemented for [`PtyEventSender`] in
/// production; a closed lane is reported as [`PtyAdapterError::EventLaneClosed`].
pub(crate) trait PtyEventSink: Send + Clone + 'static {
    /// Emits `event`, blocking for bounded capacity, or failing if the lane has
    /// closed.
    fn emit(&self, event: SessionEvent) -> Result<(), PtyAdapterError>;
}

impl PtyEventSink for PtyEventSender {
    fn emit(&self, event: SessionEvent) -> Result<(), PtyAdapterError> {
        self.blocking_send(event).map_err(|err| match err {
            // A pty adapter only ever emits pty-lane events, so `WrongLane` is
            // unreachable; a closed lane is the only reachable failure. Treat
            // either defensively as a closed lane.
            LaneSendError::Closed(_) | LaneSendError::WrongLane { .. } => {
                PtyAdapterError::EventLaneClosed
            }
        })
    }
}

/// Emits exactly one payload-safe [`SessionEvent::PtyFailed`] for `error` when
/// the lane is still open, then returns the typed `error` so the worker stops.
/// A closed lane is surfaced as [`PtyAdapterError::EventLaneClosed`] without a
/// retry.
fn emit_failure<E: PtyEventSink>(
    events: &E,
    error: PtyAdapterError,
) -> Result<(), PtyAdapterError> {
    match events.emit(SessionEvent::PtyFailed(error.to_string())) {
        Ok(()) => Err(error),
        Err(lane_closed) => Err(lane_closed),
    }
}

// ---- durable child-control channel -------------------------------------

/// A synchronous child-termination request delivered to the child-owner
/// lifecycle loop over the durable child-control channel. The requester (the
/// FIFO command worker for a [`Effect::KillPty`]/cleanup, or an emergency
/// [`PtyControlHandle`]) blocks on `respond` for the kill outcome.
///
/// The loop — not the command worker — owns the receiver, so the child can be
/// terminated for as long as the loop runs, even after the command worker exits.
pub(crate) struct ChildControlRequest {
    /// When `true`, the requester is emitting its own terminal
    /// [`SessionEvent::PtyFailed`] (a write/kill/unexpected failure, or an
    /// emergency teardown), so the child-owner loop must converge without
    /// emitting any terminal event of its own.
    suppress_terminal: bool,
    /// One-shot reply carrying the kill outcome (payload-free error string).
    respond: std_mpsc::Sender<Result<(), String>>,
}

/// A cloneable, mutex-free handle to the durable child-control channel. Held by
/// the FIFO command worker and by [`PtyAdapterHandles`] (the supervisor's
/// emergency handle); the child-owner loop holds the receiver.
#[derive(Clone)]
pub(crate) struct PtyControlHandle {
    requests: std_mpsc::Sender<ChildControlRequest>,
}

/// Why a child-control request could not be satisfied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PtyControlError {
    /// The child-owner loop has ended (its receiver is gone): there is no child
    /// left to terminate. Explicit, not a panic, so a caller can distinguish
    /// "already gone" from a real kill failure.
    Closed,
    /// The child-owner loop executed the kill and it failed (payload-free cause).
    Kill(String),
}

impl fmt::Display for PtyControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PtyControlError::Closed => {
                write!(f, "pty child-owner loop has ended; no child to terminate")
            }
            PtyControlError::Kill(cause) => write!(f, "pty child termination failed: {cause}"),
        }
    }
}

impl std::error::Error for PtyControlError {}

impl PtyControlHandle {
    /// Sends a kill request to the child-owner loop and blocks the current
    /// thread for the result. `suppress_terminal` tells the loop to converge
    /// without emitting a terminal event (the caller emits its own). Returns
    /// [`PtyControlError::Closed`] if the loop has already ended.
    fn request_kill(&self, suppress_terminal: bool) -> Result<(), PtyControlError> {
        let (respond, reply) = std_mpsc::channel();
        self.requests
            .send(ChildControlRequest {
                suppress_terminal,
                respond,
            })
            .map_err(|_| PtyControlError::Closed)?;
        match reply.recv() {
            Ok(Ok(())) => Ok(()),
            Ok(Err(cause)) => Err(PtyControlError::Kill(cause)),
            // The loop dropped the reply without answering (it ended between the
            // send and the response): treat as closed rather than hang.
            Err(_) => Err(PtyControlError::Closed),
        }
    }

    /// Emergency, out-of-band child termination for the supervisor (Task 14).
    ///
    /// Synchronous and **off-runtime**: it blocks the calling thread for the kill
    /// result, so the supervisor must invoke it from a blocking context (e.g.
    /// [`tokio::task::spawn_blocking`] or a dedicated thread), never directly on
    /// a Tokio worker. Suppresses the child-owner loop's terminal event, since
    /// an emergency teardown is not a clean exit.
    ///
    /// Returns [`PtyControlError::Kill`] if the authoritative kill attempt itself
    /// failed — the child-owner loop stays alive and this remains **retryable**,
    /// so a later call can try again. It returns [`PtyControlError::Closed`] only
    /// once the lifecycle has actually ended (the child was reaped and the loop
    /// returned), after which there is no child left to terminate.
    pub(crate) fn terminate(&self) -> Result<(), PtyControlError> {
        self.request_kill(true)
    }

    /// Async convenience wrapper around [`terminate`](Self::terminate) that runs
    /// the blocking request on a [`spawn_blocking`] thread so it never blocks a
    /// Tokio worker. The join error is mapped to [`PtyControlError::Closed`].
    pub(crate) async fn terminate_async(&self) -> Result<(), PtyControlError> {
        let handle = self.clone();
        spawn_blocking(move || handle.terminate())
            .await
            .unwrap_or(Err(PtyControlError::Closed))
    }
}

/// Builds the durable child-control channel: a cloneable request sender (held by
/// the command worker and the supervisor's emergency handle) and the receiver
/// owned by the child-owner lifecycle loop.
fn child_control_channel() -> (PtyControlHandle, std_mpsc::Receiver<ChildControlRequest>) {
    let (requests, rx) = std_mpsc::channel();
    (PtyControlHandle { requests }, rx)
}

// ---- command target ----------------------------------------------------

/// The blocking command operations the FIFO worker performs against the PTY's
/// own I/O handles (writer + resizer). Kept behind a trait so tests can record
/// commands without a real PTY; production is [`RealPtyCommandTarget`], built
/// from the owned [`climon_pty::PtyParts`].
///
/// Note there is deliberately **no** `kill` here: the FIFO worker does not own
/// the child, and authoritative termination is requested from the child-owner
/// loop through the durable control channel — never the weaker cloned killer.
pub(crate) trait PtyCommandTarget: Send {
    /// The pty writer. The worker writes input to it and flushes; the writer's
    /// I/O errors are payload-free (they never contain the input bytes).
    fn writer(&mut self) -> &mut dyn Write;

    /// Applies a resize. Returns whether the size changed (clamp/dedupe is the
    /// resizer's job); `false` means unchanged and is **not** a failure.
    fn resize(&mut self, cols: u16, rows: u16) -> bool;
}

/// The production [`PtyCommandTarget`]: owns the taken writer and the `Weak`
/// resizer from [`climon_pty::PtyParts`]. The cloned killer is intentionally not
/// held — the FIFO worker kills through the child-owner loop.
struct RealPtyCommandTarget {
    writer: Box<dyn Write + Send>,
    resizer: PtyResizer,
}

impl PtyCommandTarget for RealPtyCommandTarget {
    fn writer(&mut self) -> &mut dyn Write {
        &mut *self.writer
    }

    fn resize(&mut self, cols: u16, rows: u16) -> bool {
        self.resizer.resize(cols, rows)
    }
}

// ---- command worker ----------------------------------------------------

/// Runs the FIFO command worker to completion: drain the pty command route in
/// FIFO order and execute each command serially. A write is `write_all`
/// followed by `flush`; a resize keeps the resizer's clamp/dedupe semantics (an
/// unchanged size is not a failure); a [`Effect::KillPty`] sends a *synchronous*
/// graceful kill request to the child-owner loop through `control` and waits for
/// the result before processing any later command (so the authoritative kill
/// stays serialized through this FIFO worker).
///
/// Failure handling, each emitting exactly one payload-safe
/// [`SessionEvent::PtyFailed`] (when the lane is open) and stopping the worker:
/// - **write/flush error** — request child termination through the durable
///   channel (best-effort: the cleanup result is ignored), then emit the *write*
///   failure. The child-owner loop is asked to suppress its own terminal event.
/// - **kill error** — the graceful request returned a kill error; emit the *kill*
///   failure. The child-owner loop converges without a second terminal event.
/// - **unexpected (non-pty) effect** — treated as loss/corruption of the command
///   executor (a core failure): request child termination, emit one failure, and
///   stop. No command I/O runs for the offending effect.
///
/// When the route closes, the worker drains what is already queued and returns
/// `Ok(())`. The whole loop runs on a blocking thread (via
/// [`spawn_pty_command_worker`]), so `blocking_recv`, the blocking writes, and
/// the synchronous kill request never occupy a Tokio worker.
fn run_pty_command_worker<E: PtyEventSink>(
    mut effects: mpsc::Receiver<Effect>,
    mut target: Box<dyn PtyCommandTarget>,
    control: PtyControlHandle,
    events: E,
) -> Result<(), PtyAdapterError> {
    while let Some(effect) = effects.blocking_recv() {
        let command = match PtyCommand::from_effect(effect) {
            Ok(command) => command,
            Err(error) => {
                // Loss/corruption of the command executor: request best-effort
                // child cleanup so the lifecycle converges, then emit one failure.
                let _ = control.request_kill(true);
                return emit_failure(&events, error);
            }
        };
        match command {
            PtyCommand::Input {
                operation_id,
                bytes,
            } => {
                let writer = target.writer();
                if let Err(error) = writer.write_all(&bytes).and_then(|()| writer.flush()) {
                    // Request child termination through the durable channel first
                    // (best-effort — its result is discarded), then always emit
                    // the WRITE failure, never a duplicate kill error.
                    let _ = control.request_kill(true);
                    return emit_failure(
                        &events,
                        PtyAdapterError::Write {
                            operation_id,
                            cause: error.to_string(),
                        },
                    );
                }
            }
            PtyCommand::Resize {
                operation_id: _,
                cols,
                rows,
            } => {
                // `false` (unchanged/clamped-away) is not a failure — preserve
                // the resizer's existing clamp/dedupe semantics.
                let _changed = target.resize(cols, rows);
            }
            PtyCommand::Kill { operation_id } => {
                // Serialized authoritative kill: request it from the child-owner
                // loop and block for the result before the next command.
                match control.request_kill(false) {
                    // Killed: the child-owner loop will emit `PtyExited`.
                    Ok(())
                    // Loop already ended (child already gone): the kill is moot.
                    | Err(PtyControlError::Closed) => {}
                    Err(PtyControlError::Kill(cause)) => {
                        return emit_failure(
                            &events,
                            PtyAdapterError::Kill {
                                operation_id,
                                cause,
                            },
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

/// Spawns [`run_pty_command_worker`] on a dedicated blocking thread and returns
/// its owned handle. No task is detached; the supervisor (Task 14) owns and
/// later joins the returned handle.
pub(crate) fn spawn_pty_command_worker<E: PtyEventSink>(
    effects: mpsc::Receiver<Effect>,
    target: Box<dyn PtyCommandTarget>,
    control: PtyControlHandle,
    events: E,
) -> JoinHandle<Result<(), PtyAdapterError>> {
    spawn_blocking(move || run_pty_command_worker(effects, target, control, events))
}

// ---- child owner -------------------------------------------------------

/// The non-blocking child-control surface the lifecycle loop drives. Kept behind
/// a trait so tests can script `try_wait`/`kill` without a real PTY; production
/// is [`RealPtyChildOwner`], wrapping the authoritative [`climon_pty::PtyWaiter`]
/// (its original-child `try_wait`/`kill`, not the weaker cloned killer).
pub(crate) trait PtyChildOwner: Send {
    /// Polls the child without blocking: `Ok(Some(code))` once exited,
    /// `Ok(None)` while running, `Err` on a wait failure. Payload-free error.
    fn try_wait(&mut self) -> Result<Option<i32>, String>;

    /// Authoritatively terminates the child (original handle: Unix escalation to
    /// `SIGKILL`; Windows `TerminateProcess` reported as `Ok`). Payload-free
    /// error.
    fn kill(&mut self) -> Result<(), String>;

    /// Drops the last strong PTY master so a Windows ConPTY cloned reader can
    /// EOF, while the child handle is retained for polling/killing. Idempotent.
    fn release_master(&mut self);
}

/// The production [`PtyChildOwner`]: wraps the owned [`climon_pty::PtyWaiter`],
/// whose non-blocking `try_wait`/`kill` use the original child handle and whose
/// `release_master` drops the last strong master.
struct RealPtyChildOwner {
    waiter: PtyWaiter,
}

impl PtyChildOwner for RealPtyChildOwner {
    fn try_wait(&mut self) -> Result<Option<i32>, String> {
        self.waiter.try_wait().map_err(|error| error.to_string())
    }

    fn kill(&mut self) -> Result<(), String> {
        self.waiter.kill().map_err(|error| error.to_string())
    }

    fn release_master(&mut self) {
        self.waiter.release_master();
    }
}

// ---- output / lifecycle bridge -----------------------------------------

/// The terminal outcome of the reader thread, delivered to the child-owner loop
/// over the reader status channel. The reader thread sends exactly one — a
/// panic is caught and reported as [`Panic`](ReadOutcome::Panic) — so the owner
/// loop learns *why* the reader ended from the channel and can react promptly,
/// then joins the (now finished) thread to reclaim it.
enum ReadOutcome {
    /// Clean EOF: every output chunk was read and enqueued.
    Eof,
    /// A `read` returned an error (payload-free cause).
    ReadError(String),
    /// The reader thread panicked (payload discarded).
    Panic,
    /// The event lane closed while output was still being emitted.
    LaneClosed,
}

/// Reads output chunks (up to [`PTY_READ_CHUNK`]) and emits each as
/// [`SessionEvent::PtyOutput`] with bounded backpressure, until EOF, a read
/// error, or a closed lane.
fn read_loop<E: PtyEventSink>(mut reader: Box<dyn Read + Send>, events: &E) -> ReadOutcome {
    let mut buf = [0u8; PTY_READ_CHUNK];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => return ReadOutcome::Eof,
            Ok(n) => {
                if events
                    .emit(SessionEvent::PtyOutput(buf[..n].to_vec()))
                    .is_err()
                {
                    return ReadOutcome::LaneClosed;
                }
            }
            Err(error) => return ReadOutcome::ReadError(error.to_string()),
        }
    }
}

/// Spawns the single reader thread. It reads output until it finishes, then
/// sends its one terminal [`ReadOutcome`] on `status`; a `catch_unwind` around
/// the read loop converts a panic into [`ReadOutcome::Panic`], so the thread
/// always reports an outcome and never re-panics.
///
/// The returned handle is owned by [`run_pty_lifecycle`], which **always** joins
/// it before returning — the reader is never detached. The lifecycle only
/// returns once it has observed the reader's outcome (directly, or after
/// releasing the master so a gated reader can EOF), so that join is bounded; if
/// the reader genuinely cannot finish, the lifecycle retains ownership (stays
/// alive) rather than dropping the handle.
fn spawn_reader<E: PtyEventSink>(
    reader: Box<dyn Read + Send>,
    events: E,
    status: std_mpsc::Sender<ReadOutcome>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read_loop(reader, &events)))
                .unwrap_or(ReadOutcome::Panic);
        let _ = status.send(outcome);
    })
}

/// The reader's terminal outcome as observed on the clean-exit path, where it
/// still decides between a clean `PtyExited` and a late reader failure that
/// supersedes the exit.
enum ReaderEnd {
    Eof,
    ReadError(String),
    Panic,
    LaneClosed,
}

/// Runs the child-owner lifecycle loop to completion and returns the result the
/// lifecycle propagates.
///
/// The loop emits the single terminal event **itself** — a reader failure is
/// emitted promptly so it is delivered even if the child lingers; a clean exit is
/// emitted only after the reader has drained — so [`run_pty_lifecycle`]'s caller
/// emits nothing.
///
/// It concurrently owns the authoritative `child`, the reader thread's outcome
/// `status_rx`, and the durable `control_rx` kill-request channel, and drives
/// them in a responsive poll loop (parking at most [`CHILD_POLL_INTERVAL`] on
/// `control_rx`). Every convergence keeps the child owned until it is *reaped*
/// and the reader driven to an outcome, so the reader thread is always joinable
/// (never detached) before the lifecycle returns:
///
/// - a **reader error/panic** is observed promptly: the reader has already
///   ended, so its failure is emitted at once, an authoritative kill is
///   requested, and the loop keeps owning/polling the child until it exits (or a
///   later emergency kill reaps it). A failed kill does **not** end the loop — it
///   stays alive and retryable. Prior output precedes the failure.
/// - a **child exit** releases the master (so a Windows reader can EOF), drains
///   and joins the reader so every output precedes it, then emits `PtyExited` —
///   unless the reader turns out to have failed, which takes precedence.
/// - a **kill request** executes the authoritative child kill and replies. A
///   successful graceful (non-suppressing) kill keeps the loop running until the
///   resulting exit becomes `PtyExited`; a suppressing request marks the terminal
///   event as owned by the requester and the loop converges silently once the
///   child exits. A *failed* kill likewise cedes the terminal event but keeps the
///   loop **alive and retryable** rather than returning, so the child's natural
///   exit or a later emergency kill can still reap it.
/// - a **closed lane** (reported by the reader) reaps the child, then returns
///   `EventLaneClosed` without emitting.
/// - a **wait error** emits one failure, best-effort kills, releases the master
///   to unblock the reader, drives it to an outcome and joins it, then returns;
///   the now-unusable child may be dropped after the kill attempt.
fn run_pty_lifecycle<E: PtyEventSink>(
    reader: Box<dyn Read + Send>,
    mut child: Box<dyn PtyChildOwner>,
    control_rx: std_mpsc::Receiver<ChildControlRequest>,
    events: E,
) -> Result<(), PtyAdapterError> {
    let (status_tx, status_rx) = std_mpsc::channel::<ReadOutcome>();
    let reader_thread = spawn_reader(reader, events.clone(), status_tx);

    let result = child_owner_loop(child.as_mut(), &status_rx, &control_rx, &events);

    // The single, unconditional ownership path: join the reader before returning.
    // The loop only returns once it has observed the reader's outcome (directly,
    // or after releasing the master so a gated reader can EOF), so this join is
    // bounded and the reader thread is never detached.
    let _ = reader_thread.join();
    result
}

/// The responsive poll loop. See [`run_pty_lifecycle`] for the convergence rules.
/// Emits the single terminal event and returns the value the lifecycle
/// propagates; it only returns once the reader has reported (so its thread is
/// joinable) or, if the reader truly cannot finish, it retains ownership by
/// blocking rather than detaching.
fn child_owner_loop<E: PtyEventSink>(
    child: &mut dyn PtyChildOwner,
    status_rx: &std_mpsc::Receiver<ReadOutcome>,
    control_rx: &std_mpsc::Receiver<ChildControlRequest>,
    events: &E,
) -> Result<(), PtyAdapterError> {
    let mut reader_eof = false;
    let mut reader_done = false;
    // Once a failure or suppression owns the terminal result, this holds the value
    // the lifecycle returns; the loop then only reaps the child and joins the
    // reader before returning it. `None` means no terminal decision yet, so a
    // clean child exit becomes `PtyExited`.
    let mut decided: Option<Result<(), PtyAdapterError>> = None;

    loop {
        // 1. Reader outcome. The reader has emitted all its output before ending,
        //    so a reader failure is emitted *promptly* (delivered even if the
        //    child later lingers unkillable); the loop then reaps the child.
        if !reader_done {
            match status_rx.try_recv() {
                Ok(ReadOutcome::Eof) => {
                    reader_eof = true;
                    reader_done = true;
                }
                Ok(ReadOutcome::ReadError(cause)) => {
                    reader_done = true;
                    if decided.is_none() {
                        decided = Some(emit_failure(events, PtyAdapterError::Read { cause }));
                    }
                    let _ = child.kill();
                }
                Ok(ReadOutcome::Panic) => {
                    reader_done = true;
                    if decided.is_none() {
                        decided = Some(emit_failure(events, PtyAdapterError::ReaderPanic));
                    }
                    let _ = child.kill();
                }
                Ok(ReadOutcome::LaneClosed) => {
                    reader_done = true;
                    if decided.is_none() {
                        decided = Some(Err(PtyAdapterError::EventLaneClosed));
                    }
                    let _ = child.kill();
                }
                Err(std_mpsc::TryRecvError::Empty) => {}
                Err(std_mpsc::TryRecvError::Disconnected) => {
                    // The reader thread ended without sending an outcome (only
                    // reachable if it never got to send one). Defensive: treat as
                    // a panic rather than spin.
                    reader_done = true;
                    if decided.is_none() {
                        decided = Some(emit_failure(events, PtyAdapterError::ReaderPanic));
                        let _ = child.kill();
                    }
                }
            }
        }

        // 2. Child exit? A reaped child is the convergence point for every path:
        //    release the master (so a gated reader can EOF), then drain and join
        //    the reader before returning.
        match child.try_wait() {
            Ok(Some(code)) => {
                child.release_master();
                return converge_on_exit(status_rx, events, reader_eof, reader_done, decided, code);
            }
            Ok(None) => {}
            Err(cause) => {
                // `try_wait` itself is unusable, so the child can no longer be
                // reaped through it. Emit one failure (unless already decided),
                // best-effort kill, release the master to unblock the reader, then
                // drive the reader to an outcome and join it. Dropping the now
                // unusable child after this kill attempt is acceptable.
                let verdict = decided
                    .unwrap_or_else(|| emit_failure(events, PtyAdapterError::Wait { cause }));
                let _ = child.kill();
                child.release_master();
                await_reader_done(status_rx, reader_done);
                return verdict;
            }
        }

        // 3. Kill request — the loop's responsive park. A request wakes it
        //    immediately; the timeout only bounds child/reader re-polls.
        match control_rx.recv_timeout(CHILD_POLL_INTERVAL) {
            Ok(request) => {
                let result = child.kill();
                let _ = request.respond.send(result.clone());
                if (request.suppress_terminal || result.is_err()) && decided.is_none() {
                    // The requester owns the single terminal event, so the loop
                    // converges silently. Crucially a *failed* kill does not
                    // return here: the loop stays alive and retryable, so the
                    // child's natural exit or a later emergency kill can still
                    // reap it. A successful graceful (non-suppressing) kill leaves
                    // `decided` as `None`, so the resulting exit becomes
                    // `PtyExited` with output ordered ahead of it.
                    decided = Some(Ok(()));
                }
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => {}
            Err(std_mpsc::RecvTimeoutError::Disconnected) => {
                // No control senders remain (the command worker exited and no
                // emergency handle is held). Keep polling the child/reader, but
                // sleep so the disconnected channel doesn't busy-spin.
                std::thread::sleep(CHILD_POLL_INTERVAL);
            }
        }
    }
}

/// Converges after the child has been reaped: ensures the reader has reported (so
/// the caller's join is bounded), then returns the terminal result. If a failure
/// or suppression already owns the terminal, the reader is only drained; without
/// one, the reader's own outcome decides between a clean `PtyExited(code)` and a
/// late reader failure that supersedes the exit.
fn converge_on_exit<E: PtyEventSink>(
    status_rx: &std_mpsc::Receiver<ReadOutcome>,
    events: &E,
    reader_eof: bool,
    reader_done: bool,
    decided: Option<Result<(), PtyAdapterError>>,
    code: i32,
) -> Result<(), PtyAdapterError> {
    if let Some(verdict) = decided {
        await_reader_done(status_rx, reader_done);
        return verdict;
    }
    match await_reader_outcome(status_rx, reader_eof, reader_done) {
        ReaderEnd::Eof => events.emit(SessionEvent::PtyExited(code)),
        ReaderEnd::ReadError(cause) => emit_failure(events, PtyAdapterError::Read { cause }),
        ReaderEnd::Panic => emit_failure(events, PtyAdapterError::ReaderPanic),
        ReaderEnd::LaneClosed => Err(PtyAdapterError::EventLaneClosed),
    }
}

/// Waits for the reader's single outcome on the clean-exit path, where it still
/// decides between a clean exit and a late reader failure. The master was
/// released, so a gated reader will EOF and this is bounded; if the reader truly
/// cannot finish, ownership is retained here (the loop blocks) rather than
/// detaching.
fn await_reader_outcome(
    status_rx: &std_mpsc::Receiver<ReadOutcome>,
    reader_eof: bool,
    reader_done: bool,
) -> ReaderEnd {
    if reader_eof || reader_done {
        // A clean EOF (or, defensively, any already-consumed outcome that did not
        // set `decided`) means the reader has finished cleanly.
        return ReaderEnd::Eof;
    }
    match status_rx.recv() {
        Ok(ReadOutcome::Eof) => ReaderEnd::Eof,
        Ok(ReadOutcome::ReadError(cause)) => ReaderEnd::ReadError(cause),
        Ok(ReadOutcome::Panic) => ReaderEnd::Panic,
        Ok(ReadOutcome::LaneClosed) => ReaderEnd::LaneClosed,
        // The reader ended without an outcome; the child genuinely exited, so
        // report the clean exit.
        Err(_) => ReaderEnd::Eof,
    }
}

/// Blocks until the reader has reported, so its thread is joinable, when the
/// terminal result is already decided. The master has been released, so a gated
/// reader will EOF and this is bounded; if the reader truly cannot finish it
/// retains ownership here (blocks) rather than detaching.
fn await_reader_done(status_rx: &std_mpsc::Receiver<ReadOutcome>, reader_done: bool) {
    if !reader_done {
        let _ = status_rx.recv();
    }
}

/// Spawns [`run_pty_lifecycle`] on a dedicated blocking thread and returns its
/// owned handle. The reader thread it starts reports its outcome over a channel
/// and is **always** joined before the lifecycle returns — it is never detached.
/// If a child cannot be reaped and its reader cannot finish, the lifecycle
/// retains ownership (stays alive/retryable) rather than dropping the handle.
pub(crate) fn spawn_pty_lifecycle<E: PtyEventSink>(
    reader: Box<dyn Read + Send>,
    child: Box<dyn PtyChildOwner>,
    control_rx: std_mpsc::Receiver<ChildControlRequest>,
    events: E,
) -> JoinHandle<Result<(), PtyAdapterError>> {
    spawn_blocking(move || run_pty_lifecycle(reader, child, control_rx, events))
}

// ---- adapter assembly --------------------------------------------------

/// The owned handles the pty adapter produces. The supervisor (Task 14) owns and
/// later joins the two workers; neither is detached.
pub(crate) struct PtyAdapterHandles {
    /// The child process id, if known — exposed so the supervisor can identify
    /// the child (e.g. for logging) without reaching into the moved parts.
    pub(crate) pid: Option<u32>,
    /// The FIFO command worker (writer + resizer; kills via the control channel).
    pub(crate) command: JoinHandle<Result<(), PtyAdapterError>>,
    /// The child-owner lifecycle loop (reader + authoritative child + master).
    pub(crate) lifecycle: JoinHandle<Result<(), PtyAdapterError>>,
    /// A cloneable emergency child-control handle to the same durable channel.
    ///
    /// It survives the command worker's exit: the child-owner loop owns the
    /// receiver, so the supervisor can [`terminate`](PtyControlHandle::terminate)
    /// the child even after the command worker has stopped or its route has
    /// closed. It owns no PTY resource handle and no mutex. `terminate` is
    /// synchronous/off-runtime — call it from a blocking context (or use
    /// [`terminate_async`](PtyControlHandle::terminate_async)) so it never blocks
    /// a Tokio worker.
    pub(crate) control: PtyControlHandle,
}

/// Assembles the pty adapter from the owned [`climon_pty::PtyParts`]: the command
/// worker takes the writer/resizer and drains `effects`; the child-owner
/// lifecycle loop takes the reader and the authoritative waiter. Both emit
/// through the pty `events` lane, and both share a durable child-control channel
/// (a clone of which is retained on the returned handles as the supervisor's
/// emergency control). Returns the owned handles.
///
/// The cloned best-effort [`climon_pty::PtyKiller`] from `PtyParts` is
/// intentionally dropped: production authoritative termination is the waiter's
/// original-child kill, requested through the control channel — never the weaker
/// cloned killer.
pub(crate) fn spawn_pty_adapter(
    parts: climon_pty::PtyParts,
    effects: mpsc::Receiver<Effect>,
    events: PtyEventSender,
) -> PtyAdapterHandles {
    let climon_pty::PtyParts {
        reader,
        writer,
        resizer,
        waiter,
        killer: _authoritative_kill_uses_the_waiter_not_this,
        pid,
    } = parts;

    let (control, control_rx) = child_control_channel();

    let command_target: Box<dyn PtyCommandTarget> =
        Box::new(RealPtyCommandTarget { writer, resizer });
    let child_owner: Box<dyn PtyChildOwner> = Box::new(RealPtyChildOwner { waiter });

    let command =
        spawn_pty_command_worker(effects, command_target, control.clone(), events.clone());
    let lifecycle = spawn_pty_lifecycle(reader, child_owner, control_rx, events);
    PtyAdapterHandles {
        pid,
        command,
        lifecycle,
        control,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc as std_mpsc;
    use std::sync::{Arc, Condvar, Mutex};

    use tokio::sync::mpsc;

    use super::{
        child_control_channel, spawn_pty_command_worker, spawn_pty_lifecycle, ChildControlRequest,
        PtyAdapterError, PtyChildOwner, PtyCommandTarget, PtyControlError, PtyControlHandle,
        PtyEventSink,
    };
    use crate::engine::coordinator::event_lanes;
    use crate::engine::effect::{Effect, OperationId};
    use crate::engine::event::{EventKind, SessionEvent};
    use crate::engine::PTY_COMMAND_CAPACITY;

    /// Bounded anti-hang net for the integrated tests. It is a *safety* net only:
    /// every test drives completion through channels/gates, and no assertion
    /// depends on wall-clock timing. A correct implementation finishes well
    /// within it; a regression that hangs trips it deterministically.
    const ANTI_HANG: std::time::Duration = std::time::Duration::from_secs(5);

    // ---- shared recorder -------------------------------------------------

    /// An ordered log of the operations the fakes observe, shared between the
    /// fake writer (write/flush), the fake command target (resize), and the fake
    /// child owner (kill) so a single FIFO sequence is asserted across them.
    #[derive(Clone, Default)]
    struct CommandLog {
        ops: Arc<Mutex<Vec<String>>>,
    }

    impl CommandLog {
        fn push(&self, op: impl Into<String>) {
            self.ops.lock().expect("log poisoned").push(op.into());
        }

        fn ops(&self) -> Vec<String> {
            self.ops.lock().expect("log poisoned").clone()
        }
    }

    /// A permit-based gate: a worker parks in [`Gate::wait`] until a test (or the
    /// child owner's `release_master`) calls [`Gate::release`], proving the parked
    /// call runs off the Tokio workers.
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

    // ---- fake command target --------------------------------------------

    /// A recording [`Write`] standing in for the pty writer. It logs every write
    /// as `input:<bytes>` and every flush as `flush`, and can gate/signal/fail to
    /// drive the timing and failure tests. The recorded `input:<bytes>` form
    /// exists only in this test recorder; the production adapter never renders
    /// input bytes into any string.
    struct FakeWriter {
        log: CommandLog,
        started: Option<mpsc::UnboundedSender<()>>,
        gate: Option<Arc<Gate>>,
        write_error: Option<String>,
        flush_error: Option<String>,
    }

    impl Write for FakeWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.log
                .push(format!("input:{}", String::from_utf8_lossy(buf)));
            if let Some(started) = &self.started {
                let _ = started.send(());
            }
            if let Some(gate) = &self.gate {
                gate.wait();
            }
            if let Some(message) = &self.write_error {
                return Err(std::io::Error::other(message.clone()));
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.log.push("flush");
            if let Some(message) = &self.flush_error {
                return Err(std::io::Error::other(message.clone()));
            }
            Ok(())
        }
    }

    /// A fake [`PtyCommandTarget`] recording resize into the shared log. It owns
    /// no child and cannot kill — that is the child owner's job, requested via the
    /// control channel — mirroring the production command target.
    struct FakeCommandTarget {
        log: CommandLog,
        writer: FakeWriter,
        resize_returns: bool,
    }

    #[derive(Default)]
    struct FakeCommandTargetBuilder {
        started: Option<mpsc::UnboundedSender<()>>,
        gate: Option<Arc<Gate>>,
        write_error: Option<String>,
        flush_error: Option<String>,
        resize_returns: bool,
    }

    impl FakeCommandTargetBuilder {
        fn started(mut self, tx: mpsc::UnboundedSender<()>) -> Self {
            self.started = Some(tx);
            self
        }

        fn gate(mut self, gate: Arc<Gate>) -> Self {
            self.gate = Some(gate);
            self
        }

        fn write_error(mut self, message: &str) -> Self {
            self.write_error = Some(message.to_string());
            self
        }

        fn flush_error(mut self, message: &str) -> Self {
            self.flush_error = Some(message.to_string());
            self
        }

        fn build(self) -> FakeCommandTarget {
            let log = CommandLog::default();
            FakeCommandTarget {
                writer: FakeWriter {
                    log: log.clone(),
                    started: self.started,
                    gate: self.gate,
                    write_error: self.write_error,
                    flush_error: self.flush_error,
                },
                log,
                resize_returns: self.resize_returns,
            }
        }

        fn build_with_log(self, log: CommandLog) -> FakeCommandTarget {
            FakeCommandTarget {
                writer: FakeWriter {
                    log: log.clone(),
                    started: self.started,
                    gate: self.gate,
                    write_error: self.write_error,
                    flush_error: self.flush_error,
                },
                log,
                resize_returns: self.resize_returns,
            }
        }
    }

    impl FakeCommandTarget {
        fn builder() -> FakeCommandTargetBuilder {
            FakeCommandTargetBuilder {
                resize_returns: true,
                ..Default::default()
            }
        }

        fn log(&self) -> CommandLog {
            self.log.clone()
        }
    }

    impl PtyCommandTarget for FakeCommandTarget {
        fn writer(&mut self) -> &mut dyn Write {
            &mut self.writer
        }

        fn resize(&mut self, cols: u16, rows: u16) -> bool {
            self.log.push(format!("resize:{cols}x{rows}"));
            self.resize_returns
        }
    }

    // ---- fake child owner ------------------------------------------------

    /// How the [`FakeChildOwner`]'s `try_wait` should report the child.
    #[derive(Clone)]
    enum TryWaitMode {
        /// Never exits, even when killed (models a child the kill cannot reap, so
        /// the loop must stay alive and retryable rather than detach).
        NeverExits,
        /// Already exited with this code (a clean exit).
        CleanExit(i32),
        /// Exits with this code once any [`PtyChildOwner::kill`] has run,
        /// regardless of the kill's reported result.
        ExitAfterKill(i32),
        /// Exits with this code only once a [`PtyChildOwner::kill`] has returned
        /// `Ok` — a failed kill leaves the child running, so a later retry is
        /// required to reap it.
        ExitAfterSuccessfulKill(i32),
        /// `try_wait` itself fails with this cause (a wait error).
        WaitError(String),
    }

    /// The shared, inspectable state behind a [`FakeChildOwner`], so a test can
    /// read the kill count / release flag from the same state the lifecycle drives.
    struct FakeChildState {
        log: CommandLog,
        mode: TryWaitMode,
        /// The result returned once the scripted `kill_results` queue is drained.
        kill_result: Result<(), String>,
        /// A scripted sequence of kill outcomes, popped one per `kill`; once
        /// empty, `kill_result` is used. Lets a test model a first kill that fails
        /// and a later retry that succeeds.
        kill_results: Mutex<VecDeque<Result<(), String>>>,
        kill_gate: Option<Arc<Gate>>,
        kill_reached: Mutex<Option<mpsc::UnboundedSender<()>>>,
        killed: AtomicBool,
        /// Set once a `kill` has returned `Ok`, driving
        /// [`TryWaitMode::ExitAfterSuccessfulKill`].
        killed_successfully: AtomicBool,
        kill_count: AtomicUsize,
        try_wait_some: Mutex<Option<mpsc::UnboundedSender<()>>>,
        release_gate: Option<Arc<Gate>>,
        released: AtomicBool,
    }

    impl FakeChildState {
        fn kill_count(&self) -> usize {
            self.kill_count.load(Ordering::SeqCst)
        }

        fn released(&self) -> bool {
            self.released.load(Ordering::SeqCst)
        }
    }

    /// A fake [`PtyChildOwner`] driven by shared [`FakeChildState`]. `try_wait`,
    /// `kill`, and `release_master` are scripted; `release_master` optionally
    /// releases a reader gate (the master-drop analogue that lets a Windows-like
    /// gated reader EOF).
    struct FakeChildOwner {
        state: Arc<FakeChildState>,
    }

    #[derive(Default)]
    struct FakeChildOwnerBuilder {
        log: Option<CommandLog>,
        mode: Option<TryWaitMode>,
        kill_result: Option<Result<(), String>>,
        kill_results: Option<VecDeque<Result<(), String>>>,
        kill_gate: Option<Arc<Gate>>,
        kill_reached: Option<mpsc::UnboundedSender<()>>,
        try_wait_some: Option<mpsc::UnboundedSender<()>>,
        release_gate: Option<Arc<Gate>>,
    }

    impl FakeChildOwnerBuilder {
        fn mode(mut self, mode: TryWaitMode) -> Self {
            self.mode = Some(mode);
            self
        }

        fn log(mut self, log: CommandLog) -> Self {
            self.log = Some(log);
            self
        }

        fn kill_error(mut self, message: &str) -> Self {
            self.kill_result = Some(Err(message.to_string()));
            self
        }

        /// Scripts a sequence of kill outcomes, one popped per `kill`; after the
        /// sequence drains the default `kill_result` (Ok) is used.
        fn kill_results(mut self, results: Vec<Result<(), String>>) -> Self {
            self.kill_results = Some(results.into_iter().collect());
            self
        }

        fn kill_gate(mut self, gate: Arc<Gate>) -> Self {
            self.kill_gate = Some(gate);
            self
        }

        fn kill_reached(mut self, tx: mpsc::UnboundedSender<()>) -> Self {
            self.kill_reached = Some(tx);
            self
        }

        fn try_wait_some(mut self, tx: mpsc::UnboundedSender<()>) -> Self {
            self.try_wait_some = Some(tx);
            self
        }

        fn release_gate(mut self, gate: Arc<Gate>) -> Self {
            self.release_gate = Some(gate);
            self
        }

        fn build(self) -> (FakeChildOwner, Arc<FakeChildState>) {
            let state = Arc::new(FakeChildState {
                log: self.log.unwrap_or_default(),
                mode: self.mode.unwrap_or(TryWaitMode::NeverExits),
                kill_result: self.kill_result.unwrap_or(Ok(())),
                kill_results: Mutex::new(self.kill_results.unwrap_or_default()),
                kill_gate: self.kill_gate,
                kill_reached: Mutex::new(self.kill_reached),
                killed: AtomicBool::new(false),
                killed_successfully: AtomicBool::new(false),
                kill_count: AtomicUsize::new(0),
                try_wait_some: Mutex::new(self.try_wait_some),
                release_gate: self.release_gate,
                released: AtomicBool::new(false),
            });
            (
                FakeChildOwner {
                    state: Arc::clone(&state),
                },
                state,
            )
        }
    }

    impl FakeChildOwner {
        fn builder() -> FakeChildOwnerBuilder {
            FakeChildOwnerBuilder::default()
        }
    }

    impl PtyChildOwner for FakeChildOwner {
        fn try_wait(&mut self) -> Result<Option<i32>, String> {
            let code = match &self.state.mode {
                TryWaitMode::NeverExits => None,
                TryWaitMode::CleanExit(code) => Some(*code),
                TryWaitMode::ExitAfterKill(code) => {
                    if self.state.killed.load(Ordering::SeqCst) {
                        Some(*code)
                    } else {
                        None
                    }
                }
                TryWaitMode::ExitAfterSuccessfulKill(code) => {
                    if self.state.killed_successfully.load(Ordering::SeqCst) {
                        Some(*code)
                    } else {
                        None
                    }
                }
                TryWaitMode::WaitError(cause) => return Err(cause.clone()),
            };
            if code.is_some() {
                if let Some(tx) = self.state.try_wait_some.lock().expect("poison").take() {
                    let _ = tx.send(());
                }
            }
            Ok(code)
        }

        fn kill(&mut self) -> Result<(), String> {
            self.state.log.push("kill");
            self.state.kill_count.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = self.state.kill_reached.lock().expect("poison").take() {
                let _ = tx.send(());
            }
            if let Some(gate) = &self.state.kill_gate {
                gate.wait();
            }
            self.state.killed.store(true, Ordering::SeqCst);
            let result = self
                .state
                .kill_results
                .lock()
                .expect("poison")
                .pop_front()
                .unwrap_or_else(|| self.state.kill_result.clone());
            if result.is_ok() {
                self.state.killed_successfully.store(true, Ordering::SeqCst);
            }
            result
        }

        fn release_master(&mut self) {
            self.state.released.store(true, Ordering::SeqCst);
            if let Some(gate) = &self.state.release_gate {
                gate.release();
            }
        }
    }

    // ---- recording event sink -------------------------------------------

    /// A [`PtyEventSink`] recording every emitted event; `closed` simulates a
    /// closed pty event lane.
    #[derive(Clone)]
    struct RecordingSink {
        events: Arc<Mutex<Vec<SessionEvent>>>,
        closed: Arc<AtomicBool>,
    }

    impl RecordingSink {
        fn new() -> RecordingSink {
            RecordingSink {
                events: Arc::new(Mutex::new(Vec::new())),
                closed: Arc::new(AtomicBool::new(false)),
            }
        }

        fn closed() -> RecordingSink {
            let sink = RecordingSink::new();
            sink.closed.store(true, Ordering::SeqCst);
            sink
        }

        fn kinds(&self) -> Vec<EventKind> {
            self.events
                .lock()
                .expect("events poisoned")
                .iter()
                .map(SessionEvent::kind)
                .collect()
        }

        fn outputs(&self) -> Vec<Vec<u8>> {
            self.events
                .lock()
                .expect("events poisoned")
                .iter()
                .filter_map(|event| match event {
                    SessionEvent::PtyOutput(bytes) => Some(bytes.clone()),
                    _ => None,
                })
                .collect()
        }

        fn exit_codes(&self) -> Vec<i32> {
            self.events
                .lock()
                .expect("events poisoned")
                .iter()
                .filter_map(|event| match event {
                    SessionEvent::PtyExited(code) => Some(*code),
                    _ => None,
                })
                .collect()
        }

        fn failures(&self) -> Vec<String> {
            self.events
                .lock()
                .expect("events poisoned")
                .iter()
                .filter_map(|event| match event {
                    SessionEvent::PtyFailed(message) => Some(message.clone()),
                    _ => None,
                })
                .collect()
        }
    }

    impl PtyEventSink for RecordingSink {
        fn emit(&self, event: SessionEvent) -> Result<(), PtyAdapterError> {
            if self.closed.load(Ordering::SeqCst) {
                return Err(PtyAdapterError::EventLaneClosed);
            }
            self.events.lock().expect("events poisoned").push(event);
            Ok(())
        }
    }

    // ---- fake reader -----------------------------------------------------

    /// A test-only sentinel proving the lifecycle never returns before the reader
    /// thread has finished. It is moved into the [`FakeReader`], so it drops (and
    /// flips `finished` to `true`) exactly when the reader thread's `read_loop`
    /// ends — which the production lifecycle must join before it returns. If a
    /// path detached the reader, the lifecycle could return with `finished` still
    /// `false`, which every sentinel test forbids.
    #[derive(Clone)]
    struct ReaderSentinel {
        finished: Arc<AtomicBool>,
    }

    impl ReaderSentinel {
        fn new() -> ReaderSentinel {
            ReaderSentinel {
                finished: Arc::new(AtomicBool::new(false)),
            }
        }

        /// Whether the reader thread has run to completion (its `read_loop`
        /// returned and the guard dropped).
        fn finished(&self) -> bool {
            self.finished.load(Ordering::SeqCst)
        }
    }

    impl Drop for ReaderSentinel {
        fn drop(&mut self) {
            self.finished.store(true, Ordering::SeqCst);
        }
    }

    /// A scripted step the [`FakeReader`] plays out. `Chunk` returns bytes from a
    /// `read`; `Signal` fires a channel (without returning) so a test can observe
    /// that all prior chunks have been emitted; `Gate` parks the read until
    /// released (modelling a Windows reader that only EOFs once the master
    /// drops); `Error` fails the read; `Panic` panics the reader thread. An
    /// exhausted script returns EOF.
    enum ReadStep {
        Chunk(Vec<u8>),
        Signal(mpsc::UnboundedSender<()>),
        Gate(Arc<Gate>),
        Error(String),
        Panic,
    }

    /// A fake [`Read`] that plays out a scripted sequence of steps.
    struct FakeReader {
        steps: VecDeque<ReadStep>,
        /// Dropped when the reader thread's `read_loop` ends, flipping the shared
        /// sentinel flag. `None` when a test does not observe reader completion.
        _sentinel: Option<ReaderSentinel>,
    }

    impl FakeReader {
        fn new(steps: impl IntoIterator<Item = ReadStep>) -> FakeReader {
            FakeReader {
                steps: steps.into_iter().collect(),
                _sentinel: None,
            }
        }

        /// Attaches a completion sentinel so a test can prove the reader thread
        /// finished before the lifecycle returned (i.e. it was joined, not
        /// detached).
        fn with_sentinel(mut self, sentinel: ReaderSentinel) -> FakeReader {
            self._sentinel = Some(sentinel);
            self
        }

        /// A reader that immediately EOFs (no output), for tests whose focus is
        /// the command/child-control path rather than output streaming.
        fn eof() -> FakeReader {
            FakeReader::new([])
        }
    }

    impl Read for FakeReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            loop {
                match self.steps.pop_front() {
                    None => return Ok(0),
                    Some(ReadStep::Chunk(data)) => {
                        let n = data.len().min(buf.len());
                        buf[..n].copy_from_slice(&data[..n]);
                        return Ok(n);
                    }
                    Some(ReadStep::Signal(tx)) => {
                        let _ = tx.send(());
                    }
                    Some(ReadStep::Gate(gate)) => gate.wait(),
                    Some(ReadStep::Error(message)) => {
                        return Err(std::io::Error::other(message));
                    }
                    Some(ReadStep::Panic) => panic!("fake reader panic"),
                }
            }
        }
    }

    // ---- control responder (command-worker-focused tests) ----------------

    /// Drains the durable child-control channel on a plain thread, recording each
    /// kill request into the shared log and replying with `result`. Lets the
    /// command-worker-focused tests exercise the real control round-trip without
    /// standing up a full lifecycle loop.
    fn spawn_control_responder(
        rx: std_mpsc::Receiver<ChildControlRequest>,
        log: CommandLog,
        result: Result<(), String>,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            while let Ok(request) = rx.recv() {
                log.push("kill");
                let _ = request.respond.send(result.clone());
            }
        })
    }

    // ---- command-worker-focused tests ------------------------------------

    /// The FIFO command worker executes write, resize, write, and kill in the
    /// exact order queued, flushing after every input, through the real command
    /// loop. The kill is routed to the child-owner (here a control responder),
    /// not a target method, and lands in FIFO position.
    #[tokio::test]
    async fn pty_commands_execute_in_fifo_with_flush_after_each_input() {
        let log = CommandLog::default();
        let target = FakeCommandTarget::builder().build_with_log(log.clone());
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        let responder = spawn_control_responder(control_rx, log.clone(), Ok(()));
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let handle = spawn_pty_command_worker(rx, Box::new(target), control.clone(), sink.clone());

        tx.send(Effect::WritePty {
            operation_id: OperationId(1),
            bytes: b"a".to_vec(),
        })
        .await
        .unwrap();
        tx.send(Effect::ResizePty {
            operation_id: OperationId(2),
            cols: 100,
            rows: 30,
        })
        .await
        .unwrap();
        tx.send(Effect::WritePty {
            operation_id: OperationId(3),
            bytes: b"b".to_vec(),
        })
        .await
        .unwrap();
        tx.send(Effect::KillPty {
            operation_id: OperationId(4),
        })
        .await
        .unwrap();
        drop(tx);

        handle.await.unwrap().unwrap();
        drop(control);
        responder.join().unwrap();

        assert_eq!(
            log.ops(),
            vec![
                "input:a".to_string(),
                "flush".to_string(),
                "resize:100x30".to_string(),
                "input:b".to_string(),
                "flush".to_string(),
                "kill".to_string(),
            ]
        );
        assert!(sink.kinds().is_empty(), "no pty event on the success path");
    }

    /// Dropping the effect sender must not abandon queued commands: the worker
    /// drains every buffered command in order, then exits `Ok`.
    #[tokio::test]
    async fn dropping_sender_drains_queued_then_exits_ok() {
        let target = FakeCommandTarget::builder().build();
        let log = target.log();
        let sink = RecordingSink::new();
        let (control, _control_rx) = child_control_channel();
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);

        tx.send(Effect::WritePty {
            operation_id: OperationId(1),
            bytes: b"a".to_vec(),
        })
        .await
        .unwrap();
        tx.send(Effect::ResizePty {
            operation_id: OperationId(2),
            cols: 80,
            rows: 24,
        })
        .await
        .unwrap();
        drop(tx);

        let handle = spawn_pty_command_worker(rx, Box::new(target), control, sink.clone());

        assert_eq!(handle.await.unwrap(), Ok(()));
        assert_eq!(
            log.ops(),
            vec![
                "input:a".to_string(),
                "flush".to_string(),
                "resize:80x24".to_string(),
            ]
        );
        assert!(sink.kinds().is_empty());
    }

    /// A blocking command (a parked write) must not occupy a Tokio worker: while
    /// the write is gated on a blocking thread, a spawned task must still run to
    /// completion on the single-threaded test runtime. No wall-clock sleep is
    /// used — a permit gate holds the write, and a bounded timeout is only the
    /// anti-hang net.
    #[tokio::test]
    async fn blocking_command_does_not_block_tokio_runtime() {
        let gate = Gate::new();
        let (started_tx, mut started_rx) = mpsc::unbounded_channel();
        let target = FakeCommandTarget::builder()
            .started(started_tx)
            .gate(Arc::clone(&gate))
            .build();
        let sink = RecordingSink::new();
        let (control, _control_rx) = child_control_channel();
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let handle = spawn_pty_command_worker(rx, Box::new(target), control, sink);

        tx.send(Effect::WritePty {
            operation_id: OperationId(1),
            bytes: b"a".to_vec(),
        })
        .await
        .unwrap();

        // The write is now parked in the gate on a blocking thread.
        started_rx.recv().await.expect("write started");

        // The runtime is still free: a spawned task runs to completion while the
        // write is parked. If the write held a Tokio worker, this would hang.
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ = done_tx.send(());
        });
        tokio::time::timeout(ANTI_HANG, done_rx)
            .await
            .expect("runtime responsive while command blocks")
            .expect("spawned task completed");

        gate.release();
        drop(tx);
        handle.await.unwrap().unwrap();
    }

    /// A write/flush failure emits exactly one payload-safe `PtyFailed` (naming
    /// the operation id, never the input bytes), requests best-effort child
    /// cleanup through the control channel, and stops the worker before the later
    /// queued command runs.
    #[tokio::test]
    async fn write_failure_emits_one_pty_failed_and_stops() {
        let log = CommandLog::default();
        let target = FakeCommandTarget::builder()
            .write_error("broken pipe")
            .build_with_log(log.clone());
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        let responder = spawn_control_responder(control_rx, log.clone(), Ok(()));
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let handle = spawn_pty_command_worker(rx, Box::new(target), control.clone(), sink.clone());

        tx.send(Effect::WritePty {
            operation_id: OperationId(1),
            bytes: b"a".to_vec(),
        })
        .await
        .unwrap();
        tx.send(Effect::WritePty {
            operation_id: OperationId(2),
            bytes: b"b".to_vec(),
        })
        .await
        .unwrap();
        drop(tx);

        assert_eq!(
            handle.await.unwrap(),
            Err(PtyAdapterError::Write {
                operation_id: OperationId(1),
                cause: "broken pipe".to_string(),
            })
        );
        drop(control);
        responder.join().unwrap();

        // Exactly one PtyFailed, payload-safe: it names the operation but carries
        // no input bytes.
        assert_eq!(
            sink.failures(),
            vec!["pty input write failed (operation 1): broken pipe".to_string()]
        );
        // The first input ran and failed; cleanup requested a kill; the later
        // write never ran.
        assert_eq!(log.ops(), vec!["input:a".to_string(), "kill".to_string()]);
    }

    /// An unexpected (non-pty) effect is a loss/corruption of the command
    /// executor: the worker requests child cleanup, emits exactly one
    /// `PtyFailed`, returns the typed `UnexpectedEffect`, and runs no command I/O.
    #[tokio::test]
    async fn unexpected_effect_requests_cleanup_and_emits_one_failure() {
        let log = CommandLog::default();
        let target = FakeCommandTarget::builder().build_with_log(log.clone());
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        let responder = spawn_control_responder(control_rx, log.clone(), Ok(()));
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let handle = spawn_pty_command_worker(rx, Box::new(target), control.clone(), sink.clone());

        tx.send(Effect::WriteConsole {
            operation_id: OperationId(1),
            bytes: vec![1, 2, 3],
        })
        .await
        .unwrap();
        drop(tx);

        assert_eq!(
            handle.await.unwrap(),
            Err(PtyAdapterError::UnexpectedEffect("WriteConsole"))
        );
        drop(control);
        responder.join().unwrap();

        // One PtyFailed for the unexpected effect, and the only recorded op is the
        // cleanup kill — no write/resize command I/O ran.
        assert_eq!(
            sink.failures(),
            vec!["unexpected non-pty effect on the pty command route: WriteConsole".to_string()]
        );
        assert_eq!(log.ops(), vec!["kill".to_string()]);
    }

    /// The command worker surfaces a closed lane too: when a write fails but the
    /// `PtyFailed` cannot be delivered, it returns `EventLaneClosed` (not the
    /// underlying write error) and does not retry or hang. Cleanup is still
    /// requested best-effort.
    #[tokio::test]
    async fn command_worker_closed_lane_on_failure_returns_event_lane_closed() {
        let target = FakeCommandTarget::builder()
            .write_error("broken pipe")
            .build();
        let sink = RecordingSink::closed();
        let (control, control_rx) = child_control_channel();
        let responder = spawn_control_responder(control_rx, CommandLog::default(), Ok(()));
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let handle = spawn_pty_command_worker(rx, Box::new(target), control.clone(), sink.clone());

        tx.send(Effect::WritePty {
            operation_id: OperationId(1),
            bytes: b"a".to_vec(),
        })
        .await
        .unwrap();
        drop(tx);

        assert_eq!(handle.await.unwrap(), Err(PtyAdapterError::EventLaneClosed));
        drop(control);
        responder.join().unwrap();
        assert!(sink.kinds().is_empty());
    }

    // ---- integrated command + lifecycle tests ----------------------------

    /// Test A — a write failure against a child that never exits until killed:
    /// the command worker emits exactly one `PtyFailed(Write)`, requests the
    /// authoritative child kill through the durable channel (so the original
    /// child kill is invoked), and the lifecycle converges without hanging and
    /// without a second terminal event. Exactly one failure total.
    #[tokio::test]
    async fn write_failure_terminates_child_and_emits_single_failure() {
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        let (child, child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::ExitAfterKill(137))
            .build();

        let lifecycle = spawn_pty_lifecycle(
            Box::new(FakeReader::eof()),
            Box::new(child),
            control_rx,
            sink.clone(),
        );

        let target = FakeCommandTarget::builder()
            .write_error("broken pipe")
            .build();
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let command = spawn_pty_command_worker(rx, Box::new(target), control.clone(), sink.clone());

        tx.send(Effect::WritePty {
            operation_id: OperationId(1),
            bytes: b"secret".to_vec(),
        })
        .await
        .unwrap();
        drop(tx);

        assert_eq!(
            tokio::time::timeout(ANTI_HANG, command)
                .await
                .expect("command worker completes")
                .unwrap(),
            Err(PtyAdapterError::Write {
                operation_id: OperationId(1),
                cause: "broken pipe".to_string(),
            })
        );
        // The lifecycle converges (no hang) and emits no terminal event of its own.
        tokio::time::timeout(ANTI_HANG, lifecycle)
            .await
            .expect("lifecycle converges without hanging")
            .unwrap()
            .unwrap();

        assert_eq!(
            child_state.kill_count(),
            1,
            "original child kill invoked once"
        );
        assert_eq!(
            sink.failures(),
            vec!["pty input write failed (operation 1): broken pipe".to_string()],
            "exactly one failure total, for the write error"
        );
        assert!(
            sink.exit_codes().is_empty(),
            "no PtyExited after a command failure"
        );
    }

    /// Test B — `KillPty` is executed by the child owner (not a target method or
    /// cloned killer) and the FIFO worker blocks for the response before the next
    /// command. The kill is gated: while it is in flight the later resize must not
    /// run; releasing it lets the resize run and the child exit becomes
    /// `PtyExited`.
    #[tokio::test]
    async fn kill_effect_uses_child_owner_and_fifo_waits_for_response() {
        let log = CommandLog::default();
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        let kill_gate = Gate::new();
        let (kill_reached_tx, mut kill_reached_rx) = mpsc::unbounded_channel();
        let (child, child_state) = FakeChildOwner::builder()
            .log(log.clone())
            .mode(TryWaitMode::ExitAfterKill(0))
            .kill_gate(Arc::clone(&kill_gate))
            .kill_reached(kill_reached_tx)
            .build();

        let lifecycle = spawn_pty_lifecycle(
            Box::new(FakeReader::eof()),
            Box::new(child),
            control_rx,
            sink.clone(),
        );

        let target = FakeCommandTarget::builder().build_with_log(log.clone());
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let command = spawn_pty_command_worker(rx, Box::new(target), control.clone(), sink.clone());

        tx.send(Effect::KillPty {
            operation_id: OperationId(1),
        })
        .await
        .unwrap();
        tx.send(Effect::ResizePty {
            operation_id: OperationId(2),
            cols: 90,
            rows: 20,
        })
        .await
        .unwrap();
        drop(tx);

        // The child-owner kill is in flight (gated). The FIFO worker is blocked
        // waiting for the response, so the later resize has NOT run.
        kill_reached_rx
            .recv()
            .await
            .expect("kill reached the child owner");
        assert_eq!(
            log.ops(),
            vec!["kill".to_string()],
            "resize must not run until the kill response returns"
        );

        // Release the kill; the worker gets its response and runs the resize.
        kill_gate.release();

        tokio::time::timeout(ANTI_HANG, command)
            .await
            .expect("command worker completes")
            .unwrap()
            .unwrap();
        tokio::time::timeout(ANTI_HANG, lifecycle)
            .await
            .expect("lifecycle completes")
            .unwrap()
            .unwrap();

        assert_eq!(
            log.ops(),
            vec!["kill".to_string(), "resize:90x20".to_string()],
            "the FIFO worker waited for the kill response before the resize"
        );
        assert_eq!(
            child_state.kill_count(),
            1,
            "kill went through the child owner"
        );
        assert_eq!(
            sink.exit_codes(),
            vec![0],
            "a successful graceful kill yields a PtyExited from the lifecycle"
        );
        assert!(sink.failures().is_empty(), "no failure on a clean kill");
    }

    /// Test C — a reader error while the child is still live: the error is
    /// observed promptly (not withheld behind a blocking wait) and emitted as one
    /// `PtyFailed(Read)`, the original child kill is invoked to reap it, and the
    /// lifecycle owns the child until that kill makes it exit — the child never
    /// exits on its own. (This is the permanent form of the RED case that hangs
    /// the old block-in-wait code.)
    #[tokio::test]
    async fn reader_error_with_live_child_kills_and_returns_failure() {
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        let (child, child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::ExitAfterKill(137))
            .build();
        let reader = FakeReader::new([
            ReadStep::Chunk(b"a".to_vec()),
            ReadStep::Error("read boom".to_string()),
        ]);

        let handle =
            spawn_pty_lifecycle(Box::new(reader), Box::new(child), control_rx, sink.clone());
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("reader error must complete the lifecycle without a natural exit")
            .unwrap();

        assert_eq!(
            result,
            Err(PtyAdapterError::Read {
                cause: "read boom".to_string(),
            })
        );
        assert_eq!(
            sink.outputs(),
            vec![b"a".to_vec()],
            "prior output precedes the failure"
        );
        assert_eq!(
            sink.failures(),
            vec!["pty read failed: read boom".to_string()]
        );
        assert!(
            sink.exit_codes().is_empty(),
            "no exit after a reader failure"
        );
        assert!(
            child_state.kill_count() >= 1,
            "the live child was killed to reap it"
        );
        assert!(child_state.released(), "the master was released");
        drop(control);
    }

    /// Test D — a reader panic while the child is still live: same prompt cleanup
    /// as a read error. The panic is caught and reported as one
    /// `PtyFailed(ReaderPanic)`, the child is killed to reap it, and the lifecycle
    /// returns once that kill makes the child exit — without hanging.
    #[tokio::test]
    async fn reader_panic_with_live_child_kills_and_returns_failure() {
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        let (child, child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::ExitAfterKill(0))
            .build();
        let reader = FakeReader::new([ReadStep::Panic]);

        let handle =
            spawn_pty_lifecycle(Box::new(reader), Box::new(child), control_rx, sink.clone());
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("reader panic must complete the lifecycle without a natural exit")
            .unwrap();

        assert_eq!(result, Err(PtyAdapterError::ReaderPanic));
        assert_eq!(
            sink.failures(),
            vec!["pty reader thread panicked".to_string()]
        );
        assert!(sink.outputs().is_empty());
        assert!(sink.exit_codes().is_empty(), "no exit after a reader panic");
        assert!(
            child_state.kill_count() >= 1,
            "the live child was killed to reap it"
        );
        drop(control);
    }

    /// Test E (regression) — a **failed** child kill must not tear the lifecycle
    /// down. The command worker emits its one `PtyFailed(Kill)` and exits, but the
    /// child-owner loop stays alive and retryable: it keeps owning the child, the
    /// still-blocked reader, and the durable control receiver. A later emergency
    /// `terminate` runs a *second* original-child kill that succeeds, the child
    /// exits, the master is released so the reader can EOF, and the lifecycle joins
    /// the reader and converges silently — one failure total, no `PtyExited`.
    ///
    /// This pins the recoverability guarantee. The old code returned/detached on
    /// the first kill error, so `terminate` would report `Closed`, only one kill
    /// would run, and the gated reader would be dropped rather than joined.
    #[tokio::test]
    async fn kill_error_keeps_lifecycle_alive_until_emergency_retry_reaps() {
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        // The reader only EOFs once the master is released; a sentinel proves it
        // is joined (never detached) before the lifecycle returns.
        let reader_gate = Gate::new();
        let sentinel = ReaderSentinel::new();
        let reader = FakeReader::new([ReadStep::Gate(Arc::clone(&reader_gate))])
            .with_sentinel(sentinel.clone());
        // First kill fails and leaves the child running; the second (emergency)
        // kill succeeds and reaps it.
        let (child, child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::ExitAfterSuccessfulKill(0))
            .kill_results(vec![Err("no such process".to_string()), Ok(())])
            .release_gate(Arc::clone(&reader_gate))
            .build();

        let lifecycle =
            spawn_pty_lifecycle(Box::new(reader), Box::new(child), control_rx, sink.clone());

        let target = FakeCommandTarget::builder().build();
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let command = spawn_pty_command_worker(rx, Box::new(target), control.clone(), sink.clone());

        tx.send(Effect::KillPty {
            operation_id: OperationId(7),
        })
        .await
        .unwrap();
        drop(tx);

        // The command worker surfaces the kill error and exits.
        assert_eq!(
            tokio::time::timeout(ANTI_HANG, command)
                .await
                .expect("command worker completes")
                .unwrap(),
            Err(PtyAdapterError::Kill {
                operation_id: OperationId(7),
                cause: "no such process".to_string(),
            })
        );

        // The lifecycle is still alive: it never released the master, so the
        // reader is still blocked (unfinished) and the child-owner loop is pending
        // and responsive to another control request.
        assert!(
            !lifecycle.is_finished(),
            "the loop must stay alive after a failed kill"
        );
        assert!(
            !sentinel.finished(),
            "the reader must still be owned (blocked), not detached"
        );
        assert_eq!(child_state.kill_count(), 1, "only the first kill has run");

        // The surviving emergency control runs a second original-child kill that
        // succeeds and reaps the child.
        let emergency = control.clone();
        let terminated = tokio::task::spawn_blocking(move || emergency.terminate())
            .await
            .unwrap();
        assert_eq!(terminated, Ok(()), "the emergency retry succeeds");

        // The lifecycle now converges silently — the reader is joined, not dropped.
        tokio::time::timeout(ANTI_HANG, lifecycle)
            .await
            .expect("lifecycle converges after the emergency retry")
            .unwrap()
            .unwrap();

        assert!(
            sentinel.finished(),
            "the reader thread finished before the lifecycle returned"
        );
        assert_eq!(
            child_state.kill_count(),
            2,
            "the emergency retry killed again"
        );
        assert!(
            child_state.released(),
            "the master was released to EOF the reader"
        );
        assert_eq!(
            sink.failures(),
            vec!["pty kill failed (operation 7): no such process".to_string()],
            "exactly one failure, the kill error owned by the command worker"
        );
        assert!(
            sink.exit_codes().is_empty(),
            "a suppressed convergence emits no PtyExited"
        );
    }

    /// Test F — an unexpected effect drives the same child cleanup through the
    /// real lifecycle: the child owner's kill is invoked and exactly one
    /// `PtyFailed(UnexpectedEffect)` is emitted, with no command I/O.
    #[tokio::test]
    async fn unexpected_effect_terminates_child_via_lifecycle() {
        let log = CommandLog::default();
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        let (child, child_state) = FakeChildOwner::builder()
            .log(log.clone())
            .mode(TryWaitMode::ExitAfterKill(0))
            .build();

        let lifecycle = spawn_pty_lifecycle(
            Box::new(FakeReader::eof()),
            Box::new(child),
            control_rx,
            sink.clone(),
        );

        let target = FakeCommandTarget::builder().build_with_log(log.clone());
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let command = spawn_pty_command_worker(rx, Box::new(target), control.clone(), sink.clone());

        tx.send(Effect::CloseClient {
            client_id: crate::engine::effect::ClientId(1),
        })
        .await
        .unwrap();
        drop(tx);

        assert_eq!(
            tokio::time::timeout(ANTI_HANG, command)
                .await
                .expect("command worker completes")
                .unwrap(),
            Err(PtyAdapterError::UnexpectedEffect("CloseClient"))
        );
        tokio::time::timeout(ANTI_HANG, lifecycle)
            .await
            .expect("lifecycle converges")
            .unwrap()
            .unwrap();

        assert_eq!(
            child_state.kill_count(),
            1,
            "child cleanup went through the owner"
        );
        assert_eq!(
            sink.failures(),
            vec!["unexpected non-pty effect on the pty command route: CloseClient".to_string()]
        );
        assert!(sink.exit_codes().is_empty());
        assert_eq!(
            log.ops(),
            vec!["kill".to_string()],
            "no write/resize command I/O"
        );
    }

    /// Test G — the supervisor's emergency control clone can terminate the child
    /// even after the command worker has exited and its route has closed, proving
    /// the capability survives the command worker (the child-owner loop, not the
    /// worker, holds the receiver).
    #[tokio::test]
    async fn emergency_control_survives_command_worker_exit() {
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        let (child, child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::ExitAfterKill(0))
            .build();

        let lifecycle = spawn_pty_lifecycle(
            Box::new(FakeReader::eof()),
            Box::new(child),
            control_rx,
            sink.clone(),
        );

        // A command worker that immediately drains an empty route and exits,
        // dropping its control handle.
        let target = FakeCommandTarget::builder().build();
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let command = spawn_pty_command_worker(rx, Box::new(target), control.clone(), sink.clone());
        drop(tx);
        tokio::time::timeout(ANTI_HANG, command)
            .await
            .expect("command worker exits")
            .unwrap()
            .unwrap();

        // The emergency clone (the supervisor's handle) still terminates the child.
        let emergency = control.clone();
        let terminated = tokio::task::spawn_blocking(move || emergency.terminate())
            .await
            .unwrap();
        assert_eq!(terminated, Ok(()));
        assert!(
            child_state.kill_count() >= 1,
            "emergency terminate killed the child after the command worker exited"
        );

        tokio::time::timeout(ANTI_HANG, lifecycle)
            .await
            .expect("lifecycle converges after the emergency terminate")
            .unwrap()
            .unwrap();
        drop(control);
    }

    // ---- reader-ownership regression tests (Task 11) ---------------------

    /// Regression — a reader error whose *first* authoritative kill fails must not
    /// end the lifecycle. The read failure is emitted promptly (one
    /// `PtyFailed(Read)`) and the reader (already finished) is joinable, but the
    /// loop keeps owning the still-running child and stays retryable. A later
    /// emergency terminate succeeds, the child exits, and the lifecycle returns
    /// the same read error — exactly one failure, no second event.
    ///
    /// The old code killed best-effort and returned immediately, so it could not
    /// retry a failed kill and left the child unreaped.
    #[tokio::test]
    async fn reader_error_with_failed_kill_stays_retryable_until_emergency() {
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        let (first_kill_tx, mut first_kill_rx) = mpsc::unbounded_channel();
        // The first (reader-error) kill fails and leaves the child running; the
        // emergency retry succeeds and reaps it.
        let (child, child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::ExitAfterSuccessfulKill(0))
            .kill_results(vec![Err("first".to_string()), Ok(())])
            .kill_reached(first_kill_tx)
            .build();
        let sentinel = ReaderSentinel::new();
        let reader = FakeReader::new([
            ReadStep::Chunk(b"a".to_vec()),
            ReadStep::Error("read boom".to_string()),
        ])
        .with_sentinel(sentinel.clone());

        let lifecycle =
            spawn_pty_lifecycle(Box::new(reader), Box::new(child), control_rx, sink.clone());

        // The reader error is observed: its failure is emitted and the first
        // (failing) authoritative kill runs — before any child exit.
        first_kill_rx
            .recv()
            .await
            .expect("the reader error triggers the first kill");
        assert_eq!(
            sink.failures(),
            vec!["pty read failed: read boom".to_string()],
            "the read failure is emitted promptly"
        );
        assert_eq!(
            sink.outputs(),
            vec![b"a".to_vec()],
            "prior output precedes the failure"
        );
        assert!(
            !lifecycle.is_finished(),
            "the loop stays alive/retryable after the failed kill"
        );
        assert_eq!(child_state.kill_count(), 1, "only the first kill has run");

        // The surviving emergency control retries and reaps the child.
        let emergency = control.clone();
        let terminated = tokio::task::spawn_blocking(move || emergency.terminate())
            .await
            .unwrap();
        assert_eq!(terminated, Ok(()), "the emergency retry succeeds");

        let result = tokio::time::timeout(ANTI_HANG, lifecycle)
            .await
            .expect("lifecycle returns after the child is reaped")
            .unwrap();
        assert_eq!(
            result,
            Err(PtyAdapterError::Read {
                cause: "read boom".to_string(),
            })
        );
        assert!(
            sentinel.finished(),
            "the reader thread was joined before the lifecycle returned"
        );
        assert_eq!(
            child_state.kill_count(),
            2,
            "the emergency retry killed again"
        );
        assert_eq!(
            sink.failures(),
            vec!["pty read failed: read boom".to_string()],
            "exactly one failure total"
        );
        assert!(
            sink.exit_codes().is_empty(),
            "no exit after a reader failure"
        );
    }

    /// Regression — a successful *suppressing* cleanup kill (here a write failure)
    /// must not return the moment the kill succeeds. The child-owner loop keeps
    /// polling until it observes the child exit, then releases the master, drains
    /// and **joins** the reader, and converges silently. A reader gated on a
    /// test-controlled latch proves the loop blocks on the join (rather than
    /// detaching): while the reader is latched the lifecycle stays pending, and it
    /// only returns once the reader is released and finishes.
    #[tokio::test]
    async fn successful_suppressing_cleanup_waits_for_exit_then_joins_reader() {
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        let (exit_seen_tx, mut exit_seen_rx) = mpsc::unbounded_channel();
        // The reader can only finish when the test releases this latch — not when
        // the master is released — so a detaching loop would return early.
        let reader_latch = Gate::new();
        let sentinel = ReaderSentinel::new();
        let reader = FakeReader::new([ReadStep::Gate(Arc::clone(&reader_latch))])
            .with_sentinel(sentinel.clone());
        let (child, child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::ExitAfterKill(0))
            .try_wait_some(exit_seen_tx)
            .build();

        let lifecycle =
            spawn_pty_lifecycle(Box::new(reader), Box::new(child), control_rx, sink.clone());

        let target = FakeCommandTarget::builder()
            .write_error("broken pipe")
            .build();
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let command = spawn_pty_command_worker(rx, Box::new(target), control.clone(), sink.clone());

        tx.send(Effect::WritePty {
            operation_id: OperationId(1),
            bytes: b"secret".to_vec(),
        })
        .await
        .unwrap();
        drop(tx);

        assert_eq!(
            tokio::time::timeout(ANTI_HANG, command)
                .await
                .expect("command worker completes")
                .unwrap(),
            Err(PtyAdapterError::Write {
                operation_id: OperationId(1),
                cause: "broken pipe".to_string(),
            })
        );

        // The loop kept polling and observed the child exit (the old suppressed
        // path returned on the kill and never got here).
        tokio::time::timeout(ANTI_HANG, exit_seen_rx.recv())
            .await
            .expect("the loop must observe the child exit before returning")
            .expect("exit observed");

        // The child has exited but the reader is still latched, so the lifecycle
        // is blocked joining it — provably not detached.
        assert!(
            !lifecycle.is_finished(),
            "the lifecycle must block on the reader join, not detach and return"
        );
        assert!(
            !sentinel.finished(),
            "the reader is still owned and running"
        );

        // Release the reader; the lifecycle joins it and converges silently.
        reader_latch.release();
        tokio::time::timeout(ANTI_HANG, lifecycle)
            .await
            .expect("lifecycle converges once the reader finishes")
            .unwrap()
            .unwrap();

        assert!(
            sentinel.finished(),
            "the reader thread finished before the lifecycle returned"
        );
        assert_eq!(child_state.kill_count(), 1, "one suppressing cleanup kill");
        assert_eq!(
            sink.failures(),
            vec!["pty input write failed (operation 1): broken pipe".to_string()],
            "exactly one write failure"
        );
        assert!(
            sink.exit_codes().is_empty(),
            "no PtyExited on a suppressed convergence"
        );
    }

    /// Sentinel proof for a **clean exit**: with the reader latched by the test,
    /// the lifecycle observes the child exit, then blocks joining the reader and
    /// only emits `PtyExited` and returns once the reader has finished.
    #[tokio::test]
    async fn reader_thread_is_joined_before_clean_exit_returns() {
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        let (exit_seen_tx, mut exit_seen_rx) = mpsc::unbounded_channel();
        let reader_latch = Gate::new();
        let sentinel = ReaderSentinel::new();
        let reader = FakeReader::new([ReadStep::Gate(Arc::clone(&reader_latch))])
            .with_sentinel(sentinel.clone());
        let (child, _child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::CleanExit(0))
            .try_wait_some(exit_seen_tx)
            .build();

        let lifecycle =
            spawn_pty_lifecycle(Box::new(reader), Box::new(child), control_rx, sink.clone());

        tokio::time::timeout(ANTI_HANG, exit_seen_rx.recv())
            .await
            .expect("the child exit is observed")
            .expect("exit observed");
        assert!(
            !lifecycle.is_finished(),
            "the exit is withheld until the reader is joined"
        );
        assert!(!sentinel.finished(), "the reader is still owned");
        assert!(
            sink.exit_codes().is_empty(),
            "no exit emitted while joining"
        );

        reader_latch.release();
        tokio::time::timeout(ANTI_HANG, lifecycle)
            .await
            .expect("lifecycle returns once the reader finishes")
            .unwrap()
            .unwrap();

        assert!(
            sentinel.finished(),
            "the reader was joined before returning"
        );
        assert_eq!(sink.exit_codes(), vec![0], "exit lands after the reader");
        drop(control);
    }

    /// Sentinel proof for a **successful graceful kill**: a `KillPty` that succeeds
    /// keeps the loop running until the child exit, which — like a clean exit —
    /// waits for the reader to be joined before `PtyExited` is emitted.
    #[tokio::test]
    async fn reader_thread_is_joined_before_graceful_kill_exit_returns() {
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();
        let (exit_seen_tx, mut exit_seen_rx) = mpsc::unbounded_channel();
        let reader_latch = Gate::new();
        let sentinel = ReaderSentinel::new();
        let reader = FakeReader::new([ReadStep::Gate(Arc::clone(&reader_latch))])
            .with_sentinel(sentinel.clone());
        let (child, child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::ExitAfterKill(0))
            .try_wait_some(exit_seen_tx)
            .build();

        let lifecycle =
            spawn_pty_lifecycle(Box::new(reader), Box::new(child), control_rx, sink.clone());

        let target = FakeCommandTarget::builder().build();
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let command = spawn_pty_command_worker(rx, Box::new(target), control.clone(), sink.clone());
        tx.send(Effect::KillPty {
            operation_id: OperationId(1),
        })
        .await
        .unwrap();
        drop(tx);
        tokio::time::timeout(ANTI_HANG, command)
            .await
            .expect("command worker completes")
            .unwrap()
            .unwrap();

        tokio::time::timeout(ANTI_HANG, exit_seen_rx.recv())
            .await
            .expect("the graceful kill's exit is observed")
            .expect("exit observed");
        assert!(
            !lifecycle.is_finished(),
            "the exit is withheld until the reader is joined"
        );
        assert!(!sentinel.finished(), "the reader is still owned");

        reader_latch.release();
        tokio::time::timeout(ANTI_HANG, lifecycle)
            .await
            .expect("lifecycle returns once the reader finishes")
            .unwrap()
            .unwrap();

        assert!(
            sentinel.finished(),
            "the reader was joined before returning"
        );
        assert_eq!(
            child_state.kill_count(),
            1,
            "the graceful kill went through"
        );
        assert_eq!(
            sink.exit_codes(),
            vec![0],
            "a successful graceful kill exits cleanly"
        );
        assert!(
            sink.failures().is_empty(),
            "no failure on a clean graceful kill"
        );
    }

    // ---- lifecycle output-ordering / anti-deadlock tests (H) --------------

    /// The lifecycle emits every output chunk in order and emits the final
    /// `PtyExited` only after every output is enqueued and the reader has reached
    /// EOF — even though the child exits first. The reader is gated after its two
    /// chunks (a Windows-like reader that can't EOF yet), so while the child has
    /// already exited the exit is provably still withheld; releasing the gate
    /// lets the reader EOF and the exit land last.
    #[tokio::test]
    async fn output_precedes_exit_even_when_child_exits_first() {
        let reader_gate = Gate::new();
        let (reader_gated_tx, mut reader_gated_rx) = mpsc::unbounded_channel();
        let (exit_seen_tx, mut exit_seen_rx) = mpsc::unbounded_channel();

        let reader = FakeReader::new([
            ReadStep::Chunk(b"a".to_vec()),
            ReadStep::Chunk(b"b".to_vec()),
            ReadStep::Signal(reader_gated_tx),
            ReadStep::Gate(Arc::clone(&reader_gate)),
        ]);
        let (child, _child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::CleanExit(0))
            .try_wait_some(exit_seen_tx)
            .build();
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();

        let handle =
            spawn_pty_lifecycle(Box::new(reader), Box::new(child), control_rx, sink.clone());

        // Both chunks are emitted and the reader is now parked; the child exit has
        // already been observed by the loop.
        reader_gated_rx
            .recv()
            .await
            .expect("reader gated after chunks");
        exit_seen_rx
            .recv()
            .await
            .expect("child exit observed first");

        // Exit is withheld until the reader drains: only the two outputs so far.
        assert_eq!(
            sink.kinds(),
            vec![EventKind::PtyOutput, EventKind::PtyOutput]
        );
        assert_eq!(sink.outputs(), vec![b"a".to_vec(), b"b".to_vec()]);

        // Release the reader's EOF; the loop drains it, then emits the exit.
        reader_gate.release();
        tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("no deadlock")
            .unwrap()
            .unwrap();

        assert_eq!(
            sink.kinds(),
            vec![
                EventKind::PtyOutput,
                EventKind::PtyOutput,
                EventKind::PtyExited,
            ]
        );
        assert_eq!(sink.exit_codes(), vec![0]);
        drop(control);
    }

    /// The master release must run concurrently with a live reader: the reader's
    /// EOF gate opens only when `release_master` runs (the master-drop analogue),
    /// so a sequential read-then-wait bridge would deadlock. A bounded timeout is
    /// the only anti-hang net; the responsive loop completes well within it.
    #[tokio::test]
    async fn child_exit_releases_master_so_gated_reader_can_eof() {
        let eof_gate = Gate::new();
        let reader = FakeReader::new([
            ReadStep::Chunk(b"x".to_vec()),
            ReadStep::Gate(Arc::clone(&eof_gate)),
        ]);
        let (child, _child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::CleanExit(0))
            .release_gate(Arc::clone(&eof_gate))
            .build();
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();

        let handle =
            spawn_pty_lifecycle(Box::new(reader), Box::new(child), control_rx, sink.clone());
        tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("reader and master release must overlap (no deadlock)")
            .unwrap()
            .unwrap();

        assert_eq!(sink.outputs(), vec![b"x".to_vec()]);
        assert_eq!(sink.exit_codes(), vec![0]);
        assert_eq!(
            sink.kinds(),
            vec![EventKind::PtyOutput, EventKind::PtyExited]
        );
        drop(control);
    }

    /// A reader error after prior output emits that output, then exactly one
    /// `PtyFailed`, and never a `PtyExited` — even though the child exits cleanly.
    /// The reader failure takes precedence.
    #[tokio::test]
    async fn reader_error_after_output_emits_failure_and_no_exit() {
        let reader = FakeReader::new([
            ReadStep::Chunk(b"a".to_vec()),
            ReadStep::Error("read boom".to_string()),
        ]);
        let (child, _child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::CleanExit(0))
            .build();
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();

        let handle =
            spawn_pty_lifecycle(Box::new(reader), Box::new(child), control_rx, sink.clone());
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("no deadlock")
            .unwrap();

        assert_eq!(
            result,
            Err(PtyAdapterError::Read {
                cause: "read boom".to_string(),
            })
        );
        assert_eq!(sink.outputs(), vec![b"a".to_vec()]);
        assert_eq!(
            sink.failures(),
            vec!["pty read failed: read boom".to_string()]
        );
        assert!(
            sink.exit_codes().is_empty(),
            "no exit after a reader failure"
        );
        assert_eq!(
            sink.kinds(),
            vec![EventKind::PtyOutput, EventKind::PtyFailed]
        );
        drop(control);
    }

    /// A `try_wait` failure emits exactly one `PtyFailed(Wait)` and no
    /// `PtyExited`; the master is released so a prior reader can drain, and the
    /// reader thread is joined (never detached) before the lifecycle returns.
    #[tokio::test]
    async fn wait_error_emits_failure_and_no_exit() {
        let sentinel = ReaderSentinel::new();
        let reader = FakeReader::eof().with_sentinel(sentinel.clone());
        let (child, child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::WaitError("wait boom".to_string()))
            .build();
        let sink = RecordingSink::new();
        let (control, control_rx) = child_control_channel();

        let handle =
            spawn_pty_lifecycle(Box::new(reader), Box::new(child), control_rx, sink.clone());
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("no deadlock")
            .unwrap();

        assert_eq!(
            result,
            Err(PtyAdapterError::Wait {
                cause: "wait boom".to_string(),
            })
        );
        assert_eq!(
            sink.failures(),
            vec!["pty wait failed: wait boom".to_string()]
        );
        assert!(sink.exit_codes().is_empty(), "no exit after a wait failure");
        assert!(
            child_state.released(),
            "the master was released on the wait error"
        );
        assert!(
            sentinel.finished(),
            "the reader thread was joined before the lifecycle returned"
        );
        drop(control);
    }

    /// A closed pty event lane surfaces an explicit error from the lifecycle
    /// without panicking when the reader cannot deliver its output, and still
    /// joins the reader thread before returning.
    #[tokio::test]
    async fn closed_event_lane_returns_error_without_panic() {
        let sentinel = ReaderSentinel::new();
        let reader =
            FakeReader::new([ReadStep::Chunk(b"a".to_vec())]).with_sentinel(sentinel.clone());
        let (child, _child_state) = FakeChildOwner::builder()
            .mode(TryWaitMode::CleanExit(0))
            .build();
        let sink = RecordingSink::closed();
        let (control, control_rx) = child_control_channel();

        let handle =
            spawn_pty_lifecycle(Box::new(reader), Box::new(child), control_rx, sink.clone());
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("no deadlock")
            .unwrap();

        assert_eq!(result, Err(PtyAdapterError::EventLaneClosed));
        assert!(sink.kinds().is_empty(), "a closed lane records nothing");
        assert!(
            sentinel.finished(),
            "the reader thread was joined before the lifecycle returned"
        );
        drop(control);
    }

    // ---- control handle / send safety ------------------------------------

    /// The emergency [`PtyControlHandle`] is `Send + Clone` so the supervisor can
    /// move and clone it across threads; a closed channel maps to an explicit
    /// `Closed`, never a panic or a hang.
    #[test]
    fn control_handle_is_send_clone_and_reports_closed() {
        fn assert_send_clone<T: Send + Clone>() {}
        assert_send_clone::<PtyControlHandle>();

        let (control, control_rx) = child_control_channel();
        drop(control_rx);
        // No child-owner loop is holding the receiver, so terminate reports the
        // channel as closed rather than blocking for a response.
        assert_eq!(control.terminate(), Err(PtyControlError::Closed));
    }

    /// The production [`super::PtyEventSink`] for the real `PtyEventSender` maps a
    /// closed lane to [`PtyAdapterError::EventLaneClosed`]. Run on a plain thread
    /// (no async context) because the blocking send may not run on a runtime
    /// worker.
    #[test]
    fn real_pty_event_sender_emit_maps_closed_lane_to_error() {
        let (pty_tx, _control_tx, lanes) = event_lanes();
        drop(lanes);
        let err = pty_tx.emit(SessionEvent::PtyExited(0)).unwrap_err();
        assert_eq!(err, PtyAdapterError::EventLaneClosed);
    }
}
