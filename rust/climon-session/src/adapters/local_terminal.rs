//! Local-terminal adapter: the owned workers and platform setup that bridge the
//! process's real console to the actor engine, plus the raw/console-mode guard
//! that keeps the user's shell clean.
//!
//! Three concerns live here, each fully owned (no detached task or thread):
//!
//! - a **synchronous platform setup** ([`setup_local_terminal`]) the supervisor
//!   (a later task) calls *before* pty output or any adapter starts. It decides
//!   whether a real local output terminal is attached, reports the initial
//!   `(cols,rows)` size, installs the platform raw/console-mode guard, and spawns
//!   the cancellable input worker whenever stdin is interactive. Redirected
//!   stdout therefore remains unattached while preserving legacy stdin
//!   forwarding. A headless session or redirected stdin returns no worker and
//!   mutates no mode. The guard restores every mode it changed on `Drop`, so the
//!   launching shell is never left in raw mode.
//! - a **blocking FIFO console writer** ([`run_console_adapter`]) that drains the
//!   coordinator's console effect route directly, executes each
//!   [`Effect::WriteConsole`] as `write_all` then `flush`, and emits
//!   [`SessionEvent::ConsoleWriteCompleted`] **only after the flush** (or
//!   [`SessionEvent::ConsoleWriteFailed`] then stops on a write/flush error). It
//!   owns the one stdout writer on a single `spawn_blocking` worker so console
//!   I/O never blocks a Tokio runtime worker.
//! - a **cancellable input worker** ([`run_input_worker`]) that owns the local
//!   input source and emits [`SessionEvent::LocalInput`] chunks (4096 parity) on
//!   the control lane. Unix polls with a timeout; Windows pairs its native
//!   blocking VT-byte read with an owned synchronous-I/O interrupter. Idle stdin
//!   therefore remains cancellable and joinable on both platforms. EOF or
//!   cancellation exits cleanly, and a read failure is an isolated typed adapter
//!   error — never a synthesized `ShutdownRequested` or core failure.
//!
//! The domain state already filters local input (take-control / swallow /
//! forward), so the input worker forwards raw chunks and never duplicates that
//! logic. Terminal input/output bytes never enter an error, log, or trace.
//!
//! [`Effect::WriteConsole`]: crate::engine::effect::Effect::WriteConsole
//! [`SessionEvent::ConsoleWriteCompleted`]: crate::engine::event::SessionEvent::ConsoleWriteCompleted
//! [`SessionEvent::ConsoleWriteFailed`]: crate::engine::event::SessionEvent::ConsoleWriteFailed
//! [`SessionEvent::LocalInput`]: crate::engine::event::SessionEvent::LocalInput

// Every item below is exercised by this module's tests now and wired into the
// supervisor (Task 14) later, so — like the pty/metadata/ipc adapters it mirrors
// — the module carries a crate-staged `dead_code` allowance until that wiring
// lands.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::fmt;
use std::io::{self, Write};
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::task::{spawn_blocking, JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::engine::coordinator::ControlEventSender;
use crate::engine::effect::{Effect, OperationId};
use crate::engine::event::SessionEvent;

/// The largest chunk the input worker forwards per read, matching the legacy
/// host's 4096-byte stdin buffer so local-input framing is unchanged.
const INPUT_CHUNK: usize = 4096;

/// How long the input worker parks in a source poll before re-checking its
/// cancellation token. Bounds the cancellation latency of an idle stdin without
/// a busy loop.
const INPUT_POLL_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Default)]
struct Utf16InputBuffer {
    pending: VecDeque<u8>,
    high_surrogate: Option<u16>,
}

impl Utf16InputBuffer {
    fn push(&mut self, units: &[u16]) {
        let mut complete =
            Vec::with_capacity(units.len() + usize::from(self.high_surrogate.is_some()));
        if let Some(high) = self.high_surrogate.take() {
            complete.push(high);
        }
        complete.extend_from_slice(units);
        if complete
            .last()
            .is_some_and(|unit| (0xD800..=0xDBFF).contains(unit))
        {
            self.high_surrogate = complete.pop();
        }
        self.pending
            .extend(String::from_utf16_lossy(&complete).into_bytes());
    }

    fn take_chunk(&mut self, limit: usize) -> Vec<u8> {
        let take = limit.min(self.pending.len());
        self.pending.drain(..take).collect()
    }

    fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }
}

// ---- errors ------------------------------------------------------------

/// A failure that ends a local-terminal worker. Every variant is payload-free:
/// it names the failed operation (and, where useful, a payload-safe cause
/// string) but never terminal input or output bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LocalTerminalError {
    /// An effect other than [`Effect::WriteConsole`] reached the console route.
    /// Carries the offending variant's payload-free name.
    UnexpectedEffect(&'static str),
    /// The control event lane closed, so a local-terminal event could not be
    /// delivered. The worker reports this rather than exiting silently.
    EventLaneClosed,
    /// Writing the console (`write_all` or the following `flush`) failed. The
    /// matching [`SessionEvent::ConsoleWriteFailed`] has already been emitted;
    /// the worker stops.
    ConsoleWrite {
        operation_id: OperationId,
        cause: String,
    },
    /// Reading local input failed. Isolated to the input worker — it is **not**
    /// turned into a synthesized `ShutdownRequested` or a core failure.
    InputRead(String),
    /// Interrupting a platform blocking input read during teardown failed.
    InputInterrupt(String),
    /// The input worker's blocking task panicked; observed when the guard owner
    /// joins it.
    InputWorkerPanicked,
}

impl fmt::Display for LocalTerminalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LocalTerminalError::UnexpectedEffect(name) => {
                write!(
                    f,
                    "unexpected non-console effect on the console route: {name}"
                )
            }
            LocalTerminalError::EventLaneClosed => write!(
                f,
                "control event lane closed before a local-terminal event was delivered"
            ),
            LocalTerminalError::ConsoleWrite {
                operation_id,
                cause,
            } => write!(
                f,
                "console write failed (operation {}): {cause}",
                operation_id.0
            ),
            LocalTerminalError::InputRead(cause) => write!(f, "local input read failed: {cause}"),
            LocalTerminalError::InputInterrupt(cause) => {
                write!(f, "failed to interrupt local input read: {cause}")
            }
            LocalTerminalError::InputWorkerPanicked => write!(f, "local input worker panicked"),
        }
    }
}

impl std::error::Error for LocalTerminalError {}

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

/// Blocking delivery of control-lane local-terminal events (console
/// completion/failure, local input). Both workers run off the Tokio workers
/// (dedicated `spawn_blocking` tasks), so events are emitted with a blocking
/// call. Implemented for [`ControlEventSender`] in production; a closed lane is
/// reported as [`LocalTerminalError::EventLaneClosed`].
pub(crate) trait LocalTerminalEventSink: Send + 'static {
    /// Emits `event`, blocking for bounded capacity, or failing if the lane has
    /// closed.
    fn emit(&self, event: SessionEvent) -> Result<(), LocalTerminalError>;
}

impl LocalTerminalEventSink for ControlEventSender {
    fn emit(&self, event: SessionEvent) -> Result<(), LocalTerminalError> {
        // A local-terminal event is always a control-lane event, so `WrongLane`
        // is unreachable; treat either lane failure as a closed lane.
        self.blocking_send(event)
            .map_err(|_| LocalTerminalError::EventLaneClosed)
    }
}

// ---- console writer ----------------------------------------------------

/// The stdout writer the console worker owns. Kept behind a trait so tests can
/// record writes, gate the flush, and inject write/flush errors without touching
/// the real console. Errors are payload-free (they never contain the bytes).
pub(crate) trait ConsoleWriter: Send + 'static {
    /// Writes every byte of `bytes` (like [`Write::write_all`]).
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()>;

    /// Flushes buffered bytes (like [`Write::flush`]).
    fn flush(&mut self) -> io::Result<()>;
}

/// The production [`ConsoleWriter`]: owns the process stdout handle and locks it
/// for each write/flush (there is only ever one console worker, so the lock is
/// uncontended). Mirrors the legacy host's `write_local_stdout`.
pub(crate) struct StdoutConsoleWriter {
    stdout: io::Stdout,
}

impl StdoutConsoleWriter {
    /// Captures the process stdout handle.
    pub(crate) fn new() -> StdoutConsoleWriter {
        StdoutConsoleWriter {
            stdout: io::stdout(),
        }
    }
}

impl Default for StdoutConsoleWriter {
    fn default() -> Self {
        StdoutConsoleWriter::new()
    }
}

impl ConsoleWriter for StdoutConsoleWriter {
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        let mut lock = self.stdout.lock();
        lock.write_all(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut lock = self.stdout.lock();
        lock.flush()
    }
}

