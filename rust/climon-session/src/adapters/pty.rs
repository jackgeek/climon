//! Exclusively-owned PTY adapter: the tasks that own the split
//! [`climon_pty::PtyParts`] and translate pty effects into real I/O, feeding
//! output/exit/failure back to the coordinator's pty event lane.
//!
//! Two owned workers share the parts, with no `Arc<Mutex>` around any PTY
//! resource:
//!
//! - a **FIFO command worker** owns the writer, resizer, and killer. It drains
//!   the coordinator's pty effect route ([`EffectReceivers::pty`]) directly and
//!   executes [`Effect::WritePty`] (write then flush), [`Effect::ResizePty`],
//!   and [`Effect::KillPty`] serially, off the Tokio workers (a dedicated
//!   `spawn_blocking` that uses `blocking_recv`).
//! - a **blocking output/lifecycle bridge** owns the reader and the child
//!   waiter. It reads output chunks and emits [`SessionEvent::PtyOutput`], waits
//!   for the child *concurrently* with the reader (the consuming wait drops the
//!   last strong master so a Windows ConPTY cloned reader can EOF), then — after
//!   the reader is fully drained — emits [`SessionEvent::PtyExited`].
//!
//! An actual pty I/O or wait failure surfaces a typed [`PtyAdapterError`] and,
//! when the lane is still open, one payload-safe [`SessionEvent::PtyFailed`].
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

use tokio::sync::mpsc;
use tokio::task::{spawn_blocking, JoinHandle};

use climon_pty::{PtyKiller, PtyResizer, PtyWaiter};

use crate::engine::coordinator::{LaneSendError, PtyEventSender};
use crate::engine::effect::{Effect, OperationId};
use crate::engine::event::SessionEvent;

/// The largest output chunk the reader bridge forwards per read, matching the
/// legacy host's reader buffer so Windows ConPTY behaviour is unchanged.
const PTY_READ_CHUNK: usize = 65536;

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

// ---- command target ----------------------------------------------------

/// The blocking command operations the FIFO worker performs. Kept behind a
/// trait so tests can record commands without a real PTY; production is
/// [`RealPtyCommandTarget`], built from the owned [`climon_pty::PtyParts`].
pub(crate) trait PtyCommandTarget: Send {
    /// The pty writer. The worker writes input to it and flushes; the writer's
    /// I/O errors are payload-free (they never contain the input bytes).
    fn writer(&mut self) -> &mut dyn Write;

    /// Applies a resize. Returns whether the size changed (clamp/dedupe is the
    /// resizer's job); `false` means unchanged and is **not** a failure.
    fn resize(&mut self, cols: u16, rows: u16) -> bool;

    /// Kills the child process. The returned error message is payload-free.
    fn kill(&mut self) -> Result<(), String>;
}

/// The production [`PtyCommandTarget`]: owns the taken writer, the `Weak`
/// resizer, and the independently cloned killer from [`climon_pty::PtyParts`].
struct RealPtyCommandTarget {
    writer: Box<dyn Write + Send>,
    resizer: PtyResizer,
    killer: PtyKiller,
}

impl PtyCommandTarget for RealPtyCommandTarget {
    fn writer(&mut self) -> &mut dyn Write {
        &mut *self.writer
    }

    fn resize(&mut self, cols: u16, rows: u16) -> bool {
        self.resizer.resize(cols, rows)
    }

    fn kill(&mut self) -> Result<(), String> {
        self.killer.kill().map_err(|error| error.to_string())
    }
}

// ---- command worker ----------------------------------------------------