/// The internal representation of a console effect after it has been validated
/// off the route. Only [`Effect::WriteConsole`] is valid on the console route,
/// so there is a single variant; anything else is a typed
/// [`LocalTerminalError::UnexpectedEffect`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ConsoleCommand {
    Write {
        operation_id: OperationId,
        bytes: Vec<u8>,
    },
}

impl ConsoleCommand {
    /// Validates an effect off the console route, rejecting anything that is not
    /// a console write.
    fn from_effect(effect: Effect) -> Result<ConsoleCommand, LocalTerminalError> {
        match effect {
            Effect::WriteConsole {
                operation_id,
                bytes,
            } => Ok(ConsoleCommand::Write {
                operation_id,
                bytes,
            }),
            other => Err(LocalTerminalError::UnexpectedEffect(effect_variant_name(
                &other,
            ))),
        }
    }
}

/// Executes one console command: `write_all` then `flush`, and only after the
/// flush returns does it emit [`SessionEvent::ConsoleWriteCompleted`]. A
/// write/flush error instead emits exactly one
/// [`SessionEvent::ConsoleWriteFailed`] carrying the original operation id and
/// returns the typed [`LocalTerminalError::ConsoleWrite`] so the worker stops;
/// no completion is emitted. A closed lane surfaces as
/// [`LocalTerminalError::EventLaneClosed`].
fn write_console_command<W: ConsoleWriter, E: LocalTerminalEventSink>(
    writer: &mut W,
    command: ConsoleCommand,
    events: &E,
) -> Result<(), LocalTerminalError> {
    let ConsoleCommand::Write {
        operation_id,
        bytes,
    } = command;
    match writer.write_all(&bytes).and_then(|()| writer.flush()) {
        Ok(()) => {
            // Only after the flush has returned is the write observable.
            events.emit(SessionEvent::ConsoleWriteCompleted(operation_id))
        }
        Err(error) => {
            let cause = error.to_string();
            events.emit(SessionEvent::ConsoleWriteFailed {
                operation_id,
                error: cause.clone(),
            })?;
            Err(LocalTerminalError::ConsoleWrite {
                operation_id,
                cause,
            })
        }
    }
}

/// Runs the console adapter to completion: drain the console effect route in
/// FIFO order, validate each effect, and execute it on this blocking worker.
/// Returns `Ok(())` once the route closes and every already-queued command has
/// drained. A non-console effect stops the worker with
/// [`LocalTerminalError::UnexpectedEffect`] (no write is attempted); a
/// write/flush error or a closed lane stops it with the corresponding typed
/// error.
///
/// The whole loop runs on a blocking thread (via [`spawn_console_adapter`]), so
/// `blocking_recv`, the blocking writes, and the blocking emit never occupy a
/// Tokio worker.
fn run_console_adapter<W, E>(
    mut effects: mpsc::Receiver<Effect>,
    mut writer: W,
    events: E,
) -> Result<(), LocalTerminalError>
where
    W: ConsoleWriter,
    E: LocalTerminalEventSink,
{
    while let Some(effect) = effects.blocking_recv() {
        let command = ConsoleCommand::from_effect(effect)?;
        write_console_command(&mut writer, command, &events)?;
    }
    Ok(())
}

/// Spawns [`run_console_adapter`] on a dedicated blocking thread and returns its
/// owned handle. No task is detached; the supervisor (Task 14) owns and later
/// joins the returned handle.
pub(crate) fn spawn_console_adapter<W, E>(
    effects: mpsc::Receiver<Effect>,
    writer: W,
    events: E,
) -> JoinHandle<Result<(), LocalTerminalError>>
where
    W: ConsoleWriter,
    E: LocalTerminalEventSink,
{
    spawn_blocking(move || run_console_adapter(effects, writer, events))
}

// ---- input worker ------------------------------------------------------

/// The outcome of one [`LocalInputSource::poll`].
pub(crate) enum InputPoll {
    /// Bytes were read from the local input.
    Chunk(Vec<u8>),
    /// The poll timed out with no input; the worker re-checks cancellation.
    Idle,
    /// The input reached end-of-file; the worker exits cleanly.
    Eof,
}

/// The local input source the input worker owns. Kept behind a trait so tests
/// can script input/idle/EOF/error sequences without a real stdin. Each `poll`
/// either waits at most `timeout` or is paired with a platform interrupter so an
/// idle stdin never wedges a permanently-blocked, un-cancellable read.
pub(crate) trait LocalInputSource: Send + 'static {
    /// Waits up to `timeout` for input, then returns the read outcome. A
    /// payload-free `Err` string describes an unexpected read failure.
    fn poll(&mut self, timeout: Duration) -> Result<InputPoll, String>;
}

impl LocalInputSource for Box<dyn LocalInputSource> {
    fn poll(&mut self, timeout: Duration) -> Result<InputPoll, String> {
        (**self).poll(timeout)
    }
}

/// Runs the input worker to completion: poll the source with a timeout, emit any
/// read chunk as [`SessionEvent::LocalInput`], and re-check cancellation each
/// idle cycle. Returns `Ok(())` on EOF or cancellation; a read failure returns
/// the isolated [`LocalTerminalError::InputRead`] (never a synthesized
/// `ShutdownRequested`), and a closed lane returns
/// [`LocalTerminalError::EventLaneClosed`].
fn run_input_worker<S, E>(
    mut source: S,
    events: E,
    cancel: CancellationToken,
) -> Result<(), LocalTerminalError>
where
    S: LocalInputSource,
    E: LocalTerminalEventSink,
{
    while !cancel.is_cancelled() {
        match source.poll(INPUT_POLL_INTERVAL) {
            Ok(InputPoll::Chunk(bytes)) => {
                if !bytes.is_empty() {
                    events.emit(SessionEvent::LocalInput(bytes))?;
                }
            }
            Ok(InputPoll::Idle) => {}
            Ok(InputPoll::Eof) => return Ok(()),
            Err(_) if cancel.is_cancelled() => return Ok(()),
            Err(cause) => return Err(LocalTerminalError::InputRead(cause)),
        }
    }
    Ok(())
}

/// Spawns [`run_input_worker`] on a dedicated blocking thread and returns its
/// owned handle. No task is detached; the guard owner joins it on supervisor
/// instruction.
fn spawn_input_worker<S, E>(
    source: S,
    events: E,
    cancel: CancellationToken,
) -> JoinHandle<Result<(), LocalTerminalError>>
where
    S: LocalInputSource,
    E: LocalTerminalEventSink,
{
    spawn_blocking(move || run_input_worker(source, events, cancel))
}

// ---- platform setup ----------------------------------------------------

/// An owned guard over every terminal mode the setup changed. Its `Drop` impl
/// restores those modes, so the launching shell is never left in raw mode after
/// the session. A no-op guard (an unattached session) mutates and restores
/// nothing.
pub(crate) trait ModeGuard: Send {}

/// A platform-owned way to wake a blocking local-input read during teardown.
/// Unix polls with a bounded timeout and needs no interrupter; Windows uses this
/// to cancel the exact synchronous read issued by the input worker.
pub(crate) trait InputInterrupt: Send {
    fn interrupt(&self) -> Result<(), String>;
}

/// The no-op guard used for an unattached (headless or non-console) session: it
/// owns nothing and restores nothing on drop.
pub(crate) struct NoopModeGuard;

impl ModeGuard for NoopModeGuard {}

/// The result of a platform's synchronous mode configuration: the attachment
/// decision, the initial visible size, the owned mode guard, and — whenever
/// stdin is interactive — the local input source the worker will drain plus any
/// platform interrupter needed to wake a blocking read.
pub(crate) struct PlatformConfiguration {
    attached: bool,
    size: (u16, u16),
    guard: Box<dyn ModeGuard>,
    input: Option<Box<dyn LocalInputSource>>,
    input_interrupt: Option<Box<dyn InputInterrupt>>,
}

/// The synchronous platform mode configuration. Kept behind a trait so tests can
/// inject a fake platform (recording enable/restore and scripting input) without
/// touching real terminal modes. Production is [`RealTerminalPlatform`].
pub(crate) trait TerminalPlatform {
    /// Configures terminal modes for an attached session (mutating nothing when
    /// unattached), returning the attachment decision, size, guard, and input
    /// source. Called synchronously *before* any worker or pty output starts.
    fn configure(&self, headless: bool) -> PlatformConfiguration;
}