/// Runs the FIFO command worker to completion: drain the pty command route in
/// FIFO order and execute each command serially against `target`. A write is
/// `write_all` followed by `flush`; a resize keeps the resizer's clamp/dedupe
/// semantics (an unchanged size is not a failure); a kill terminates the child.
///
/// An unexpected (non-pty) effect stops the worker with a typed error and runs
/// no command. A write/flush or kill failure emits one payload-safe
/// [`SessionEvent::PtyFailed`] (when the lane is open) and stops before any
/// later command. When the route closes, the worker drains what is already
/// queued and returns `Ok(())`.
///
/// The whole loop runs on a blocking thread (via [`spawn_pty_command_worker`]),
/// so `blocking_recv` and the blocking writes never occupy a Tokio worker.
fn run_pty_command_worker<E: PtyEventSink>(
    mut effects: mpsc::Receiver<Effect>,
    mut target: Box<dyn PtyCommandTarget>,
    events: E,
) -> Result<(), PtyAdapterError> {
    while let Some(effect) = effects.blocking_recv() {
        match PtyCommand::from_effect(effect)? {
            PtyCommand::Input {
                operation_id,
                bytes,
            } => {
                let writer = target.writer();
                if let Err(error) = writer.write_all(&bytes).and_then(|()| writer.flush()) {
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
                if let Err(cause) = target.kill() {
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
    Ok(())
}

/// Spawns [`run_pty_command_worker`] on a dedicated blocking thread and returns
/// its owned handle. No task is detached; the supervisor (Task 14) owns and
/// later joins the returned handle.
pub(crate) fn spawn_pty_command_worker<E: PtyEventSink>(
    effects: mpsc::Receiver<Effect>,
    target: Box<dyn PtyCommandTarget>,
    events: E,
) -> JoinHandle<Result<(), PtyAdapterError>> {
    spawn_blocking(move || run_pty_command_worker(effects, target, events))
}

// ---- wait target -------------------------------------------------------

/// The blocking child-wait operation. Consuming, so the implementation drops the
/// last strong PTY master immediately after the child exits. Kept behind a trait
/// so tests can substitute a scripted waiter; production is [`RealPtyWaitTarget`],
/// built from the owned [`climon_pty::PtyParts`].
pub(crate) trait PtyWaitTarget: Send {
    /// Blocks until the child exits, returning its exit code or a payload-free
    /// error. Consuming: releasing the last strong master is part of returning,
    /// on both success and failure.
    fn wait(self: Box<Self>) -> Result<i32, String>;
}

/// The production [`PtyWaitTarget`]: wraps the owned [`climon_pty::PtyWaiter`],
/// whose consuming `wait` drops the last strong master on success or failure.
struct RealPtyWaitTarget {
    waiter: PtyWaiter,
}

impl PtyWaitTarget for RealPtyWaitTarget {
    fn wait(self: Box<Self>) -> Result<i32, String> {
        self.waiter.wait().map_err(|error| error.to_string())
    }
}

// ---- output / lifecycle bridge -----------------------------------------

/// The outcome of the blocking reader loop.
enum ReadOutcome {
    /// Clean EOF: every output chunk was read and enqueued.
    Eof,
    /// A `read` returned an error (payload-free cause).
    ReadError(String),
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

/// Runs the output/lifecycle bridge to completion.
///
/// It reads output on a scoped std thread while, concurrently, waiting for the
/// child on this thread — the two must overlap because a Windows ConPTY reader
/// only EOFs once the consuming wait drops the last strong master. After the
/// wait resolves (releasing the master) the reader is joined, draining every
/// output it emitted before EOF, and only then is the exit or failure emitted so
/// all earlier output is ordered ahead of it.
///
/// A reader failure (read error or thread panic) takes precedence over the wait
/// result: it emits one [`SessionEvent::PtyFailed`] and no exit. A wait failure
/// after a clean reader EOF likewise emits one failure and no exit. A clean EOF
/// with a successful wait emits [`SessionEvent::PtyExited`]. A closed lane is
/// surfaced as [`PtyAdapterError::EventLaneClosed`] without a retry.
fn run_pty_lifecycle<E: PtyEventSink>(
    reader: Box<dyn Read + Send>,
    waiter: Box<dyn PtyWaitTarget>,
    events: E,
) -> Result<(), PtyAdapterError> {
    // The scoped reader thread is always joined inside the scope (on return or
    // unwind), so no helper thread is left running.
    let (wait_result, reader_outcome) = std::thread::scope(|scope| {
        let reader_events = events.clone();
        let reader_handle = scope.spawn(move || read_loop(reader, &reader_events));
        // Wait concurrently with the reader. The consuming wait drops the last
        // strong master on success or failure, letting a Windows ConPTY cloned
        // reader EOF.
        let wait_result = waiter.wait();
        // The master is released; join the reader, draining every output it
        // emitted before EOF (or capturing its error / panic).
        let reader_outcome = reader_handle.join();
        (wait_result, reader_outcome)
    });

    let reader_outcome = match reader_outcome {
        Ok(outcome) => outcome,
        Err(_panic) => return emit_failure(&events, PtyAdapterError::ReaderPanic),
    };

    match reader_outcome {
        // The lane closed while the reader was still emitting; nothing more can
        // be delivered, so report it without retrying.
        ReadOutcome::LaneClosed => Err(PtyAdapterError::EventLaneClosed),
        // A reader failure takes precedence over the wait result.
        ReadOutcome::ReadError(cause) => emit_failure(&events, PtyAdapterError::Read { cause }),
        ReadOutcome::Eof => match wait_result {
            // Every output is enqueued (reader joined); the exit lands last.
            Ok(exit_code) => events.emit(SessionEvent::PtyExited(exit_code)),
            Err(cause) => emit_failure(&events, PtyAdapterError::Wait { cause }),
        },
    }
}

/// Spawns [`run_pty_lifecycle`] on a dedicated blocking thread and returns its
/// owned handle. The scoped reader thread it starts is always joined inside the
/// task; no helper thread is left unjoined.
pub(crate) fn spawn_pty_lifecycle<E: PtyEventSink>(
    reader: Box<dyn Read + Send>,
    waiter: Box<dyn PtyWaitTarget>,
    events: E,
) -> JoinHandle<Result<(), PtyAdapterError>> {
    spawn_blocking(move || run_pty_lifecycle(reader, waiter, events))
}

// ---- adapter assembly --------------------------------------------------

/// The two owned join handles the pty adapter produces. The supervisor (Task 14)
/// owns and later joins both; neither worker is detached.
pub(crate) struct PtyAdapterHandles {
    /// The FIFO command worker (writer + resizer + killer).
    pub(crate) command: JoinHandle<Result<(), PtyAdapterError>>,
    /// The output/lifecycle bridge (reader + waiter).
    pub(crate) lifecycle: JoinHandle<Result<(), PtyAdapterError>>,
}

/// Assembles the pty adapter from the owned [`climon_pty::PtyParts`]: the command
/// worker takes the writer/resizer/killer and drains `effects`; the lifecycle
/// bridge takes the reader/waiter. Both emit through the pty `events` lane.
/// Returns the two owned handles.
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
        killer,
        pid: _,
    } = parts;

    let command_target: Box<dyn PtyCommandTarget> = Box::new(RealPtyCommandTarget {
        writer,
        resizer,
        killer,
    });
    let wait_target: Box<dyn PtyWaitTarget> = Box::new(RealPtyWaitTarget { waiter });

    let command = spawn_pty_command_worker(effects, command_target, events.clone());
    let lifecycle = spawn_pty_lifecycle(reader, wait_target, events);
    PtyAdapterHandles { command, lifecycle }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Condvar, Mutex};

    use tokio::sync::mpsc;

    use super::{
        spawn_pty_command_worker, spawn_pty_lifecycle, PtyAdapterError, PtyCommandTarget,
        PtyEventSink, PtyWaitTarget,
    };
    use crate::engine::coordinator::event_lanes;
    use crate::engine::effect::{Effect, OperationId};
    use crate::engine::event::{EventKind, SessionEvent};
    use crate::engine::PTY_COMMAND_CAPACITY;

    // ---- shared recorder -------------------------------------------------

    /// An ordered log of the operations a fake command target observes, shared
    /// between the fake writer (write/flush) and the fake target (resize/kill)
    /// so a single FIFO sequence is asserted across all three.
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

    /// A permit-based gate: a worker parks in [`Gate::wait`] until a test calls
    /// [`Gate::release`], proving the parked call runs off the Tokio workers.
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
    /// as `input:<bytes>` and every flush as `flush` (so a test can assert that
    /// each input is flushed), and can gate/signal/fail to drive the timing and
    /// failure tests.
    ///
    /// The recorded `input:<bytes>` form exists only in this test recorder; the
    /// production adapter never renders input bytes into any string.
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

    /// A fake [`PtyCommandTarget`] recording resize/kill into the shared log and
    /// returning configured results.
    struct FakeCommandTarget {
        log: CommandLog,
        writer: FakeWriter,
        resize_returns: bool,
        kill_result: Result<(), String>,
    }

    #[derive(Default)]
    struct FakeCommandTargetBuilder {
        started: Option<mpsc::UnboundedSender<()>>,
        gate: Option<Arc<Gate>>,
        write_error: Option<String>,
        flush_error: Option<String>,
        resize_returns: bool,
        kill_result: Option<Result<(), String>>,
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

        fn kill_error(mut self, message: &str) -> Self {
            self.kill_result = Some(Err(message.to_string()));
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
                kill_result: self.kill_result.unwrap_or(Ok(())),
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

        fn kill(&mut self) -> Result<(), String> {
            self.log.push("kill");
            self.kill_result.clone()
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

    // ---- fake reader + waiter -------------------------------------------

    /// A scripted step the [`FakeReader`] plays out. `Chunk` returns bytes from a
    /// `read`; `Signal` fires a channel (without returning) so a test can observe
    /// that all prior chunks have been emitted; `Gate` parks the read until
    /// released (modelling a Windows reader that only EOFs once the master
    /// drops); `Error` fails the read. An exhausted script returns EOF.
    enum ReadStep {
        Chunk(Vec<u8>),
        Signal(mpsc::UnboundedSender<()>),
        Gate(Arc<Gate>),
        Error(String),
        Panic,
    }

    /// A fake [`Read`] that plays out a scripted sequence of steps, used to drive
    /// the output/lifecycle ordering and failure tests deterministically.
    struct FakeReader {
        steps: VecDeque<ReadStep>,
    }

    impl FakeReader {
        fn new(steps: impl IntoIterator<Item = ReadStep>) -> FakeReader {
            FakeReader {
                steps: steps.into_iter().collect(),
            }
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

    /// A fake [`PtyWaitTarget`]. Its consuming `wait` optionally releases a gate
    /// (the master-drop analogue that lets a gated reader EOF) and signals a
    /// channel, then returns the configured result — mirroring the real waiter,
    /// which drops the master on both success and failure.
    struct FakeWaitTarget {
        result: Result<i32, String>,
        release_on_wait: Option<Arc<Gate>>,
        signal_on_wait: Option<mpsc::UnboundedSender<()>>,
    }

    #[derive(Default)]
    struct FakeWaitTargetBuilder {
        result: Option<Result<i32, String>>,
        release_on_wait: Option<Arc<Gate>>,
        signal_on_wait: Option<mpsc::UnboundedSender<()>>,
    }

    impl FakeWaitTargetBuilder {
        fn exit_code(mut self, code: i32) -> Self {
            self.result = Some(Ok(code));
            self
        }

        fn wait_error(mut self, message: &str) -> Self {
            self.result = Some(Err(message.to_string()));
            self
        }

        fn release_on_wait(mut self, gate: Arc<Gate>) -> Self {
            self.release_on_wait = Some(gate);
            self
        }

        fn signal_on_wait(mut self, tx: mpsc::UnboundedSender<()>) -> Self {
            self.signal_on_wait = Some(tx);
            self
        }

        fn build(self) -> FakeWaitTarget {
            FakeWaitTarget {
                result: self.result.unwrap_or(Ok(0)),
                release_on_wait: self.release_on_wait,
                signal_on_wait: self.signal_on_wait,
            }
        }
    }

    impl FakeWaitTarget {
        fn builder() -> FakeWaitTargetBuilder {
            FakeWaitTargetBuilder::default()
        }
    }

    impl PtyWaitTarget for FakeWaitTarget {
        fn wait(self: Box<Self>) -> Result<i32, String> {
            // Release the reader's EOF gate (master-drop analogue) and signal on
            // both success and failure, exactly as the real consuming wait drops
            // the master regardless of outcome.
            if let Some(gate) = &self.release_on_wait {
                gate.release();
            }
            if let Some(signal) = &self.signal_on_wait {
                let _ = signal.send(());
            }
            self.result.clone()
        }
    }

    // ---- tests -----------------------------------------------------------

    /// The FIFO command worker executes write, resize, and kill commands in the
    /// exact order queued, flushing after every input, through the real command
    /// loop (not a parallel model).
    #[tokio::test]
    async fn pty_commands_execute_in_fifo_with_flush_after_each_input() {
        let target = FakeCommandTarget::builder().build();
        let log = target.log();
        let sink = RecordingSink::new();
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let handle = spawn_pty_command_worker(rx, Box::new(target), sink.clone());

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

    /// An effect that is not a write, resize, or kill is rejected with a typed
    /// error, and no command runs.
    #[tokio::test]
    async fn unexpected_effect_returns_typed_error_without_running_a_command() {
        let target = FakeCommandTarget::builder().build();
        let log = target.log();
        let sink = RecordingSink::new();
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let handle = spawn_pty_command_worker(rx, Box::new(target), sink.clone());

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
        assert!(log.ops().is_empty(), "no command ran");
        assert!(sink.kinds().is_empty(), "no pty event emitted");
    }

    /// Dropping the effect sender must not abandon queued commands: the worker
    /// drains every buffered command in order, then exits `Ok`.
    #[tokio::test]
    async fn dropping_sender_drains_queued_then_exits_ok() {
        let target = FakeCommandTarget::builder().build();
        let log = target.log();
        let sink = RecordingSink::new();
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

        let handle = spawn_pty_command_worker(rx, Box::new(target), sink.clone());

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
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let handle = spawn_pty_command_worker(rx, Box::new(target), sink);

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
        tokio::time::timeout(std::time::Duration::from_secs(5), done_rx)
            .await
            .expect("runtime responsive while command blocks")
            .expect("spawned task completed");

        gate.release();
        drop(tx);
        handle.await.unwrap().unwrap();
    }

    /// A write/flush failure emits exactly one payload-safe `PtyFailed` (naming
    /// the operation id, never the input bytes) and stops the worker before the
    /// later queued command runs.
    #[tokio::test]
    async fn write_failure_emits_one_pty_failed_and_stops() {
        let target = FakeCommandTarget::builder()
            .write_error("broken pipe")
            .build();
        let log = target.log();
        let sink = RecordingSink::new();
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let handle = spawn_pty_command_worker(rx, Box::new(target), sink.clone());

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
        // Exactly one PtyFailed, payload-safe: it names the operation but
        // carries no input bytes.
        assert_eq!(
            sink.failures(),
            vec!["pty input write failed (operation 1): broken pipe".to_string()]
        );
        // The later write never ran.
        assert_eq!(log.ops(), vec!["input:a".to_string()]);
    }

    /// A kill failure emits exactly one payload-safe `PtyFailed` and stops the
    /// worker before the later queued command runs.
    #[tokio::test]
    async fn kill_failure_emits_one_pty_failed_and_stops() {
        let target = FakeCommandTarget::builder()
            .kill_error("no such process")
            .build();
        let log = target.log();
        let sink = RecordingSink::new();
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let handle = spawn_pty_command_worker(rx, Box::new(target), sink.clone());

        tx.send(Effect::KillPty {
            operation_id: OperationId(1),
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
            Err(PtyAdapterError::Kill {
                operation_id: OperationId(1),
                cause: "no such process".to_string(),
            })
        );
        assert_eq!(
            sink.failures(),
            vec!["pty kill failed (operation 1): no such process".to_string()]
        );
        assert_eq!(log.ops(), vec!["kill".to_string()]);
    }

    /// The output/lifecycle bridge emits every output chunk in order and emits
    /// the final `PtyExited` only after every output is enqueued and the reader
    /// has reached EOF — even though the waiter returns first. The reader is
    /// gated after its two chunks (a Windows-like reader that can't EOF yet), so
    /// while the waiter is already done the exit is provably still withheld;
    /// releasing the gate lets the reader EOF and the exit land last.
    #[tokio::test]
    async fn output_precedes_exit_even_when_waiter_returns_first() {
        let reader_gate = Gate::new();
        let (reader_gated_tx, mut reader_gated_rx) = mpsc::unbounded_channel();
        let (waiter_done_tx, mut waiter_done_rx) = mpsc::unbounded_channel();

        let reader = FakeReader::new([
            ReadStep::Chunk(b"a".to_vec()),
            ReadStep::Chunk(b"b".to_vec()),
            ReadStep::Signal(reader_gated_tx),
            ReadStep::Gate(Arc::clone(&reader_gate)),
        ]);
        let waiter = FakeWaitTarget::builder()
            .exit_code(0)
            .signal_on_wait(waiter_done_tx)
            .build();
        let sink = RecordingSink::new();

        let handle = spawn_pty_lifecycle(Box::new(reader), Box::new(waiter), sink.clone());

        // Both chunks are emitted and the reader is now parked; the waiter has
        // already returned.
        reader_gated_rx
            .recv()
            .await
            .expect("reader gated after chunks");
        waiter_done_rx.recv().await.expect("waiter returned first");

        // Exit is withheld until the reader drains: only the two outputs so far.
        assert_eq!(
            sink.kinds(),
            vec![EventKind::PtyOutput, EventKind::PtyOutput]
        );
        assert_eq!(sink.outputs(), vec![b"a".to_vec(), b"b".to_vec()]);

        // Release the reader's EOF; the bridge joins it, then emits the exit.
        reader_gate.release();
        tokio::time::timeout(std::time::Duration::from_secs(5), handle)
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
    }

    /// The wait must run concurrently with the reader: the reader's EOF gate
    /// opens only when the waiter releases it (the master-drop analogue), so a
    /// sequential read-then-wait bridge would deadlock. A bounded timeout is the
    /// only anti-hang net; the concurrent bridge completes well within it.
    #[tokio::test]
    async fn waiter_runs_concurrently_with_reader_so_gated_eof_is_reached() {
        let eof_gate = Gate::new();
        let reader = FakeReader::new([
            ReadStep::Chunk(b"x".to_vec()),
            ReadStep::Gate(Arc::clone(&eof_gate)),
        ]);
        let waiter = FakeWaitTarget::builder()
            .exit_code(0)
            .release_on_wait(Arc::clone(&eof_gate))
            .build();
        let sink = RecordingSink::new();

        let handle = spawn_pty_lifecycle(Box::new(reader), Box::new(waiter), sink.clone());
        tokio::time::timeout(std::time::Duration::from_secs(5), handle)
            .await
            .expect("reader and waiter must run concurrently (no deadlock)")
            .unwrap()
            .unwrap();

        assert_eq!(sink.outputs(), vec![b"x".to_vec()]);
        assert_eq!(sink.exit_codes(), vec![0]);
        assert_eq!(
            sink.kinds(),
            vec![EventKind::PtyOutput, EventKind::PtyExited]
        );
    }

    /// A reader error after prior output emits that output, then exactly one
    /// `PtyFailed`, and never a `PtyExited` — even though the wait itself
    /// succeeds. The reader failure takes precedence.
    #[tokio::test]
    async fn reader_error_after_output_emits_failure_and_no_exit() {
        let reader = FakeReader::new([
            ReadStep::Chunk(b"a".to_vec()),
            ReadStep::Error("read boom".to_string()),
        ]);
        let waiter = FakeWaitTarget::builder().exit_code(0).build();
        let sink = RecordingSink::new();

        let handle = spawn_pty_lifecycle(Box::new(reader), Box::new(waiter), sink.clone());
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), handle)
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
    }

    /// A wait error still releases the reader's EOF gate (the master-drop
    /// analogue), so the reader's prior output drains first; then exactly one
    /// `PtyFailed` is emitted and no `PtyExited`.
    #[tokio::test]
    async fn wait_error_releases_reader_then_emits_failure_and_no_exit() {
        let eof_gate = Gate::new();
        let reader = FakeReader::new([
            ReadStep::Chunk(b"a".to_vec()),
            ReadStep::Gate(Arc::clone(&eof_gate)),
        ]);
        let waiter = FakeWaitTarget::builder()
            .wait_error("wait boom")
            .release_on_wait(Arc::clone(&eof_gate))
            .build();
        let sink = RecordingSink::new();

        let handle = spawn_pty_lifecycle(Box::new(reader), Box::new(waiter), sink.clone());
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), handle)
            .await
            .expect("no deadlock")
            .unwrap();

        assert_eq!(
            result,
            Err(PtyAdapterError::Wait {
                cause: "wait boom".to_string(),
            })
        );
        assert_eq!(sink.outputs(), vec![b"a".to_vec()]);
        assert_eq!(
            sink.failures(),
            vec!["pty wait failed: wait boom".to_string()]
        );
        assert!(sink.exit_codes().is_empty(), "no exit after a wait failure");
        assert_eq!(
            sink.kinds(),
            vec![EventKind::PtyOutput, EventKind::PtyFailed]
        );
    }

    /// A panic in the blocking reader thread is captured (not re-propagated by
    /// the scope): it emits exactly one `PtyFailed` and no `PtyExited`, and the
    /// bridge returns the typed `ReaderPanic` error rather than aborting.
    #[tokio::test]
    async fn reader_thread_panic_emits_failure_and_no_exit() {
        let reader = FakeReader::new([ReadStep::Panic]);
        let waiter = FakeWaitTarget::builder().exit_code(0).build();
        let sink = RecordingSink::new();

        let handle = spawn_pty_lifecycle(Box::new(reader), Box::new(waiter), sink.clone());
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), handle)
            .await
            .expect("no deadlock")
            .unwrap();

        assert_eq!(result, Err(PtyAdapterError::ReaderPanic));
        assert_eq!(
            sink.failures(),
            vec!["pty reader thread panicked".to_string()]
        );
        assert!(sink.outputs().is_empty());
        assert!(sink.exit_codes().is_empty(), "no exit after a reader panic");
    }

    /// A closed pty event lane surfaces an explicit error from the lifecycle
    /// bridge, without panicking, when the reader cannot deliver its output.
    #[tokio::test]
    async fn closed_event_lane_returns_error_without_panic() {
        let reader = FakeReader::new([ReadStep::Chunk(b"a".to_vec())]);
        let waiter = FakeWaitTarget::builder().exit_code(0).build();
        let sink = RecordingSink::closed();

        let handle = spawn_pty_lifecycle(Box::new(reader), Box::new(waiter), sink.clone());
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), handle)
            .await
            .expect("no deadlock")
            .unwrap();

        assert_eq!(result, Err(PtyAdapterError::EventLaneClosed));
        assert!(sink.kinds().is_empty(), "a closed lane records nothing");
    }

    /// The command worker surfaces a closed lane too: when a write fails but the
    /// `PtyFailed` cannot be delivered, it returns `EventLaneClosed` (not the
    /// underlying write error) and does not retry or hang.
    #[tokio::test]
    async fn command_worker_closed_lane_on_failure_returns_event_lane_closed() {
        let target = FakeCommandTarget::builder()
            .write_error("broken pipe")
            .build();
        let sink = RecordingSink::closed();
        let (tx, rx) = mpsc::channel::<Effect>(PTY_COMMAND_CAPACITY);
        let handle = spawn_pty_command_worker(rx, Box::new(target), sink.clone());

        tx.send(Effect::WritePty {
            operation_id: OperationId(1),
            bytes: b"a".to_vec(),
        })
        .await
        .unwrap();
        drop(tx);

        assert_eq!(handle.await.unwrap(), Err(PtyAdapterError::EventLaneClosed));
        assert!(sink.kinds().is_empty());
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