/// The owned local-terminal setup the supervisor holds: the attachment decision,
/// the initial size, the raw/console-mode guard (restored on teardown), and —
/// when stdin is interactive — the owned input worker handle. The guard owner
/// cancels and joins the worker via [`shutdown`](LocalTerminalSetup::shutdown),
/// then drops the guard so modes are restored only after the worker has stopped.
pub(crate) struct LocalTerminalSetup {
    pub(crate) attached: bool,
    pub(crate) size: (u16, u16),
    guard: Box<dyn ModeGuard>,
    input: Option<JoinHandle<Result<(), LocalTerminalError>>>,
    input_interrupt: Option<Box<dyn InputInterrupt>>,
    cancel: CancellationToken,
}

impl LocalTerminalSetup {
    /// Cancels and joins the input worker (if any), then drops the mode guard so
    /// every changed terminal mode is restored *after* the worker has stopped.
    /// Returns the worker's result; a cancelled join is a clean `Ok(())`.
    pub(crate) async fn shutdown(self) -> Result<(), LocalTerminalError> {
        self.cancel.cancel();
        let interrupt_result = self
            .input_interrupt
            .as_ref()
            .map(|interrupt| interrupt.interrupt())
            .transpose()
            .map_err(LocalTerminalError::InputInterrupt);
        let result = match self.input {
            Some(handle) => match handle.await {
                Ok(result) => result,
                Err(join_error) if join_error.is_cancelled() => Ok(()),
                Err(_) => Err(LocalTerminalError::InputWorkerPanicked),
            },
            None => Ok(()),
        };
        // Dropping the guard here restores modes only after the worker is joined.
        drop(self.guard);
        interrupt_result?;
        result
    }
}

/// Configures the real local terminal, spawning the input worker whenever stdin
/// is interactive, and returns the owned [`LocalTerminalSetup`]. This is the
/// synchronous entry point the supervisor calls before pty output starts.
pub(crate) fn setup_local_terminal<E: LocalTerminalEventSink>(
    headless: bool,
    events: E,
    cancel: CancellationToken,
) -> LocalTerminalSetup {
    setup_local_terminal_with(RealTerminalPlatform, headless, events, cancel)
}

/// Platform-agnostic setup core: configure modes, then spawn the cancellable
/// input worker whenever the platform supplied an interactive input source.
/// Enabling modes happens synchronously in [`TerminalPlatform::configure`]
/// *before* the worker is spawned, so no worker or console output can run before
/// the mode is in effect.
fn setup_local_terminal_with<P, E>(
    platform: P,
    headless: bool,
    events: E,
    cancel: CancellationToken,
) -> LocalTerminalSetup
where
    P: TerminalPlatform,
    E: LocalTerminalEventSink,
{
    let config = platform.configure(headless);
    let input = config
        .input
        .map(|source| spawn_input_worker(source, events, cancel.clone()));
    LocalTerminalSetup {
        attached: config.attached,
        size: config.size,
        guard: config.guard,
        input,
        input_interrupt: config.input_interrupt,
        cancel,
    }
}

/// Test-only: builds a [`LocalTerminalSetup`] whose input worker never returns
/// (it ignores both the cancellation token and its interrupter) so joining it
/// depends entirely on the caller's teardown deadline. The returned flag flips to
/// `true` when the mode guard is dropped, proving the terminal is still restored
/// even when the worker has to be abandoned at the deadline. Constructing the
/// setup requires access to the module-private fields, so it lives here beside
/// the type rather than in a downstream test module.
#[cfg(test)]
pub(crate) fn stuck_local_terminal_for_test(
    cancel: CancellationToken,
) -> (
    LocalTerminalSetup,
    std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// An input source that blocks forever, ignoring the poll timeout and
    /// cancellation — a read the deadline must abandon rather than join.
    struct StuckInput;
    impl LocalInputSource for StuckInput {
        fn poll(&mut self, _timeout: Duration) -> Result<InputPoll, String> {
            loop {
                std::thread::park();
            }
        }
    }

    /// An interrupter that cannot wake the stuck read.
    struct DeadInterrupt;
    impl InputInterrupt for DeadInterrupt {
        fn interrupt(&self) -> Result<(), String> {
            Ok(())
        }
    }

    /// A guard that records its restoration (drop) so tests can assert the
    /// terminal was restored despite the abandoned worker.
    struct RestoreFlagGuard {
        restored: Arc<AtomicBool>,
    }
    impl ModeGuard for RestoreFlagGuard {}
    impl Drop for RestoreFlagGuard {
        fn drop(&mut self) {
            self.restored.store(true, Ordering::SeqCst);
        }
    }

    /// The worker never emits, so the sink only needs to exist.
    struct DiscardSink;
    impl LocalTerminalEventSink for DiscardSink {
        fn emit(&self, _event: SessionEvent) -> Result<(), LocalTerminalError> {
            Ok(())
        }
    }

    let restored = Arc::new(AtomicBool::new(false));
    let input = spawn_input_worker(StuckInput, DiscardSink, cancel.clone());
    let setup = LocalTerminalSetup {
        attached: true,
        size: (80, 24),
        guard: Box::new(RestoreFlagGuard {
            restored: restored.clone(),
        }),
        input: Some(input),
        input_interrupt: Some(Box::new(DeadInterrupt)),
        cancel,
    };
    (setup, restored)
}

/// The production [`TerminalPlatform`]. The Unix and Windows implementations own
/// the platform mode setup that the legacy host performed inline; here they are
/// isolated behind the trait so the rest of the adapter is platform-agnostic and
/// deterministically testable.
pub(crate) struct RealTerminalPlatform;

#[cfg(unix)]
mod platform {
    use super::{
        InputPoll, LocalInputSource, ModeGuard, PlatformConfiguration, RealTerminalPlatform,
        TerminalPlatform, INPUT_CHUNK,
    };
    use std::io;
    use std::os::unix::io::RawFd;
    use std::time::Duration;

    use climon_pty::{terminal_size, RawMode};

    /// Owns the [`RawMode`] guard for the attached session's lifetime; dropping
    /// it restores the terminal's original termios.
    struct UnixModeGuard {
        _raw: RawMode,
    }

    impl ModeGuard for UnixModeGuard {}

    /// Reads local input from stdin. Each poll first `poll(2)`s the descriptor
    /// with a timeout so an idle stdin never wedges an un-cancellable read; a
    /// readable descriptor is read once (up to [`INPUT_CHUNK`] bytes).
    struct UnixStdinSource {
        fd: RawFd,
        buf: Vec<u8>,
    }

    impl UnixStdinSource {
        fn new() -> UnixStdinSource {
            UnixStdinSource {
                fd: libc::STDIN_FILENO,
                buf: vec![0u8; INPUT_CHUNK],
            }
        }
    }

    impl LocalInputSource for UnixStdinSource {
        fn poll(&mut self, timeout: Duration) -> Result<InputPoll, String> {
            let mut pfd = libc::pollfd {
                fd: self.fd,
                events: libc::POLLIN,
                revents: 0,
            };
            let timeout_ms = timeout.as_millis().min(i32::MAX as u128) as i32;
            // SAFETY: `pfd` is a single valid pollfd; `poll` only reads/writes it.
            let rc = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
            if rc < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    return Ok(InputPoll::Idle);
                }
                return Err(error.to_string());
            }
            if rc == 0 {
                return Ok(InputPoll::Idle);
            }
            // Readable or hung up: attempt a single read (a hangup reads as EOF).
            // SAFETY: `buf` is a valid, owned buffer of `buf.len()` bytes.
            let n = unsafe {
                libc::read(
                    self.fd,
                    self.buf.as_mut_ptr() as *mut libc::c_void,
                    self.buf.len(),
                )
            };
            if n < 0 {
                let error = io::Error::last_os_error();
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) {
                    return Ok(InputPoll::Idle);
                }
                return Err(error.to_string());
            }
            if n == 0 {
                return Ok(InputPoll::Eof);
            }
            Ok(InputPoll::Chunk(self.buf[..n as usize].to_vec()))
        }
    }

    impl TerminalPlatform for RealTerminalPlatform {
        fn configure(&self, headless: bool) -> PlatformConfiguration {
            let size = terminal_size(libc::STDIN_FILENO);
            let stdin_tty = unsafe { libc::isatty(libc::STDIN_FILENO) } == 1;
            let stdout_tty = unsafe { libc::isatty(libc::STDOUT_FILENO) } == 1;
            if headless || !stdin_tty {
                return PlatformConfiguration {
                    attached: false,
                    size,
                    guard: Box::new(super::NoopModeGuard),
                    input: None,
                    input_interrupt: None,
                };
            }
            // Preserve legacy redirected-output behavior: interactive stdin still
            // forwards input even when stdout is not a terminal.
            match RawMode::enable(libc::STDIN_FILENO) {
                Ok(raw) => PlatformConfiguration {
                    attached: stdout_tty,
                    size,
                    guard: Box::new(UnixModeGuard { _raw: raw }),
                    input: Some(Box::new(UnixStdinSource::new())),
                    input_interrupt: None,
                },
                Err(_) => PlatformConfiguration {
                    attached: stdout_tty,
                    size,
                    guard: Box::new(super::NoopModeGuard),
                    input: Some(Box::new(UnixStdinSource::new())),
                    input_interrupt: None,
                },
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::{
        InputInterrupt, InputPoll, LocalInputSource, ModeGuard, PlatformConfiguration,
        RealTerminalPlatform, TerminalPlatform, INPUT_CHUNK,
    };
    use std::io;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use climon_pty::terminal_size;
    use windows_sys::Win32::Foundation::{
        CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, INVALID_HANDLE_VALUE,
        WAIT_FAILED, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, ReadConsoleW, SetConsoleMode, ENABLE_ECHO_INPUT,
        ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT, ENABLE_VIRTUAL_TERMINAL_INPUT,
        ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentThread, WaitForSingleObject,
    };
    use windows_sys::Win32::System::IO::CancelSynchronousIo;

    /// Restores the console's input/output modes on drop, so the user's
    /// cmd.exe/PowerShell is never left in raw mode. Handles are stored as
    /// `isize` so the guard stays `Send` when moved into the owned setup.
    struct WindowsModeGuard {
        in_handle: isize,
        out_handle: isize,
        saved_in: u32,
        saved_out: u32,
        in_active: bool,
        out_active: bool,
    }

    impl ModeGuard for WindowsModeGuard {}

    impl Drop for WindowsModeGuard {
        fn drop(&mut self) {
            unsafe {
                if self.in_active {
                    SetConsoleMode(self.in_handle as HANDLE, self.saved_in);
                }
                if self.out_active {
                    SetConsoleMode(self.out_handle as HANDLE, self.saved_out);
                }
            }
        }
    }

    #[derive(Default)]
    struct WindowsReadState {
        thread_handle: isize,
        cancelled: bool,
        reading: bool,
        finished: bool,
    }

    struct WindowsReadControl {
        state: Mutex<WindowsReadState>,
    }

    impl WindowsReadControl {
        fn new() -> WindowsReadControl {
            WindowsReadControl {
                state: Mutex::new(WindowsReadState::default()),
            }
        }

        fn prepare_poll(&self) -> Result<bool, String> {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            if state.cancelled {
                return Ok(false);
            }
            if state.thread_handle == 0 {
                let mut handle: HANDLE = std::ptr::null_mut();
                let duplicated = unsafe {
                    DuplicateHandle(
                        GetCurrentProcess(),
                        GetCurrentThread(),
                        GetCurrentProcess(),
                        &mut handle,
                        0,
                        0,
                        DUPLICATE_SAME_ACCESS,
                    )
                };
                if duplicated == 0 {
                    return Err(io::Error::last_os_error().to_string());
                }
                state.thread_handle = handle as isize;
            }
            Ok(true)
        }

        fn begin_read(&self) -> Result<bool, String> {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            if state.cancelled {
                return Ok(false);
            }
            state.reading = true;
            Ok(true)
        }

        fn finish_read(&self) {
            if let Ok(mut state) = self.state.lock() {
                state.reading = false;
            }
        }

        fn finish_worker(&self) {
            if let Ok(mut state) = self.state.lock() {
                state.reading = false;
                state.finished = true;
                if state.thread_handle != 0 {
                    unsafe {
                        CloseHandle(state.thread_handle as HANDLE);
                    }
                    state.thread_handle = 0;
                }
            }
        }

        fn interrupt(&self) -> Result<(), String> {
            const ERROR_NOT_FOUND: i32 = 1168;
            const RETRY_WINDOW: Duration = Duration::from_secs(1);

            let deadline = Instant::now() + RETRY_WINDOW;
            loop {
                let mut state = self.state.lock().map_err(|error| error.to_string())?;
                state.cancelled = true;
                if state.finished || !state.reading {
                    return Ok(());
                }
                let cancelled = unsafe { CancelSynchronousIo(state.thread_handle as HANDLE) } != 0;
                if cancelled {
                    return Ok(());
                }
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_NOT_FOUND) {
                    return Err(error.to_string());
                }
                drop(state);
                if Instant::now() >= deadline {
                    return Err("timed out cancelling the console input read".to_string());
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }

    struct WindowsInputInterrupt {
        control: Arc<WindowsReadControl>,
    }

    impl InputInterrupt for WindowsInputInterrupt {
        fn interrupt(&self) -> Result<(), String> {
            self.control.interrupt()
        }
    }

    /// Reads the native VT byte stream from the Windows console. The paired
    /// [`WindowsInputInterrupt`] owns a duplicate of this worker thread's handle,
    /// allowing teardown to cancel a synchronous `ReadConsoleW` even when a
    /// non-character console record caused the handle to become signalled.
    struct WindowsStdinSource {
        handle: isize,
        wide_buf: Vec<u16>,
        utf8: super::Utf16InputBuffer,
        control: Arc<WindowsReadControl>,
    }

    impl WindowsStdinSource {
        fn new(handle: HANDLE, control: Arc<WindowsReadControl>) -> WindowsStdinSource {
            WindowsStdinSource {
                handle: handle as isize,
                wide_buf: vec![0u16; INPUT_CHUNK],
                utf8: super::Utf16InputBuffer::default(),
                control,
            }
        }
    }

    impl Drop for WindowsStdinSource {
        fn drop(&mut self) {
            self.control.finish_worker();
        }
    }

    impl LocalInputSource for WindowsStdinSource {
        fn poll(&mut self, timeout: Duration) -> Result<InputPoll, String> {
            if self.utf8.has_pending() {
                return Ok(InputPoll::Chunk(self.utf8.take_chunk(INPUT_CHUNK)));
            }
            if !self.control.prepare_poll()? {
                return Ok(InputPoll::Idle);
            }
            let timeout_ms = timeout.as_millis().min(u32::MAX as u128) as u32;
            // SAFETY: `handle` is the process console input handle for its lifetime.
            let wait = unsafe { WaitForSingleObject(self.handle as HANDLE, timeout_ms) };
            if wait == WAIT_FAILED {
                return Err(io::Error::last_os_error().to_string());
            }
            if wait != WAIT_OBJECT_0 {
                // Timed out (or an abandoned/other wake): re-check cancellation.
                return Ok(InputPoll::Idle);
            }
            if !self.control.begin_read()? {
                return Ok(InputPoll::Idle);
            }
            let mut read = 0;
            let read_result = unsafe {
                ReadConsoleW(
                    self.handle as HANDLE,
                    self.wide_buf.as_mut_ptr().cast(),
                    self.wide_buf.len() as u32,
                    &mut read,
                    std::ptr::null_mut(),
                )
            };
            let read_error = (read_result == 0).then(io::Error::last_os_error);
            self.control.finish_read();
            if let Some(error) = read_error {
                return if error.kind() == io::ErrorKind::Interrupted {
                    Ok(InputPoll::Idle)
                } else {
                    Err(error.to_string())
                };
            }
            if read == 0 {
                Ok(InputPoll::Eof)
            } else {
                self.utf8.push(&self.wide_buf[..read as usize]);
                Ok(InputPoll::Chunk(self.utf8.take_chunk(INPUT_CHUNK)))
            }
        }
    }

    fn is_valid(handle: HANDLE) -> bool {
        !handle.is_null() && handle != INVALID_HANDLE_VALUE
    }

    impl TerminalPlatform for RealTerminalPlatform {
        fn configure(&self, headless: bool) -> PlatformConfiguration {
            let unattached = |size| PlatformConfiguration {
                attached: false,
                size,
                guard: Box::new(super::NoopModeGuard),
                input: None,
                input_interrupt: None,
            };
            let size = terminal_size(std::ptr::null_mut());
            if headless {
                return unattached(size);
            }
            // SAFETY: every console call below validates its handle first and the
            // guard restores any mode it changes.
            unsafe {
                let in_handle = GetStdHandle(STD_INPUT_HANDLE);
                if !is_valid(in_handle) {
                    return unattached(size);
                }
                let mut saved_in: u32 = 0;
                // Fails when stdin is not a console (redirected): unattached.
                if GetConsoleMode(in_handle, &mut saved_in) == 0 {
                    return unattached(size);
                }
                let raw_in = (saved_in
                    & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT))
                    | ENABLE_VIRTUAL_TERMINAL_INPUT;
                if SetConsoleMode(in_handle, raw_in) == 0 {
                    return unattached(size);
                }

                // Best-effort VT output. A failure leaves the local output
                // unattached but must not disable stdin forwarding.
                let out_handle = GetStdHandle(STD_OUTPUT_HANDLE);
                let mut saved_out: u32 = 0;
                let out_active = is_valid(out_handle)
                    && GetConsoleMode(out_handle, &mut saved_out) != 0
                    && SetConsoleMode(out_handle, saved_out | ENABLE_VIRTUAL_TERMINAL_PROCESSING)
                        != 0;
                let guard = WindowsModeGuard {
                    in_handle: in_handle as isize,
                    out_handle: out_handle as isize,
                    saved_in,
                    saved_out,
                    in_active: true,
                    out_active,
                };
                let read_control = Arc::new(WindowsReadControl::new());
                PlatformConfiguration {
                    attached: out_active,
                    // Prime from the real console: the launcher's size is unix-only.
                    size: terminal_size(std::ptr::null_mut()),
                    guard: Box::new(guard),
                    input: Some(Box::new(WindowsStdinSource::new(
                        in_handle,
                        read_control.clone(),
                    ))),
                    input_interrupt: Some(Box::new(WindowsInputInterrupt {
                        control: read_control,
                    })),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    use tokio::sync::mpsc;
    use tokio::task::JoinHandle;
    use tokio_util::sync::CancellationToken;

    use super::{
        run_console_adapter, run_input_worker, setup_local_terminal_with, ConsoleCommand,
        ConsoleWriter, InputInterrupt, InputPoll, LocalInputSource, LocalTerminalError,
        LocalTerminalEventSink, ModeGuard, PlatformConfiguration, TerminalPlatform,
    };
    use crate::engine::effect::{Effect, OperationId};
    use crate::engine::event::SessionEvent;
    use crate::engine::CONSOLE_OUTPUT_CAPACITY;

    /// A bounded anti-hang net for the integrated tests. A correct
    /// implementation finishes well within it; a regression that hangs trips it
    /// deterministically.
    const ANTI_HANG: Duration = Duration::from_secs(5);

    // ---- fake console writer ---------------------------------------------

    /// A blocking gate: the writer parks in [`Gate::wait`] until a test calls
    /// [`Gate::release`], proving a call runs off the Tokio worker (and letting a
    /// test observe that a completion is emitted only *after* the flush).
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

    #[derive(Default)]
    struct RecordingWriterInner {
        bytes: Vec<u8>,
        flushes: usize,
        write_error: Option<String>,
        flush_error: Option<String>,
        flush_gate: Option<Arc<Gate>>,
        flush_started: Option<mpsc::UnboundedSender<()>>,
    }

    /// A [`ConsoleWriter`] that records every byte written and every flush, and
    /// can gate the flush or fail a write/flush. Clones share one state so a test
    /// inspects what the worker wrote. The recorded bytes exist only here; the
    /// production writer never renders console bytes into a string.
    #[derive(Clone, Default)]
    struct RecordingWriter {
        inner: Arc<Mutex<RecordingWriterInner>>,
    }

    impl RecordingWriter {
        fn bytes(&self) -> Vec<u8> {
            self.inner.lock().expect("writer poisoned").bytes.clone()
        }

        fn flushes(&self) -> usize {
            self.inner.lock().expect("writer poisoned").flushes
        }

        fn with_write_error(message: &str) -> RecordingWriter {
            let writer = RecordingWriter::default();
            writer.inner.lock().unwrap().write_error = Some(message.to_string());
            writer
        }

        fn with_flush_error(message: &str) -> RecordingWriter {
            let writer = RecordingWriter::default();
            writer.inner.lock().unwrap().flush_error = Some(message.to_string());
            writer
        }

        fn gate_flush(&self, gate: Arc<Gate>, started: mpsc::UnboundedSender<()>) {
            let mut inner = self.inner.lock().unwrap();
            inner.flush_gate = Some(gate);
            inner.flush_started = Some(started);
        }
    }

    impl ConsoleWriter for RecordingWriter {
        fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
            let mut inner = self.inner.lock().expect("writer poisoned");
            if let Some(message) = inner.write_error.clone() {
                return Err(std::io::Error::other(message));
            }
            inner.bytes.extend_from_slice(bytes);
            Ok(())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            let (gate, started, error) = {
                let inner = self.inner.lock().expect("writer poisoned");
                (
                    inner.flush_gate.clone(),
                    inner.flush_started.clone(),
                    inner.flush_error.clone(),
                )
            };
            if let Some(started) = started {
                let _ = started.send(());
            }
            if let Some(gate) = gate {
                gate.wait();
            }
            if let Some(message) = error {
                return Err(std::io::Error::other(message));
            }
            self.inner.lock().expect("writer poisoned").flushes += 1;
            Ok(())
        }
    }

    // ---- fake event sink -------------------------------------------------

    /// A [`LocalTerminalEventSink`] backed by a Tokio mpsc so async tests can
    /// `recv().await` emitted events; a `closed` flag simulates a closed control
    /// lane.
    #[derive(Clone)]
    struct MpscSink {
        tx: mpsc::Sender<SessionEvent>,
        closed: Arc<AtomicBool>,
    }

    impl LocalTerminalEventSink for MpscSink {
        fn emit(&self, event: SessionEvent) -> Result<(), LocalTerminalError> {
            if self.closed.load(Ordering::SeqCst) {
                return Err(LocalTerminalError::EventLaneClosed);
            }
            self.tx
                .blocking_send(event)
                .map_err(|_| LocalTerminalError::EventLaneClosed)
        }
    }

    fn sink() -> (MpscSink, mpsc::Receiver<SessionEvent>, Arc<AtomicBool>) {
        let (tx, rx) = mpsc::channel(CONSOLE_OUTPUT_CAPACITY);
        let closed = Arc::new(AtomicBool::new(false));
        (
            MpscSink {
                tx,
                closed: closed.clone(),
            },
            rx,
            closed,
        )
    }

    // ---- console command sender (test convenience) -----------------------

    /// A command-level sender for the console writer core: it converts a
    /// [`ConsoleCommand`] to its [`Effect::WriteConsole`] and forwards it onto
    /// the production effect route, so the RED test can drive the writer with
    /// commands while production still consumes `Effect` directly.
    struct ConsoleCommandSender {
        tx: mpsc::Sender<Effect>,
    }

    impl ConsoleCommandSender {
        async fn send(
            &self,
            command: ConsoleCommand,
        ) -> Result<(), mpsc::error::SendError<Effect>> {
            let ConsoleCommand::Write {
                operation_id,
                bytes,
            } = command;
            self.tx
                .send(Effect::WriteConsole {
                    operation_id,
                    bytes,
                })
                .await
        }
    }

    /// Spawns the blocking console writer over the given writer, wiring an mpsc
    /// event sink so a test can `recv().await` completion/failure events. Returns
    /// the command sender, the event receiver, and the owned worker handle.
    fn spawn_console_writer(
        writer: RecordingWriter,
    ) -> (
        ConsoleCommandSender,
        mpsc::Receiver<SessionEvent>,
        JoinHandle<Result<(), LocalTerminalError>>,
    ) {
        let (tx, rx) = mpsc::channel(CONSOLE_OUTPUT_CAPACITY);
        let (sink, events, _closed) = sink();
        let task = tokio::task::spawn_blocking(move || run_console_adapter(rx, writer, sink));
        (ConsoleCommandSender { tx }, events, task)
    }

    // ---- console tests ---------------------------------------------------

    // Step 1 (plan RED → GREEN): a completion is emitted after the flush.
    #[tokio::test]
    async fn console_adapter_reports_completion_after_flush() {
        let writer = RecordingWriter::default();
        let (tx, mut events, task) = spawn_console_writer(writer.clone());
        tx.send(ConsoleCommand::Write {
            operation_id: OperationId(4),
            bytes: b"screen".to_vec(),
        })
        .await
        .unwrap();
        assert!(matches!(
            events.recv().await,
            Some(SessionEvent::ConsoleWriteCompleted(OperationId(4)))
        ));
        assert_eq!(writer.bytes(), b"screen");
        task.abort();
    }

    // Step 2: FIFO writes, completion ids exact and in order.
    #[tokio::test]
    async fn console_writes_are_fifo_with_exact_completion_ids() {
        let writer = RecordingWriter::default();
        let (tx, mut events, task) = spawn_console_writer(writer.clone());
        for (id, chunk) in [(1u64, &b"a"[..]), (2, b"bb"), (3, b"ccc")] {
            tx.send(ConsoleCommand::Write {
                operation_id: OperationId(id),
                bytes: chunk.to_vec(),
            })
            .await
            .unwrap();
        }
        let mut completions = Vec::new();
        for _ in 0..3 {
            match events.recv().await {
                Some(SessionEvent::ConsoleWriteCompleted(op)) => completions.push(op.0),
                other => panic!("unexpected event: {other:?}"),
            }
        }
        assert_eq!(completions, vec![1, 2, 3]);
        assert_eq!(writer.bytes(), b"abbccc");
        drop(tx);
        tokio::time::timeout(ANTI_HANG, task)
            .await
            .expect("worker join timed out")
            .expect("worker task panicked")
            .expect("worker returned an error");
    }

    // Step 2 (flush gating): the completion is emitted only *after* the flush.
    #[tokio::test]
    async fn console_completion_waits_for_flush() {
        let writer = RecordingWriter::default();
        let gate = Gate::new();
        let (flush_started_tx, mut flush_started_rx) = mpsc::unbounded_channel();
        writer.gate_flush(gate.clone(), flush_started_tx);
        let (tx, mut events, task) = spawn_console_writer(writer.clone());
        tx.send(ConsoleCommand::Write {
            operation_id: OperationId(7),
            bytes: b"data".to_vec(),
        })
        .await
        .unwrap();
        // The write happened and the flush has started but is gated open.
        tokio::time::timeout(ANTI_HANG, flush_started_rx.recv())
            .await
            .expect("flush never started")
            .expect("flush-start channel closed");
        assert_eq!(writer.bytes(), b"data");
        assert!(
            matches!(events.try_recv(), Err(mpsc::error::TryRecvError::Empty)),
            "completion emitted before the flush returned"
        );
        // Releasing the flush lets the completion be emitted.
        gate.release();
        assert!(matches!(
            tokio::time::timeout(ANTI_HANG, events.recv())
                .await
                .expect("completion timed out"),
            Some(SessionEvent::ConsoleWriteCompleted(OperationId(7)))
        ));
        drop(tx);
        let _ = task.await;
    }

    // Step 3: a write error emits one failure with the original id and stops.
    #[tokio::test]
    async fn console_write_error_emits_failure_and_stops() {
        let writer = RecordingWriter::with_write_error("disk full");
        let (tx, mut events, task) = spawn_console_writer(writer);
        tx.send(ConsoleCommand::Write {
            operation_id: OperationId(9),
            bytes: b"x".to_vec(),
        })
        .await
        .unwrap();
        match events.recv().await {
            Some(SessionEvent::ConsoleWriteFailed {
                operation_id,
                error,
            }) => {
                assert_eq!(operation_id, OperationId(9));
                assert!(error.contains("disk full"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
        // No completion follows, and the worker stops with the typed error.
        assert!(events.recv().await.is_none());
        let result = tokio::time::timeout(ANTI_HANG, task)
            .await
            .expect("join timed out")
            .expect("task panicked");
        assert!(matches!(
            result,
            Err(LocalTerminalError::ConsoleWrite {
                operation_id: OperationId(9),
                ..
            })
        ));
    }

    // Step 3: a flush error likewise emits one failure and stops.
    #[tokio::test]
    async fn console_flush_error_emits_failure_and_stops() {
        let writer = RecordingWriter::with_flush_error("pipe broken");
        let (tx, mut events, task) = spawn_console_writer(writer.clone());
        tx.send(ConsoleCommand::Write {
            operation_id: OperationId(11),
            bytes: b"y".to_vec(),
        })
        .await
        .unwrap();
        match events.recv().await {
            Some(SessionEvent::ConsoleWriteFailed {
                operation_id,
                error,
            }) => {
                assert_eq!(operation_id, OperationId(11));
                assert!(error.contains("pipe broken"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
        assert!(events.recv().await.is_none());
        // The bytes were written even though the flush failed; no completion.
        assert_eq!(writer.bytes(), b"y");
        assert_eq!(writer.flushes(), 0);
        let result = tokio::time::timeout(ANTI_HANG, task)
            .await
            .expect("join timed out")
            .expect("task panicked");
        assert!(matches!(
            result,
            Err(LocalTerminalError::ConsoleWrite {
                operation_id: OperationId(11),
                ..
            })
        ));
    }

    // Step 4: dropping the effect route drains queued writes, then the worker
    // joins cleanly.
    #[tokio::test]
    async fn console_route_close_drains_then_joins() {
        let writer = RecordingWriter::default();
        let (effects_tx, effects_rx) = mpsc::channel(CONSOLE_OUTPUT_CAPACITY);
        let (sink, mut events, _closed) = sink();
        let recorder = writer.clone();
        let task =
            tokio::task::spawn_blocking(move || run_console_adapter(effects_rx, recorder, sink));
        for id in 1..=4u64 {
            effects_tx
                .send(Effect::WriteConsole {
                    operation_id: OperationId(id),
                    bytes: vec![b'z'; id as usize],
                })
                .await
                .unwrap();
        }
        // Close the route: the worker drains every buffered write, then exits.
        drop(effects_tx);
        let mut completed = Vec::new();
        while let Some(event) = events.recv().await {
            if let SessionEvent::ConsoleWriteCompleted(op) = event {
                completed.push(op.0);
            }
        }
        assert_eq!(completed, vec![1, 2, 3, 4]);
        assert_eq!(writer.bytes(), b"zzzzzzzzzz");
        tokio::time::timeout(ANTI_HANG, task)
            .await
            .expect("join timed out")
            .expect("task panicked")
            .expect("worker returned an error");
    }

    // Step 5: a non-console effect is a typed error, and no write is attempted.
    #[tokio::test]
    async fn console_unexpected_effect_is_typed_error_without_write() {
        let writer = RecordingWriter::default();
        let (effects_tx, effects_rx) = mpsc::channel(CONSOLE_OUTPUT_CAPACITY);
        let (sink, mut events, _closed) = sink();
        let recorder = writer.clone();
        let task =
            tokio::task::spawn_blocking(move || run_console_adapter(effects_rx, recorder, sink));
        effects_tx
            .send(Effect::KillPty {
                operation_id: OperationId(1),
            })
            .await
            .unwrap();
        let result = tokio::time::timeout(ANTI_HANG, task)
            .await
            .expect("join timed out")
            .expect("task panicked");
        assert_eq!(result, Err(LocalTerminalError::UnexpectedEffect("KillPty")));
        assert!(writer.bytes().is_empty());
        assert!(matches!(
            events.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        ));
    }

    // Step 6: a closed control lane after a completed operation is a typed error.
    #[tokio::test]
    async fn console_closed_lane_is_typed_error_after_operation() {
        let writer = RecordingWriter::default();
        let (effects_tx, effects_rx) = mpsc::channel(CONSOLE_OUTPUT_CAPACITY);
        let (sink, _events, closed) = sink();
        closed.store(true, Ordering::SeqCst);
        let recorder = writer.clone();
        let task =
            tokio::task::spawn_blocking(move || run_console_adapter(effects_rx, recorder, sink));
        effects_tx
            .send(Effect::WriteConsole {
                operation_id: OperationId(3),
                bytes: b"paint".to_vec(),
            })
            .await
            .unwrap();
        let result = tokio::time::timeout(ANTI_HANG, task)
            .await
            .expect("join timed out")
            .expect("task panicked");
        assert_eq!(result, Err(LocalTerminalError::EventLaneClosed));
        // The operation was performed before the emit found the lane closed.
        assert_eq!(writer.bytes(), b"paint");
    }

    // Step 7: the blocking writer does not block the Tokio runtime — a
    // concurrent async task makes progress while the writer is parked in flush.
    #[tokio::test]
    async fn console_writer_does_not_block_runtime() {
        let writer = RecordingWriter::default();
        let gate = Gate::new();
        let (flush_started_tx, mut flush_started_rx) = mpsc::unbounded_channel();
        writer.gate_flush(gate.clone(), flush_started_tx);
        let (tx, mut events, task) = spawn_console_writer(writer);
        tx.send(ConsoleCommand::Write {
            operation_id: OperationId(1),
            bytes: b"q".to_vec(),
        })
        .await
        .unwrap();
        tokio::time::timeout(ANTI_HANG, flush_started_rx.recv())
            .await
            .expect("flush never started")
            .expect("flush-start channel closed");
        // While the blocking worker is parked in flush, an independent async task
        // still runs to completion (it could not if the runtime were blocked).
        let (done_tx, done_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            let _ = done_tx.send(());
        });
        tokio::time::timeout(ANTI_HANG, {
            let mut done_rx = done_rx;
            async move { done_rx.recv().await }
        })
        .await
        .expect("runtime was blocked by the console worker")
        .expect("concurrent task channel closed");
        gate.release();
        assert!(matches!(
            events.recv().await,
            Some(SessionEvent::ConsoleWriteCompleted(OperationId(1)))
        ));
        drop(tx);
        let _ = task.await;
    }

    // ---- fake input source -----------------------------------------------

    /// A scripted step for a [`LocalInputSource`].
    enum InputStep {
        Chunk(Vec<u8>),
        Idle,
        Eof,
        Error(String),
    }

    /// A sentinel that flips a shared flag on drop, proving the worker actually
    /// ran to completion and released its owned source (not detached).
    struct DropSentinel {
        dropped: Arc<AtomicBool>,
    }

    impl Drop for DropSentinel {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    /// A [`LocalInputSource`] that plays a scripted sequence, then blocks on a
    /// cancellation token (returning `Idle` each poll) so the worker stays alive
    /// until cancelled. It records each poll so tests can assert ordering.
    struct ScriptedInputSource {
        steps: std::collections::VecDeque<InputStep>,
        polls: Arc<AtomicUsize>,
        on_first_poll: Option<Box<dyn FnOnce() + Send>>,
        _sentinel: DropSentinel,
    }

    impl ScriptedInputSource {
        fn new(
            steps: impl IntoIterator<Item = InputStep>,
            dropped: Arc<AtomicBool>,
        ) -> ScriptedInputSource {
            ScriptedInputSource {
                steps: steps.into_iter().collect(),
                polls: Arc::new(AtomicUsize::new(0)),
                on_first_poll: None,
                _sentinel: DropSentinel { dropped },
            }
        }
    }

    impl LocalInputSource for ScriptedInputSource {
        fn poll(&mut self, timeout: Duration) -> Result<InputPoll, String> {
            if self.polls.fetch_add(1, Ordering::SeqCst) == 0 {
                if let Some(hook) = self.on_first_poll.take() {
                    hook();
                }
            }
            match self.steps.pop_front() {
                Some(InputStep::Chunk(bytes)) => Ok(InputPoll::Chunk(bytes)),
                Some(InputStep::Idle) => Ok(InputPoll::Idle),
                Some(InputStep::Eof) => Ok(InputPoll::Eof),
                Some(InputStep::Error(cause)) => Err(cause),
                // Script exhausted: idle (honouring the timeout) so the worker
                // keeps polling and observes cancellation promptly.
                None => {
                    std::thread::sleep(timeout.min(Duration::from_millis(5)));
                    Ok(InputPoll::Idle)
                }
            }
        }
    }

    // ---- input tests -----------------------------------------------------

    // Step 8: the input worker emits chunks in exact order, then EOF exits.
    #[tokio::test]
    async fn input_worker_emits_chunks_then_exits_on_eof() {
        let dropped = Arc::new(AtomicBool::new(false));
        let source = ScriptedInputSource::new(
            [
                InputStep::Chunk(b"hi".to_vec()),
                InputStep::Idle,
                InputStep::Chunk(b"there".to_vec()),
                InputStep::Eof,
            ],
            dropped.clone(),
        );
        let (sink, mut events, _closed) = sink();
        let cancel = CancellationToken::new();
        let task = tokio::task::spawn_blocking(move || run_input_worker(source, sink, cancel));
        let mut chunks = Vec::new();
        while let Some(event) = events.recv().await {
            if let SessionEvent::LocalInput(bytes) = event {
                chunks.push(bytes);
            }
        }
        assert_eq!(chunks, vec![b"hi".to_vec(), b"there".to_vec()]);
        tokio::time::timeout(ANTI_HANG, task)
            .await
            .expect("join timed out")
            .expect("task panicked")
            .expect("worker returned an error");
        assert!(dropped.load(Ordering::SeqCst), "source was not dropped");
    }

    // Step 8: cancellation exits the worker cleanly (no fake ShutdownRequested).
    #[tokio::test]
    async fn input_worker_exits_on_cancel() {
        let dropped = Arc::new(AtomicBool::new(false));
        let source = ScriptedInputSource::new([InputStep::Chunk(b"a".to_vec())], dropped.clone());
        let (sink, mut events, _closed) = sink();
        let cancel = CancellationToken::new();
        let task = tokio::task::spawn_blocking({
            let cancel = cancel.clone();
            move || run_input_worker(source, sink, cancel)
        });
        // The scripted chunk arrives first, proving the worker is running.
        assert!(matches!(
            tokio::time::timeout(ANTI_HANG, events.recv())
                .await
                .expect("input timed out"),
            Some(SessionEvent::LocalInput(_))
        ));
        cancel.cancel();
        tokio::time::timeout(ANTI_HANG, task)
            .await
            .expect("join timed out")
            .expect("task panicked")
            .expect("worker returned an error");
        assert!(dropped.load(Ordering::SeqCst));
    }

    // Step 8: a read failure is an isolated typed error, never ShutdownRequested.
    #[tokio::test]
    async fn input_worker_read_error_is_typed_not_shutdown() {
        let dropped = Arc::new(AtomicBool::new(false));
        let source = ScriptedInputSource::new(
            [
                InputStep::Chunk(b"ok".to_vec()),
                InputStep::Error("stdin exploded".to_string()),
            ],
            dropped.clone(),
        );
        let (sink, mut events, _closed) = sink();
        let cancel = CancellationToken::new();
        let task = tokio::task::spawn_blocking(move || run_input_worker(source, sink, cancel));
        // The first chunk is delivered; the error then stops the worker.
        assert!(matches!(
            events.recv().await,
            Some(SessionEvent::LocalInput(_))
        ));
        let result = tokio::time::timeout(ANTI_HANG, task)
            .await
            .expect("join timed out")
            .expect("task panicked");
        assert!(
            matches!(result, Err(LocalTerminalError::InputRead(cause)) if cause.contains("stdin exploded"))
        );
        // Crucially, no ShutdownRequested was synthesized from a read failure.
        assert!(!matches!(
            events.try_recv(),
            Ok(SessionEvent::ShutdownRequested)
        ));
        assert!(dropped.load(Ordering::SeqCst));
    }

    // ---- fake platform ---------------------------------------------------

    struct FakeModeGuard {
        log: Arc<Mutex<Vec<&'static str>>>,
    }

    impl ModeGuard for FakeModeGuard {}

    impl Drop for FakeModeGuard {
        fn drop(&mut self) {
            self.log.lock().unwrap().push("restored");
        }
    }

    struct BlockingInput {
        gate: Arc<(Mutex<bool>, Condvar)>,
        started: Arc<AtomicBool>,
    }

    impl LocalInputSource for BlockingInput {
        fn poll(&mut self, _timeout: Duration) -> Result<InputPoll, String> {
            self.started.store(true, Ordering::SeqCst);
            let (released, cvar) = &*self.gate;
            let mut released = released.lock().unwrap();
            while !*released {
                released = cvar.wait(released).unwrap();
            }
            Err("read cancelled".to_string())
        }
    }

    struct GateInterrupt {
        gate: Arc<(Mutex<bool>, Condvar)>,
        called: Arc<AtomicBool>,
    }

    impl InputInterrupt for GateInterrupt {
        fn interrupt(&self) -> Result<(), String> {
            self.called.store(true, Ordering::SeqCst);
            let (released, cvar) = &*self.gate;
            *released.lock().unwrap() = true;
            cvar.notify_all();
            Ok(())
        }
    }

    struct InterruptiblePlatform {
        gate: Arc<(Mutex<bool>, Condvar)>,
        started: Arc<AtomicBool>,
        interrupted: Arc<AtomicBool>,
    }

    impl TerminalPlatform for InterruptiblePlatform {
        fn configure(&self, _headless: bool) -> PlatformConfiguration {
            PlatformConfiguration {
                attached: true,
                size: (80, 24),
                guard: Box::new(super::NoopModeGuard),
                input: Some(Box::new(BlockingInput {
                    gate: self.gate.clone(),
                    started: self.started.clone(),
                })),
                input_interrupt: Some(Box::new(GateInterrupt {
                    gate: self.gate.clone(),
                    called: self.interrupted.clone(),
                })),
            }
        }
    }

    struct FakePlatform {
        attached: bool,
        size: (u16, u16),
        log: Arc<Mutex<Vec<&'static str>>>,
        input_dropped: Arc<AtomicBool>,
        input: Mutex<Option<ScriptedInputSource>>,
    }

    impl FakePlatform {
        fn attached(size: (u16, u16)) -> Arc<FakePlatform> {
            let log = Arc::new(Mutex::new(Vec::new()));
            let input_dropped = Arc::new(AtomicBool::new(false));
            let mut source =
                ScriptedInputSource::new([InputStep::Chunk(b"z".to_vec())], input_dropped.clone());
            let log_for_poll = log.clone();
            source.on_first_poll = Some(Box::new(move || {
                log_for_poll.lock().unwrap().push("polled");
            }));
            Arc::new(FakePlatform {
                attached: true,
                size,
                log,
                input_dropped,
                input: Mutex::new(Some(source)),
            })
        }

        fn unattached(size: (u16, u16)) -> Arc<FakePlatform> {
            Arc::new(FakePlatform {
                attached: false,
                size,
                log: Arc::new(Mutex::new(Vec::new())),
                input_dropped: Arc::new(AtomicBool::new(false)),
                input: Mutex::new(None),
            })
        }

        fn input_only(size: (u16, u16)) -> Arc<FakePlatform> {
            let log = Arc::new(Mutex::new(Vec::new()));
            let input_dropped = Arc::new(AtomicBool::new(false));
            let mut source =
                ScriptedInputSource::new([InputStep::Chunk(b"z".to_vec())], input_dropped.clone());
            let log_for_poll = log.clone();
            source.on_first_poll = Some(Box::new(move || {
                log_for_poll.lock().unwrap().push("polled");
            }));
            Arc::new(FakePlatform {
                attached: false,
                size,
                log,
                input_dropped,
                input: Mutex::new(Some(source)),
            })
        }

        fn log(&self) -> Vec<&'static str> {
            self.log.lock().unwrap().clone()
        }
    }

    impl TerminalPlatform for Arc<FakePlatform> {
        fn configure(&self, headless: bool) -> PlatformConfiguration {
            let has_input = self.input.lock().unwrap().is_some();
            if headless || (!self.attached && !has_input) {
                return PlatformConfiguration {
                    attached: false,
                    size: self.size,
                    guard: Box::new(super::NoopModeGuard),
                    input: None,
                    input_interrupt: None,
                };
            }
            // Mode is enabled synchronously, before any worker is spawned.
            self.log.lock().unwrap().push("enabled");
            let input = self
                .input
                .lock()
                .unwrap()
                .take()
                .map(|source| Box::new(source) as Box<dyn LocalInputSource>);
            PlatformConfiguration {
                attached: self.attached,
                size: self.size,
                guard: Box::new(FakeModeGuard {
                    log: self.log.clone(),
                }),
                input,
                input_interrupt: None,
            }
        }
    }

    // ---- setup tests -----------------------------------------------------

    // Step 9: an attached setup enables the mode before the worker runs, and
    // restores it only after teardown.
    #[tokio::test]
    async fn setup_enables_mode_before_worker_and_restores_after_teardown() {
        let platform = FakePlatform::attached((120, 40));
        let (event_sink, mut events, _closed) = sink();
        let cancel = CancellationToken::new();
        let setup = setup_local_terminal_with(platform.clone(), false, event_sink, cancel);
        assert!(setup.attached);
        assert_eq!(setup.size, (120, 40));
        assert!(setup.input.is_some(), "attached setup must spawn a worker");
        // The mode was enabled before the worker's first poll.
        assert_eq!(platform.log().first().copied(), Some("enabled"));
        // The worker is running: a scripted input chunk arrives.
        assert!(matches!(
            tokio::time::timeout(ANTI_HANG, events.recv())
                .await
                .expect("input timed out"),
            Some(SessionEvent::LocalInput(_))
        ));
        let log_after_start = platform.log();
        let enabled_at = log_after_start.iter().position(|entry| *entry == "enabled");
        let polled_at = log_after_start.iter().position(|entry| *entry == "polled");
        assert!(
            enabled_at < polled_at,
            "mode must be enabled before the worker polls: {log_after_start:?}"
        );
        // Teardown cancels+joins the worker, then restores the mode.
        tokio::time::timeout(ANTI_HANG, setup.shutdown())
            .await
            .expect("shutdown timed out")
            .expect("shutdown returned an error");
        assert!(platform.input_dropped.load(Ordering::SeqCst));
        assert_eq!(platform.log().last().copied(), Some("restored"));
    }

    // Step 9: a headless/unattached setup spawns no worker and mutates no mode.
    #[tokio::test]
    async fn setup_unattached_spawns_no_worker_and_mutates_nothing() {
        // Headless over an otherwise-attached platform: still unattached.
        let platform = FakePlatform::attached((80, 24));
        let (event_sink, _events, _closed) = sink();
        let cancel = CancellationToken::new();
        let setup = setup_local_terminal_with(platform.clone(), true, event_sink, cancel);
        assert!(!setup.attached);
        assert_eq!(setup.size, (80, 24));
        assert!(
            setup.input.is_none(),
            "unattached setup must not spawn a worker"
        );
        assert!(platform.log().is_empty(), "no mode was mutated");
        tokio::time::timeout(ANTI_HANG, setup.shutdown())
            .await
            .expect("shutdown timed out")
            .expect("shutdown returned an error");
        assert!(
            platform.log().is_empty(),
            "unattached teardown mutated a mode"
        );

        // A genuinely non-console platform is likewise unattached.
        let platform = FakePlatform::unattached((80, 24));
        let (event_sink, _events, _closed) = sink();
        let cancel = CancellationToken::new();
        let setup = setup_local_terminal_with(platform.clone(), false, event_sink, cancel);
        assert!(!setup.attached);
        assert!(setup.input.is_none());
        assert!(platform.log().is_empty());
        tokio::time::timeout(ANTI_HANG, setup.shutdown())
            .await
            .expect("shutdown timed out")
            .expect("shutdown");
    }

    #[tokio::test]
    async fn setup_forwards_input_when_stdout_is_redirected() {
        let platform = FakePlatform::input_only((80, 24));
        let (event_sink, mut events, _closed) = sink();
        let cancel = CancellationToken::new();
        let setup = setup_local_terminal_with(platform.clone(), false, event_sink, cancel);

        assert!(!setup.attached, "redirected stdout is not locally attached");
        assert!(
            setup.input.is_some(),
            "interactive stdin must still forward input"
        );
        assert!(matches!(
            tokio::time::timeout(ANTI_HANG, events.recv())
                .await
                .expect("input timed out"),
            Some(SessionEvent::LocalInput(bytes)) if bytes == b"z"
        ));

        tokio::time::timeout(ANTI_HANG, setup.shutdown())
            .await
            .expect("shutdown timed out")
            .expect("shutdown");
        assert!(platform.input_dropped.load(Ordering::SeqCst));
        assert_eq!(platform.log().last().copied(), Some("restored"));
    }

    #[tokio::test]
    async fn setup_interrupts_a_blocking_input_read_before_joining() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let started = Arc::new(AtomicBool::new(false));
        let interrupted = Arc::new(AtomicBool::new(false));
        let platform = InterruptiblePlatform {
            gate,
            started: started.clone(),
            interrupted: interrupted.clone(),
        };
        let (event_sink, _events, _closed) = sink();
        let setup =
            setup_local_terminal_with(platform, false, event_sink, CancellationToken::new());

        tokio::time::timeout(ANTI_HANG, async {
            while !started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("input read never started");

        tokio::time::timeout(ANTI_HANG, setup.shutdown())
            .await
            .expect("shutdown timed out")
            .expect("cancelled input read should exit cleanly");
        assert!(interrupted.load(Ordering::SeqCst));
    }

    #[test]
    fn windows_utf16_input_preserves_non_ascii_and_split_surrogates() {
        use super::Utf16InputBuffer;

        let mut input = Utf16InputBuffer::default();
        input.push(&['é' as u16, 0xD83D]);
        assert_eq!(input.take_chunk(4096), "é".as_bytes());

        input.push(&[0xDE00]);
        assert_eq!(input.take_chunk(4096), "😀".as_bytes());
    }

    #[test]
    fn windows_utf16_input_caps_forwarded_chunks_without_losing_bytes() {
        use super::Utf16InputBuffer;

        let mut input = Utf16InputBuffer::default();
        input.push(&vec!['é' as u16; 3_000]);

        let first = input.take_chunk(4096);
        let second = input.take_chunk(4096);
        assert_eq!(first.len(), 4096);
        assert_eq!(second.len(), 1904);
        assert_eq!([first, second].concat(), "é".repeat(3_000).as_bytes());
    }

    // Step 9 (platform smoke): the real platform is unattached under `cargo test`
    // (no controlling tty / captured stdio) and mutates nothing.
    #[tokio::test]
    async fn real_platform_is_unattached_when_headless() {
        use super::RealTerminalPlatform;
        let config = RealTerminalPlatform.configure(true);
        assert!(!config.attached);
        assert!(config.input.is_none());
    }
}
