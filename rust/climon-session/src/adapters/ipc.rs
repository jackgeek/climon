//! Isolated IPC adapter: the async manager and blocking per-connection workers
//! that own the session's [`SessionListener`] and every accepted
//! [`SessionStream`], translating client effects into real socket I/O and
//! feeding client lifecycle/frames back to the coordinator's control lane.
//!
//! It wraps — never replaces — the existing wire transport ([`SessionListener`]
//! / [`SessionStream`]) and frame codec ([`FrameDecoder`]). Ownership is split so
//! no socket handle is ever behind an `Arc<Mutex>` and no blocking call ever runs
//! on a Tokio worker:
//!
//! - A **listener bridge** owns the [`SessionListener`] on a blocking task. It
//!   sets non-blocking accept, polls a cancellation token (legacy 20 ms), and
//!   forwards every accepted stream over a bounded channel. `WouldBlock`
//!   continues until cancellation; a fatal accept error returns a typed
//!   [`IpcAdapterError`] and stops.
//! - One async **IPC manager** owns the logical connection map and a
//!   [`tokio::task::JoinSet`] of connection supervisors. It drains the
//!   coordinator's client effect route ([`EffectReceivers::client`]) directly,
//!   accepting only [`Effect::SendClient`] / [`Effect::CloseClient`] /
//!   [`Effect::StopAcceptingClients`]; any other effect is a typed error. For
//!   each accepted stream it allocates a monotonically increasing [`ClientId`],
//!   configures blocking mode + an exact five-second write timeout, clones
//!   read/write/shutdown handles, creates a per-client bounded outbound queue and
//!   cancellation token, starts a connection supervisor, and only then emits
//!   [`SessionEvent::ClientConnected`].
//! - Each **connection supervisor** owns and joins exactly one blocking
//!   reader/decoder task and one blocking writer task; neither is detached.
//!
//! ## First-wins terminal protocol
//! Every connection has one [`TerminalReporter`]: the first of the reader (peer
//! EOF), the writer (write failure), or the manager (full/closed outbound queue,
//! or an explicit close) to claim it decides the single terminal outcome, so
//! exactly one terminal event (or an intentional silent close) is produced even
//! when they race during teardown:
//!
//! - peer EOF / read failure → one [`SessionEvent::ClientDisconnected`];
//! - a write failure or a full/closed per-client queue → one
//!   [`SessionEvent::ClientSendFailed`] carrying the *original* operation id,
//!   then an immediate cancel + shutdown of only that client (the aggregate state
//!   removes and recomputes but emits no redundant close — the adapter owns
//!   teardown after a send failure);
//! - an explicit [`Effect::CloseClient`] claims the terminal *silently* and drops
//!   the outbound sender so the writer drains already-enqueued frames (e.g.
//!   `Exit`) in FIFO order before shutting the socket down — no redundant
//!   disconnect is emitted.
//!
//! A slow or wedged client can never block the manager, the coordinator, the pty
//! reader, or another client: sends use the per-client queue's non-blocking
//! `try_send`, and each connection's reader/writer run on their own blocking
//! threads. Terminal input/output bytes never enter an error, log, or debug
//! trace.
//!
//! [`SessionListener`]: crate::socket::SessionListener
//! [`SessionStream`]: crate::socket::SessionStream
//! [`FrameDecoder`]: climon_proto::frame::FrameDecoder
//! [`EffectReceivers::client`]: crate::engine::coordinator::EffectReceivers
//! [`Effect::SendClient`]: crate::engine::effect::Effect::SendClient
//! [`Effect::CloseClient`]: crate::engine::effect::Effect::CloseClient
//! [`Effect::StopAcceptingClients`]: crate::engine::effect::Effect::StopAcceptingClients

// Every item below is exercised by this module's tests now and wired into the
// supervisor (Task 14) later, so — like the pty/metadata adapters it mirrors —
// the module carries a crate-staged `dead_code` allowance until that wiring
// lands.
#![allow(dead_code)]

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::task::{spawn_blocking, JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use climon_proto::frame::FrameDecoder;

use crate::engine::coordinator::{ControlEventSender, LaneSendError};
use crate::engine::effect::{ClientId, Effect, OperationId};
use crate::engine::event::SessionEvent;
use crate::engine::CLIENT_OUTPUT_CAPACITY;
use crate::socket::{SessionListener, SessionStream};

/// The largest chunk a connection reader forwards per read, matching the legacy
/// host's reader buffer so decode behaviour is byte-for-byte unchanged.
const READ_CHUNK: usize = 65536;

/// Exact per-connection socket write timeout. A wedged client whose write blocks
/// for this long fails its write (and is isolated) rather than stalling forever.
/// Matches the legacy host's `WRITE_TIMEOUT`.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long the listener bridge parks between non-blocking `accept` polls, and
/// how long a writer parks in `recv_timeout` before re-checking its cancellation
/// token. Matches the legacy accept loop's 20 ms poll.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Bounded capacity of the accepted-stream channel between the listener bridge
/// and the manager. Connections arrive far slower than the manager installs
/// them, so a small bound is ample and applies backpressure to the bridge.
const ACCEPT_CHANNEL_CAPACITY: usize = 16;

// ---- errors ------------------------------------------------------------

/// Which blocking worker of a connection a failure originated in. Payload-free:
/// it names the side only, never any client frame, input, or output bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkerSide {
    /// The blocking reader/decoder task.
    Reader,
    /// The blocking writer task.
    Writer,
}

impl fmt::Display for WorkerSide {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WorkerSide::Reader => write!(f, "reader"),
            WorkerSide::Writer => write!(f, "writer"),
        }
    }
}

/// A failure that ends an ipc adapter worker. Every variant is payload-free: it
/// names the failed operation (and, where useful, a payload-safe cause string)
/// but never client frame, input, or output bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IpcAdapterError {
    /// An effect other than [`Effect::SendClient`] / [`Effect::CloseClient`] /
    /// [`Effect::StopAcceptingClients`] reached the client effect route. Carries
    /// the offending variant's payload-free name.
    UnexpectedEffect(&'static str),
    /// The control event lane closed, so a client event could not be delivered.
    /// The manager reports this rather than exiting silently.
    EventLaneClosed,
    /// A connection's blocking reader or writer task panicked. Payload-free: it
    /// names the side only. Surfaced by the connection supervisor after it has
    /// forced the counterpart worker down and joined it.
    WorkerPanicked(WorkerSide),
    /// The session listener could not be configured for non-blocking accept.
    ListenerConfig(String),
    /// The session listener's `accept` failed with a fatal (non-`WouldBlock`)
    /// error, so the bridge cannot continue.
    ListenerAccept(String),
    /// The listener bridge task panicked.
    ListenerPanicked,
}

impl fmt::Display for IpcAdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IpcAdapterError::UnexpectedEffect(name) => {
                write!(
                    f,
                    "unexpected non-client effect on the client route: {name}"
                )
            }
            IpcAdapterError::EventLaneClosed => write!(
                f,
                "control event lane closed before a client event was delivered"
            ),
            IpcAdapterError::WorkerPanicked(side) => {
                write!(f, "connection {side} worker panicked")
            }
            IpcAdapterError::ListenerConfig(cause) => {
                write!(f, "session listener configuration failed: {cause}")
            }
            IpcAdapterError::ListenerAccept(cause) => {
                write!(f, "session listener accept failed: {cause}")
            }
            IpcAdapterError::ListenerPanicked => write!(f, "session listener bridge panicked"),
        }
    }
}

impl std::error::Error for IpcAdapterError {}

/// Why one accepted stream could not be set up. Isolated to that stream (the
/// stream is shut down and the manager continues); surfaced as an internal
/// diagnostic rather than a daemon-wide failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ConnectionSetupError {
    /// Configuring blocking mode or the write timeout failed.
    Config(String),
    /// Cloning the read/write/shutdown handle failed.
    Clone(String),
}

impl fmt::Display for ConnectionSetupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConnectionSetupError::Config(cause) => {
                write!(f, "accepted stream configuration failed: {cause}")
            }
            ConnectionSetupError::Clone(cause) => {
                write!(f, "accepted stream handle clone failed: {cause}")
            }
        }
    }
}

impl std::error::Error for ConnectionSetupError {}

/// A payload-free name for an effect variant, used only to describe an
/// unexpected effect without carrying its client/terminal bytes.
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

/// Delivery of control-lane client events. The manager emits from async context
/// ([`emit`](ClientEventSink::emit)); the per-connection reader/writer run off
/// the Tokio workers and emit with a blocking call
/// ([`blocking_emit`](ClientEventSink::blocking_emit)). Implemented for
/// [`ControlEventSender`] in production; a closed lane is reported as
/// [`IpcAdapterError::EventLaneClosed`].
pub(crate) trait ClientEventSink: Clone + Send + 'static {
    /// Emits `event` from async context, resolving once it is accepted (awaiting
    /// bounded capacity) or failing if the lane has closed.
    fn emit(&self, event: SessionEvent)
        -> impl Future<Output = Result<(), IpcAdapterError>> + Send;

    /// Emits `event` from a blocking thread, blocking for bounded capacity or
    /// failing if the lane has closed.
    fn blocking_emit(&self, event: SessionEvent) -> Result<(), IpcAdapterError>;
}

impl ClientEventSink for ControlEventSender {
    // `async fn` cannot add the `+ Send` bound the spawned manager requires on
    // the returned future, so `emit` is desugared by hand (as in the metadata
    // adapter).
    #[allow(clippy::manual_async_fn)]
    fn emit(
        &self,
        event: SessionEvent,
    ) -> impl Future<Output = Result<(), IpcAdapterError>> + Send {
        async move { self.send(event).await.map_err(map_lane_error) }
    }

    fn blocking_emit(&self, event: SessionEvent) -> Result<(), IpcAdapterError> {
        self.blocking_send(event).map_err(map_lane_error)
    }
}

/// A client event is always a control-lane event, so `WrongLane` is unreachable;
/// treat either lane failure defensively as a closed lane.
fn map_lane_error(_error: LaneSendError) -> IpcAdapterError {
    IpcAdapterError::EventLaneClosed
}

// ---- per-connection terminal reporter ----------------------------------

/// A first-wins terminal claim shared by a connection's reader, writer, and the
/// manager. Exactly one claimant wins, so exactly one terminal event (or an
/// intentional silent close) is produced across a peer EOF, a write failure, a
/// full/closed outbound queue, and an explicit coordinator close — even when
/// they race during teardown.
pub(crate) struct TerminalReporter {
    claimed: AtomicBool,
}

impl TerminalReporter {
    fn new() -> TerminalReporter {
        TerminalReporter {
            claimed: AtomicBool::new(false),
        }
    }

    /// Attempts to claim the single terminal outcome. Returns `true` for the
    /// first caller only; every later caller gets `false` and must stay silent.
    fn claim(&self) -> bool {
        self.claimed
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Whether the terminal outcome has already been claimed (a stale connection
    /// the manager should stop sending to).
    fn is_claimed(&self) -> bool {
        self.claimed.load(Ordering::SeqCst)
    }
}

// ---- outbound frames ---------------------------------------------------

/// One enqueued outbound frame: the encoded bytes plus the operation id that
/// requested them, so a write failure can report the *original* operation.
struct OutboundFrame {
    operation_id: OperationId,
    bytes: Vec<u8>,
}

// ---- connection reader -------------------------------------------------

/// Runs a connection's blocking reader/decoder loop: read up to [`READ_CHUNK`]
/// bytes, feed the existing [`FrameDecoder`] (which skips unknown frame tags),
/// and emit one typed [`SessionEvent::ClientFrame`] per decoded frame in exact
/// order — split and coalesced reads alike. On peer EOF, a read error, or a
/// closed control lane it stops and, if it wins the first-wins claim, emits
/// exactly one [`SessionEvent::ClientDisconnected`], cancels the connection, and
/// shuts the socket down so the writer unblocks.
///
/// Returns `Ok(())` for a normal end (peer EOF / read failure successfully
/// reported, or a terminal already claimed by the writer/manager). If a
/// `blocking_emit` finds the control lane closed — for a decoded frame or for the
/// disconnect — it returns the typed [`IpcAdapterError::EventLaneClosed`] so the
/// supervisor and manager can surface it rather than swallowing it.
fn run_connection_reader<E: ClientEventSink>(
    mut stream: Box<dyn SessionStream>,
    client_id: ClientId,
    reporter: Arc<TerminalReporter>,
    cancel: CancellationToken,
    events: E,
) -> Result<(), IpcAdapterError> {
    let mut decoder = FrameDecoder::new();
    let mut buf = [0u8; READ_CHUNK];
    let mut fatal: Option<IpcAdapterError> = None;
    'read: loop {
        let n = match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for frame in decoder.push(&buf[..n]) {
            if let Err(error) = events.blocking_emit(SessionEvent::ClientFrame { client_id, frame })
            {
                // The control lane has closed; the manager surfaces that. Stop
                // reading and carry the typed error out instead of swallowing it.
                fatal = Some(error);
                break 'read;
            }
        }
    }
    // Peer EOF / read failure is a normal disconnect — but only if no writer/
    // manager terminal has already been claimed for this connection, and only if
    // the lane has not already closed under us.
    if fatal.is_none() && reporter.claim() {
        cancel.cancel();
        if let Err(error) = events.blocking_emit(SessionEvent::ClientDisconnected(client_id)) {
            fatal = Some(error);
        }
    }
    // Unblock a wedged writer (and idempotently close the socket).
    let _ = stream.shutdown_both();
    match fatal {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Spawns [`run_connection_reader`] on a dedicated blocking thread and returns
/// its owned handle. No task is detached; the connection supervisor owns and
/// joins the returned handle.
fn spawn_connection_reader<E: ClientEventSink>(
    stream: Box<dyn SessionStream>,
    client_id: ClientId,
    reporter: Arc<TerminalReporter>,
    cancel: CancellationToken,
    events: E,
) -> JoinHandle<Result<(), IpcAdapterError>> {
    spawn_blocking(move || run_connection_reader(stream, client_id, reporter, cancel, events))
}

// ---- connection writer -------------------------------------------------

/// Runs a connection's blocking writer loop: drain the per-client outbound queue
/// in FIFO order and `write_all` each frame (no flush — the legacy host never
/// flushed the socket), with the exact five-second write timeout already
/// configured on the stream. It parks in `recv_timeout` so it observes
/// cancellation promptly while idle. It always shuts both socket halves down
/// when the queue closes (graceful drain complete), cancellation is requested,
/// or a write fails. A write failure — and only a write failure — claims the
/// first-wins terminal and emits one [`SessionEvent::ClientSendFailed`] carrying
/// the failing frame's operation id.
///
/// Returns `Ok(())` for a normal end (a write failure successfully reported, an
/// intentional queue close/drain, or a cancellation). If the
/// `ClientSendFailed` `blocking_emit` finds the control lane closed it returns
/// the typed [`IpcAdapterError::EventLaneClosed`] so the supervisor and manager
/// can surface it rather than swallowing it.
fn run_connection_writer<E: ClientEventSink>(
    outbound: Receiver<OutboundFrame>,
    mut stream: Box<dyn SessionStream>,
    client_id: ClientId,
    reporter: Arc<TerminalReporter>,
    cancel: CancellationToken,
    events: E,
) -> Result<(), IpcAdapterError> {
    let mut fatal: Option<IpcAdapterError> = None;
    loop {
        if cancel.is_cancelled() {
            break;
        }
        match outbound.recv_timeout(POLL_INTERVAL) {
            Ok(frame) => {
                if stream.write_all(&frame.bytes).is_err() {
                    if reporter.claim() {
                        cancel.cancel();
                        if let Err(error) = events.blocking_emit(SessionEvent::ClientSendFailed {
                            client_id,
                            operation_id: frame.operation_id,
                        }) {
                            fatal = Some(error);
                        }
                    }
                    break;
                }
            }
            // Idle: re-check cancellation on the next iteration.
            Err(RecvTimeoutError::Timeout) => {}
            // Every sender dropped after the queue drained: a graceful close.
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = stream.shutdown_both();
    match fatal {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Spawns [`run_connection_writer`] on a dedicated blocking thread and returns
/// its owned handle. No task is detached; the connection supervisor owns and
/// joins the returned handle.
fn spawn_connection_writer<E: ClientEventSink>(
    outbound: Receiver<OutboundFrame>,
    stream: Box<dyn SessionStream>,
    client_id: ClientId,
    reporter: Arc<TerminalReporter>,
    cancel: CancellationToken,
    events: E,
) -> JoinHandle<Result<(), IpcAdapterError>> {
    spawn_blocking(move || {
        run_connection_writer(outbound, stream, client_id, reporter, cancel, events)
    })
}

// ---- connection supervisor ---------------------------------------------

/// Combines one joined worker into an optional fatal error, mapping a panic
/// (`JoinError`) to a payload-free [`IpcAdapterError::WorkerPanicked`] naming the
/// side. A worker that ended normally with `Ok(())` contributes no error; one
/// that carried out a typed [`IpcAdapterError`] (a closed lane) contributes it.
fn worker_outcome(
    side: WorkerSide,
    joined: Result<Result<(), IpcAdapterError>, tokio::task::JoinError>,
) -> Option<IpcAdapterError> {
    match joined {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error),
        Err(_join_error) => Some(IpcAdapterError::WorkerPanicked(side)),
    }
}

/// Owns exactly one reader and one writer blocking task for a connection and
/// joins both before returning the connection's [`ClientId`] to the manager
/// (which then reaps it from its map). Neither worker is detached.
///
/// Rather than await the reader then the writer sequentially — which lets a
/// worker that panics or exits abnormally (without shutting the socket down)
/// wedge its counterpart forever — the supervisor selects whichever worker
/// finishes first, then *always* cancels and force-shuts-down the connection via
/// its own dedicated `shutdown` clone so the counterpart cannot block. Only then
/// does it join the counterpart. The worker itself still shuts down on its
/// normal paths; this shutdown is idempotent safety.
///
/// The two outcomes are combined deterministically, first (to finish) fatal
/// wins: a closed lane ([`IpcAdapterError::EventLaneClosed`]) or a worker panic
/// ([`IpcAdapterError::WorkerPanicked`]) is surfaced to the manager after the
/// counterpart has been cleaned up, never ignored.
async fn run_connection_supervisor(
    client_id: ClientId,
    reader: JoinHandle<Result<(), IpcAdapterError>>,
    writer: JoinHandle<Result<(), IpcAdapterError>>,
    shutdown: Box<dyn SessionStream>,
    cancel: CancellationToken,
) -> Result<ClientId, IpcAdapterError> {
    let mut reader = reader;
    let mut writer = writer;

    let (first_side, first) = tokio::select! {
        joined = &mut reader => (WorkerSide::Reader, worker_outcome(WorkerSide::Reader, joined)),
        joined = &mut writer => (WorkerSide::Writer, worker_outcome(WorkerSide::Writer, joined)),
    };

    // A worker has finished (possibly by panicking without shutting down). Force
    // the connection down so the counterpart cannot block forever, then join it.
    cancel.cancel();
    let _ = shutdown.shutdown_both();

    let second = match first_side {
        WorkerSide::Reader => worker_outcome(WorkerSide::Writer, (&mut writer).await),
        WorkerSide::Writer => worker_outcome(WorkerSide::Reader, (&mut reader).await),
    };

    match first.or(second) {
        Some(error) => Err(error),
        None => Ok(client_id),
    }
}

// ---- listener bridge ---------------------------------------------------

/// Runs the blocking listener bridge: put the listener in non-blocking mode,
/// then loop accepting connections and forwarding each accepted stream onto the
/// manager's bounded async channel via `blocking_send`. It polls `cancel` every
/// [`POLL_INTERVAL`] on `WouldBlock`; a fatal (non-`WouldBlock`) accept error
/// stops it with a typed [`IpcAdapterError::ListenerAccept`]. Returns `Ok(())`
/// when cancelled or when the manager's receiver has gone.
fn run_listener_bridge(
    listener: SessionListener,
    accepted: mpsc::Sender<Box<dyn SessionStream>>,
    cancel: CancellationToken,
) -> Result<(), IpcAdapterError> {
    if let Err(error) = listener.set_nonblocking(true) {
        return Err(IpcAdapterError::ListenerConfig(error.to_string()));
    }
    loop {
        if cancel.is_cancelled() {
            return Ok(());
        }
        match listener.accept() {
            Ok(stream) => {
                // The manager applies bounded backpressure; if its receiver is
                // gone there is nowhere to deliver, so stop.
                if accepted.blocking_send(stream).is_err() {
                    return Ok(());
                }
            }
            Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(error) => return Err(IpcAdapterError::ListenerAccept(error.to_string())),
        }
    }
}

/// Spawns [`run_listener_bridge`] on a dedicated blocking thread and returns its
/// owned handle. No task is detached; the manager owns and later joins it.
fn spawn_listener_bridge(
    listener: SessionListener,
    accepted: mpsc::Sender<Box<dyn SessionStream>>,
    cancel: CancellationToken,
) -> JoinHandle<Result<(), IpcAdapterError>> {
    spawn_blocking(move || run_listener_bridge(listener, accepted, cancel))
}

// ---- manager -----------------------------------------------------------

/// The manager-side handle to one logical connection.
struct Connection {
    /// Non-blocking per-client outbound queue; the manager only ever `try_send`s.
    outbound: SyncSender<OutboundFrame>,
    /// Forced-teardown signal observed by the writer (and used to unblock the
    /// reader together with `shutdown`).
    cancel: CancellationToken,
    /// First-wins terminal claim shared with the reader and writer.
    reporter: Arc<TerminalReporter>,
    /// A clone used only to force `shutdown_both` on immediate isolation.
    shutdown: Box<dyn SessionStream>,
}

/// How the manager's event loop ended.
enum LoopOutcome {
    /// The client effect route closed: shut down gracefully and return `Ok`.
    RouteClosed,
    /// A fatal condition (unexpected effect, closed control lane, fatal listener
    /// error): clean up and return the typed error.
    Fatal(IpcAdapterError),
}

/// A supervisor's join outcome: the [`ClientId`] it managed, or a typed fatal it
/// surfaced ([`IpcAdapterError::EventLaneClosed`] or a
/// [`IpcAdapterError::WorkerPanicked`]) after cleaning up its counterpart.
type SupervisorResult = Result<ClientId, IpcAdapterError>;

/// A single arbitration result from the manager's `select!`.
// `Step::Effect` carries an [`Effect`], whose `PatchMetadata` payload dwarfs the
// other variants (the effect enum itself carries the same allowance). Boxing it
// would only obscure this transient, crate-private arbitration value that is
// matched on immediately, so the size difference is accepted here.
#[allow(clippy::large_enum_variant)]
enum Step {
    Reaped(Option<Result<SupervisorResult, tokio::task::JoinError>>),
    Effect(Option<Effect>),
    Accepted(Option<Box<dyn SessionStream>>),
}

/// Bounded diagnostics for isolated per-connection setup failures. A setup
/// failure is isolated (the stream is shut down) and never fails the manager, so
/// only an aggregate matters: how many have occurred and the most recent one.
/// This retains a fixed amount regardless of how many connections fail their
/// setup, rather than growing an unbounded `Vec`. No payload bytes are stored.
#[derive(Debug, Default)]
struct SetupDiagnostics {
    /// Total isolated setup failures observed.
    count: usize,
    /// The most recent failure (client id + payload-free cause), if any.
    last: Option<(ClientId, ConnectionSetupError)>,
}

impl SetupDiagnostics {
    /// Records one isolated setup failure: bump the count and retain it as the
    /// most recent, dropping any earlier one so storage stays bounded.
    fn record(&mut self, client_id: ClientId, error: ConnectionSetupError) {
        self.count += 1;
        self.last = Some((client_id, error));
    }
}

/// The async ipc manager's owned state (the [`JoinSet`] of supervisors is
/// threaded separately so it can be `select!`ed without borrowing the rest of
/// the manager).
struct IpcManager<E: ClientEventSink> {
    events: E,
    capacity: usize,
    connections: HashMap<ClientId, Connection>,
    next_id: u64,
    accepting_stopped: bool,
    accept_open: bool,
    listener_cancel: CancellationToken,
    listener_join: Option<JoinHandle<Result<(), IpcAdapterError>>>,
    /// Bounded diagnostics for isolated per-connection setup failures, retained
    /// as an internal aggregate rather than a daemon-wide failure.
    setup_failures: SetupDiagnostics,
}

impl<E: ClientEventSink> IpcManager<E> {
    /// Runs the arbitration loop until the effect route closes or a fatal
    /// condition occurs.
    async fn event_loop(
        &mut self,
        effects: &mut mpsc::Receiver<Effect>,
        accepted: &mut mpsc::Receiver<Box<dyn SessionStream>>,
        join_set: &mut JoinSet<SupervisorResult>,
    ) -> LoopOutcome {
        loop {
            let step = tokio::select! {
                reaped = join_set.join_next(), if !join_set.is_empty() => Step::Reaped(reaped),
                eff = effects.recv() => Step::Effect(eff),
                acc = accepted.recv(), if self.accept_open => Step::Accepted(acc),
            };
            match step {
                // A supervisor finished cleanly: reap its connection from the map.
                Step::Reaped(Some(Ok(Ok(client_id)))) => {
                    self.connections.remove(&client_id);
                }
                // A supervisor surfaced a fatal worker error (a closed control
                // lane, or a reader/writer panic) after cleaning up its
                // counterpart. Surface it rather than swallowing it; the owned
                // cleanup runs in `graceful_shutdown`.
                Step::Reaped(Some(Ok(Err(error)))) => return LoopOutcome::Fatal(error),
                // The supervisor task itself failed to join. It catches its
                // workers' panics and never panics itself, so this is not
                // expected; there is no live connection or client id to recover,
                // so continue and let the remaining supervisors be joined.
                Step::Reaped(Some(Err(_join_error))) => {}
                // `join_next` on an empty set: nothing to reap.
                Step::Reaped(None) => {}
                Step::Effect(Some(effect)) => {
                    if let Err(error) = self.handle_effect(effect).await {
                        return LoopOutcome::Fatal(error);
                    }
                }
                Step::Effect(None) => return LoopOutcome::RouteClosed,
                Step::Accepted(Some(stream)) => {
                    if let Err(error) = self.accept_connection(stream, join_set).await {
                        return LoopOutcome::Fatal(error);
                    }
                }
                Step::Accepted(None) => {
                    self.accept_open = false;
                    if let Some(join) = self.listener_join.take() {
                        match join.await {
                            Ok(Ok(())) => {}
                            Ok(Err(error)) => return LoopOutcome::Fatal(error),
                            Err(_panicked) => {
                                return LoopOutcome::Fatal(IpcAdapterError::ListenerPanicked)
                            }
                        }
                    }
                }
            }
        }
    }

    /// Executes one client effect. Anything other than the three client effects
    /// is a fatal [`IpcAdapterError::UnexpectedEffect`].
    async fn handle_effect(&mut self, effect: Effect) -> Result<(), IpcAdapterError> {
        match effect {
            Effect::SendClient {
                client_id,
                operation_id,
                bytes,
            } => self.send_client(client_id, operation_id, bytes).await,
            Effect::CloseClient { client_id } => {
                self.close_client(client_id);
                Ok(())
            }
            Effect::StopAcceptingClients => {
                self.stop_accepting();
                Ok(())
            }
            other => Err(IpcAdapterError::UnexpectedEffect(effect_variant_name(
                &other,
            ))),
        }
    }

    /// Enqueues one outbound frame with a non-blocking `try_send`. A missing or
    /// already-terminal client is dropped (the state removed it). A full or
    /// closed queue isolates only that client: first-wins
    /// [`SessionEvent::ClientSendFailed`] carrying the original operation id,
    /// then an immediate cancel + shutdown. Healthy clients are untouched.
    async fn send_client(
        &mut self,
        client_id: ClientId,
        operation_id: OperationId,
        bytes: Vec<u8>,
    ) -> Result<(), IpcAdapterError> {
        let overflowed = match self.connections.get(&client_id) {
            None => false,
            Some(connection) if connection.reporter.is_claimed() => false,
            Some(connection) => connection
                .outbound
                .try_send(OutboundFrame {
                    operation_id,
                    bytes,
                })
                .is_err(),
        };
        if !overflowed {
            return Ok(());
        }
        // `try_send` returned `Full`/`Disconnected`: take ownership and isolate.
        let connection = self
            .connections
            .remove(&client_id)
            .expect("connection present for the failed send");
        let result = if connection.reporter.claim() {
            self.events
                .emit(SessionEvent::ClientSendFailed {
                    client_id,
                    operation_id,
                })
                .await
        } else {
            Ok(())
        };
        connection.cancel.cancel();
        let _ = connection.shutdown.shutdown_both();
        result
    }

    /// Intentionally closes a client: claim the terminal *silently* (so the
    /// reader's eventual EOF emits no redundant disconnect) and drop the outbound
    /// sender so the writer drains already-enqueued frames (e.g. `Exit`) in FIFO
    /// order before shutting the socket down. No forced shutdown/cancel — queued
    /// frames must still be delivered.
    fn close_client(&mut self, client_id: ClientId) {
        if let Some(connection) = self.connections.remove(&client_id) {
            connection.reporter.claim();
            // Dropping `connection` drops its outbound sender (the writer then
            // drains + shuts down) without cancelling.
        }
    }

    /// Stops accepting new clients: cancel the listener bridge (idempotently) so
    /// later connections are rejected. Existing clients keep running. This does
    /// not block-join the bridge — that is reaped through the loop when the
    /// accepted channel closes.
    fn stop_accepting(&mut self) {
        if !self.accepting_stopped {
            self.accepting_stopped = true;
            self.listener_cancel.cancel();
        }
    }

    /// Sets up one accepted stream. Streams accepted after a stop are rejected
    /// (shut down). A setup failure is isolated (that stream is shut down and
    /// recorded) and never fails the manager. On success the connection's
    /// resources and supervisor are installed *before*
    /// [`SessionEvent::ClientConnected`] is emitted, so an immediate follow-up
    /// send always finds the queue.
    async fn accept_connection(
        &mut self,
        stream: Box<dyn SessionStream>,
        join_set: &mut JoinSet<SupervisorResult>,
    ) -> Result<(), IpcAdapterError> {
        if self.accepting_stopped {
            let _ = stream.shutdown_both();
            return Ok(());
        }
        let client_id = ClientId(self.next_id);
        self.next_id += 1;
        match self.install_connection(client_id, stream, join_set) {
            Ok(()) => {
                self.events
                    .emit(SessionEvent::ClientConnected(client_id))
                    .await
            }
            Err(diagnostic) => {
                self.setup_failures.record(client_id, diagnostic);
                Ok(())
            }
        }
    }

    /// Configures the accepted stream (blocking mode + exact five-second write
    /// timeout), clones its read/write/shutdown handles, builds the per-client
    /// bounded queue + cancellation token + terminal reporter, spawns the
    /// reader/writer and their supervisor, and records the connection. Any
    /// fallible step shuts the stream down and returns an isolated
    /// [`ConnectionSetupError`].
    ///
    /// Two independent shutdown clones are made: one the manager keeps
    /// ([`Connection::shutdown`]) to force-isolate a full/closed queue, and one
    /// the supervisor owns to force the connection down when the first worker
    /// finishes so the counterpart cannot block.
    fn install_connection(
        &mut self,
        client_id: ClientId,
        stream: Box<dyn SessionStream>,
        join_set: &mut JoinSet<SupervisorResult>,
    ) -> Result<(), ConnectionSetupError> {
        if let Err(error) = stream.set_nonblocking(false) {
            let _ = stream.shutdown_both();
            return Err(ConnectionSetupError::Config(error.to_string()));
        }
        if let Err(error) = stream.set_write_timeout(Some(WRITE_TIMEOUT)) {
            let _ = stream.shutdown_both();
            return Err(ConnectionSetupError::Config(error.to_string()));
        }
        let write_stream = match stream.try_clone_box() {
            Ok(clone) => clone,
            Err(error) => {
                let _ = stream.shutdown_both();
                return Err(ConnectionSetupError::Clone(error.to_string()));
            }
        };
        let manager_shutdown = match stream.try_clone_box() {
            Ok(clone) => clone,
            Err(error) => {
                let _ = stream.shutdown_both();
                return Err(ConnectionSetupError::Clone(error.to_string()));
            }
        };
        let supervisor_shutdown = match stream.try_clone_box() {
            Ok(clone) => clone,
            Err(error) => {
                let _ = stream.shutdown_both();
                return Err(ConnectionSetupError::Clone(error.to_string()));
            }
        };
        let read_stream = stream;

        let (outbound_tx, outbound_rx) = sync_channel::<OutboundFrame>(self.capacity);
        let cancel = CancellationToken::new();
        let reporter = Arc::new(TerminalReporter::new());

        let reader = spawn_connection_reader(
            read_stream,
            client_id,
            Arc::clone(&reporter),
            cancel.clone(),
            self.events.clone(),
        );
        let writer = spawn_connection_writer(
            outbound_rx,
            write_stream,
            client_id,
            Arc::clone(&reporter),
            cancel.clone(),
            self.events.clone(),
        );
        join_set.spawn(run_connection_supervisor(
            client_id,
            reader,
            writer,
            supervisor_shutdown,
            cancel.clone(),
        ));

        self.connections.insert(
            client_id,
            Connection {
                outbound: outbound_tx,
                cancel,
                reporter,
                shutdown: manager_shutdown,
            },
        );
        Ok(())
    }

    /// Gracefully closes every connection and joins every supervisor: stop
    /// accepting, reject any streams accepted-but-not-installed, drop each
    /// client's outbound sender (so its writer drains queued frames then shuts
    /// down) after a silent terminal claim, and join the [`JoinSet`].
    ///
    /// While joining, a supervisor may report a fatal worker error it discovered
    /// during its own cleanup (a closed control lane, or a worker panic). Those
    /// are reconciled here — the first fatal is returned so the manager surfaces
    /// it rather than silently returning `Ok` — while still joining *every*
    /// supervisor. Returns `None` when all connections closed cleanly.
    async fn graceful_shutdown(
        &mut self,
        accepted: &mut mpsc::Receiver<Box<dyn SessionStream>>,
        join_set: &mut JoinSet<SupervisorResult>,
    ) -> Option<IpcAdapterError> {
        self.stop_accepting();
        while let Ok(stream) = accepted.try_recv() {
            let _ = stream.shutdown_both();
        }
        for (_client_id, connection) in self.connections.drain() {
            connection.reporter.claim();
            // `connection` (its outbound sender) drops here: the writer drains
            // remaining frames in FIFO order, then shuts the socket down.
        }
        let mut fatal: Option<IpcAdapterError> = None;
        while let Some(reaped) = join_set.join_next().await {
            if let Ok(Err(error)) = reaped {
                // Keep the first fatal (a later panic/lane close during teardown
                // does not override it) but keep joining every supervisor.
                fatal.get_or_insert(error);
            }
        }
        fatal
    }
}

/// Runs the ipc manager to completion. Drains the client effect route, owns the
/// connection map and the connection-supervisor [`JoinSet`], and joins the
/// listener bridge. Returns `Ok(())` when the effect route closes (after a
/// graceful shutdown), or a typed [`IpcAdapterError`] — after the same owned
/// cleanup — on an unexpected effect, a closed control lane, or a fatal listener
/// error.
async fn run_ipc_manager<E: ClientEventSink>(
    mut effects: mpsc::Receiver<Effect>,
    mut accepted: mpsc::Receiver<Box<dyn SessionStream>>,
    listener_cancel: CancellationToken,
    listener_join: JoinHandle<Result<(), IpcAdapterError>>,
    events: E,
    capacity: usize,
) -> Result<(), IpcAdapterError> {
    let mut manager = IpcManager {
        events,
        capacity,
        connections: HashMap::new(),
        next_id: 0,
        accepting_stopped: false,
        accept_open: true,
        listener_cancel,
        listener_join: Some(listener_join),
        setup_failures: SetupDiagnostics::default(),
    };
    let mut join_set: JoinSet<SupervisorResult> = JoinSet::new();

    let outcome = manager
        .event_loop(&mut effects, &mut accepted, &mut join_set)
        .await;
    // Owned cleanup: join every supervisor, reconciling any fatal a supervisor
    // discovers during its teardown.
    let shutdown_error = manager
        .graceful_shutdown(&mut accepted, &mut join_set)
        .await;

    // Join the listener bridge, cancelling it first so it stops promptly.
    manager.listener_cancel.cancel();
    let bridge = match manager.listener_join.take() {
        Some(join) => match join.await {
            Ok(result) => result,
            Err(_panicked) => Err(IpcAdapterError::ListenerPanicked),
        },
        None => Ok(()),
    };

    match outcome {
        // The event loop already saw a fatal; it happened first, so it wins.
        LoopOutcome::Fatal(error) => Err(error),
        // The route closed cleanly: a worker fatal discovered while joining wins
        // over `Ok`, otherwise the bridge result stands.
        LoopOutcome::RouteClosed => match shutdown_error {
            Some(error) => Err(error),
            None => bridge,
        },
    }
}

// ---- production entry point --------------------------------------------

/// The owned handle the ipc adapter produces. The supervisor (Task 14) owns and
/// later joins the manager task; it is not detached. The listener bridge is
/// owned and joined by the manager itself.
pub(crate) struct IpcAdapterHandles {
    /// The async manager task (owns the connection map, supervisors, and the
    /// listener bridge).
    pub(crate) manager: JoinHandle<Result<(), IpcAdapterError>>,
}

/// Assembles the ipc adapter from the bound [`SessionListener`] and the
/// coordinator's client effect route: spawns the blocking listener bridge and
/// the async manager, wiring them with a bounded accepted-stream channel and a
/// shared cancellation token. Uses the production per-client queue capacity
/// [`CLIENT_OUTPUT_CAPACITY`]. Returns the owned manager handle.
///
/// The adapter does not unlink the session socket: cleanup remains the
/// supervisor's responsibility (Task 14), so a resolved reference may be
/// retained elsewhere but is never removed behind the supervisor here.
pub(crate) fn spawn_ipc_adapter(
    listener: SessionListener,
    effects: mpsc::Receiver<Effect>,
    events: ControlEventSender,
) -> IpcAdapterHandles {
    let listener_cancel = CancellationToken::new();
    let (accepted_tx, accepted_rx) =
        mpsc::channel::<Box<dyn SessionStream>>(ACCEPT_CHANNEL_CAPACITY);
    let bridge = spawn_listener_bridge(listener, accepted_tx, listener_cancel.clone());
    let manager = tokio::spawn(run_ipc_manager(
        effects,
        accepted_rx,
        listener_cancel,
        bridge,
        events,
        CLIENT_OUTPUT_CAPACITY,
    ));
    IpcAdapterHandles { manager }
}

#[cfg(test)]
pub(crate) mod test_support;

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    use climon_proto::frame::{encode_frame, encode_json_frame, ExitPayload, FrameType};

    use super::test_support::{FakeSessionStream, IpcFixture, RecordingEvents};
    use super::{
        run_ipc_manager, spawn_listener_bridge, Connection, ConnectionSetupError, IpcAdapterError,
        IpcManager, OutboundFrame, SetupDiagnostics, SupervisorResult, TerminalReporter,
        WorkerSide,
    };
    use crate::engine::effect::{ClientId, Effect, OperationId};
    use crate::engine::CLIENT_OUTPUT_CAPACITY;
    use crate::socket::{connect_session_socket, listen_on_session_socket, SessionStream};

    // ---- Test 1 (plan) ---------------------------------------------------

    /// A slow client whose per-client outbound queue fills must be isolated and
    /// closed on its own, without disturbing any healthy peer: a second send to
    /// the wedged client fails (isolating only it), while a healthy client keeps
    /// sending and receiving.
    #[tokio::test]
    async fn full_client_queue_disconnects_only_that_client() {
        let mut fixture = IpcFixture::with_client_capacity(1);
        let slow = fixture.connect_client().await;
        let healthy = fixture.connect_client().await;
        fixture.pause_writer(slow).await;
        fixture.send(slow, b"one").await.unwrap();
        let err = fixture.send(slow, b"two").await.unwrap_err();
        assert_eq!(err.client_id, slow);
        fixture.send(healthy, b"ok").await.unwrap();
        assert_eq!(fixture.read(healthy).await, b"ok");
    }

    // ---- Test 2: split frame across reads --------------------------------

    /// A single frame split across two reads must decode to exactly one ordered
    /// [`SessionEvent::ClientFrame`] with the exact type and payload.
    #[tokio::test]
    async fn split_frame_across_reads_decodes_to_one_ordered_frame() {
        let mut fixture = IpcFixture::new();
        let client = fixture.connect_client().await;
        let frame = encode_frame(FrameType::Input, b"hello");
        let (head, tail) = frame.split_at(3);
        fixture.feed(client, head);
        fixture.feed(client, tail);
        let frames = fixture.wait_frames(client, 1).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].frame_type, FrameType::Input);
        assert_eq!(frames[0].payload, b"hello");
    }

    // ---- Test 3: multiple frames in one read -----------------------------

    /// Multiple frames delivered in one read must decode to that many
    /// [`SessionEvent::ClientFrame`]s in exact order.
    #[tokio::test]
    async fn multiple_frames_in_one_read_decode_in_order() {
        let mut fixture = IpcFixture::new();
        let client = fixture.connect_client().await;
        let mut bytes = encode_frame(FrameType::Input, b"a");
        bytes.extend_from_slice(&encode_frame(FrameType::Input, b"bb"));
        bytes.extend_from_slice(&encode_frame(FrameType::Input, b"ccc"));
        fixture.feed(client, &bytes);
        let frames = fixture.wait_frames(client, 3).await;
        let payloads: Vec<&[u8]> = frames
            .iter()
            .map(|frame| frame.payload.as_slice())
            .collect();
        assert_eq!(payloads, vec![b"a".as_slice(), b"bb", b"ccc"]);
    }

    // ---- Test 4: ClientConnected after resources installed ---------------

    /// [`SessionEvent::ClientConnected`] is emitted only after the connection's
    /// queue/supervisor are installed, so an immediate send right after the event
    /// is delivered to the client.
    #[tokio::test]
    async fn client_connected_after_queue_installed_so_immediate_send_delivers() {
        let mut fixture = IpcFixture::new();
        // `connect_client` returns once `ClientConnected` is observed.
        let client = fixture.connect_client().await;
        fixture.send(client, b"first").await.unwrap();
        assert_eq!(fixture.read(client).await, b"first");
    }

    // ---- Test 5: outbound FIFO + Close drains before shutdown ------------

    /// Outbound frames are delivered in strict FIFO order, and an explicit
    /// `CloseClient` drains already-enqueued frames (here two data frames then an
    /// `Exit`) fully before the socket shuts down — with no redundant
    /// disconnect.
    #[tokio::test]
    async fn close_client_drains_queued_frames_in_order_without_disconnect() {
        let mut fixture = IpcFixture::new();
        let events = fixture.events().clone();
        let client = fixture.connect_client().await;
        let handle = fixture.handle(client);

        let exit = encode_json_frame(FrameType::Exit, &ExitPayload { exit_code: 7 });
        let mut expected = b"aa".to_vec();
        expected.extend_from_slice(b"bb");
        expected.extend_from_slice(&exit);

        // Enqueue three frames then close, all back-to-back through the capacity-
        // one effect channel, so the writer must drain them in FIFO order.
        fixture
            .send_effect(Effect::SendClient {
                client_id: client,
                operation_id: OperationId(10),
                bytes: b"aa".to_vec(),
            })
            .await;
        fixture
            .send_effect(Effect::SendClient {
                client_id: client,
                operation_id: OperationId(11),
                bytes: b"bb".to_vec(),
            })
            .await;
        fixture
            .send_effect(Effect::SendClient {
                client_id: client,
                operation_id: OperationId(12),
                bytes: exit.clone(),
            })
            .await;
        fixture
            .send_effect(Effect::CloseClient { client_id: client })
            .await;

        let written = handle.wait_written(expected.len()).await;
        assert_eq!(
            written, expected,
            "frames drained in FIFO order before close"
        );

        fixture.finish().await.unwrap();
        assert!(
            handle.is_shutdown(),
            "socket shut down after the final frame"
        );
        assert_eq!(
            events.tags_for(client),
            vec!["connected"],
            "an intentional close emits no redundant disconnect"
        );
    }

    // ---- Test 6: writer failure ------------------------------------------

    /// A writer failure emits exactly one [`SessionEvent::ClientSendFailed`]
    /// carrying the failing operation id, shuts only that client down, and the
    /// racing reader EOF adds no `ClientDisconnected`.
    #[tokio::test]
    async fn writer_failure_emits_single_send_failed_with_failing_op() {
        let mut fixture = IpcFixture::new();
        let events = fixture.events().clone();
        let client = fixture.connect_client().await;
        fixture.handle(client).fail_next_write("broken pipe");

        let op = OperationId(42);
        fixture
            .send_effect(Effect::SendClient {
                client_id: client,
                operation_id: op,
                bytes: b"x".to_vec(),
            })
            .await;

        let (failed_client, failed_op) = fixture.wait_send_failed(0).await;
        assert_eq!(failed_client, client);
        assert_eq!(failed_op, op);

        fixture.finish().await.unwrap();
        assert_eq!(events.send_failed().len(), 1);
        assert!(
            events.disconnected().is_empty(),
            "the reader EOF race adds no disconnect"
        );
        assert_eq!(events.tags_for(client), vec!["connected", "send_failed"]);
    }

    // ---- Test 7: normal peer EOF -----------------------------------------

    /// A normal peer EOF emits exactly one [`SessionEvent::ClientDisconnected`]
    /// and nothing else.
    #[tokio::test]
    async fn peer_eof_emits_single_disconnect() {
        let mut fixture = IpcFixture::new();
        let events = fixture.events().clone();
        let client = fixture.connect_client().await;
        fixture.close_peer(client);

        let disconnected = fixture.wait_disconnected(0).await;
        assert_eq!(disconnected, client);

        fixture.finish().await.unwrap();
        assert_eq!(events.disconnected(), vec![client]);
        assert!(events.send_failed().is_empty());
        assert_eq!(events.tags_for(client), vec!["connected", "disconnected"]);
    }

    // ---- Test 8: closed outbound queue isolation -------------------------

    /// When a per-client outbound queue is already closed (its writer is gone, so
    /// the receiver has been dropped), the manager's next send to that client
    /// isolates it with exactly one [`SessionEvent::ClientSendFailed`] carrying
    /// the failing send's operation id, then claims the terminal, cancels, and
    /// forces the socket down.
    ///
    /// This drives the manager's isolation logic directly over a nonpanic
    /// receiver-close: with the connection supervisor now forcing a dead
    /// connection down and reaping it, the lingering-closed-queue window is no
    /// longer reachable through a panicking writer without the whole adapter
    /// surfacing a fatal `WorkerPanicked`. Dropping the outbound receiver models
    /// the same closed queue deterministically and without a panic.
    #[tokio::test]
    async fn closed_outbound_queue_isolates_with_send_failed() {
        use std::collections::HashMap;
        use std::sync::mpsc::sync_channel;
        use std::sync::Arc;

        let events = RecordingEvents::new();
        let mut manager: IpcManager<RecordingEvents> = IpcManager {
            events: events.clone(),
            capacity: 1,
            connections: HashMap::new(),
            next_id: 1,
            accepting_stopped: false,
            accept_open: false,
            listener_cancel: CancellationToken::new(),
            listener_join: None,
            setup_failures: SetupDiagnostics::default(),
        };

        // A per-client queue whose receiver is dropped: the writer is gone.
        let client = ClientId(0);
        let (outbound, outbound_rx) = sync_channel::<OutboundFrame>(1);
        drop(outbound_rx);
        let (stream, handle) = FakeSessionStream::new();
        let reporter = Arc::new(TerminalReporter::new());
        let cancel = CancellationToken::new();
        manager.connections.insert(
            client,
            Connection {
                outbound,
                cancel: cancel.clone(),
                reporter: Arc::clone(&reporter),
                shutdown: Box::new(stream),
            },
        );

        manager
            .send_client(client, OperationId(7), b"y".to_vec())
            .await
            .expect("the open lane accepts the isolation event");

        assert_eq!(
            events.send_failed(),
            vec![(client, OperationId(7))],
            "the closed queue isolates the client with the failing send's op"
        );
        assert!(
            !manager.connections.contains_key(&client),
            "the isolated client is removed"
        );
        assert!(reporter.is_claimed(), "the isolation claims the terminal");
        assert!(
            cancel.is_cancelled(),
            "the isolation cancels the connection"
        );
        assert!(handle.is_shutdown(), "the isolation forces the socket down");
    }

    // ---- Test 9: stop accepting ------------------------------------------

    /// `StopAcceptingClients` rejects later connections, is idempotent, and leaves
    /// existing clients usable.
    #[tokio::test]
    async fn stop_accepting_rejects_later_connections_and_is_idempotent() {
        let mut fixture = IpcFixture::new();
        let existing = fixture.connect_client().await;

        fixture.stop_accepting().await;
        fixture.stop_accepting().await; // idempotent

        // A stream accepted after the stop is rejected (shut down, never
        // connected).
        let (late_stream, late) = FakeSessionStream::new();
        fixture.inject(late_stream).await;
        late.wait_shutdown().await;
        assert_eq!(fixture.events().connected(), vec![existing]);

        // The existing client is still usable.
        fixture.send(existing, b"still").await.unwrap();
        assert_eq!(fixture.read(existing).await, b"still");
    }

    // ---- Test 10: effect route drop --------------------------------------

    /// Dropping the effect route drains queued client effects, gracefully closes
    /// and joins every connection (its reader and writer both run to completion —
    /// they are joined, not detached), then the manager exits `Ok`.
    #[tokio::test]
    async fn effect_route_drop_drains_queue_and_joins_connections() {
        let mut fixture = IpcFixture::new();
        let client = fixture.connect_client().await;
        let handle = fixture.handle(client);

        fixture
            .send_effect(Effect::SendClient {
                client_id: client,
                operation_id: OperationId(1),
                bytes: b"bye".to_vec(),
            })
            .await;

        let result = fixture.finish().await;
        assert_eq!(result, Ok(()));
        assert_eq!(
            handle.written(),
            b"bye",
            "queued frame drained before close"
        );
        assert!(handle.is_shutdown());
        assert!(
            handle.shutdown_count() >= 2,
            "both reader and writer ran to completion (were joined, not detached)"
        );
    }

    // ---- Test 11: unexpected effect --------------------------------------

    /// An unexpected (non-client) effect returns a typed error after the manager
    /// has cleaned up its owned connections.
    #[tokio::test]
    async fn unexpected_effect_returns_typed_error_after_cleanup() {
        let mut fixture = IpcFixture::new();
        let client = fixture.connect_client().await;
        let handle = fixture.handle(client);

        fixture
            .send_effect(Effect::KillPty {
                operation_id: OperationId(1),
            })
            .await;

        let result = fixture.join_manager().await;
        assert_eq!(result, Err(IpcAdapterError::UnexpectedEffect("KillPty")));
        assert!(handle.is_shutdown(), "the connection was cleaned up");
    }

    // ---- Test 12: closed control lane ------------------------------------

    /// A closed control lane surfaces as a typed adapter error after owned
    /// cleanup.
    #[tokio::test]
    async fn closed_control_lane_returns_typed_error_after_cleanup() {
        let mut fixture = IpcFixture::with_closed_lane();
        let (stream, handle) = FakeSessionStream::new();
        fixture.inject(stream).await;

        let result = fixture.join_manager().await;
        assert_eq!(result, Err(IpcAdapterError::EventLaneClosed));
        assert!(handle.is_shutdown(), "the connection was cleaned up");
    }

    // ---- Test 12a: post-establishment lane closure on a reader frame ------

    /// After a client is established, a control lane that closes while the reader
    /// is running must propagate: the reader's `ClientFrame` emit fails, that
    /// typed `EventLaneClosed` flows through the connection supervisor to the
    /// manager, which cleans up (both blocking workers shut down and joined) and
    /// returns `Err(EventLaneClosed)`. The current code swallows the reader's
    /// `blocking_emit` error, so the manager stays running and this hangs.
    #[tokio::test]
    async fn post_establish_lane_close_on_reader_frame_propagates_event_lane_closed() {
        let mut fixture = IpcFixture::new();
        let client = fixture.connect_client().await;
        let handle = fixture.handle(client);

        // The lane is open when the client connects, then closes; a subsequently
        // fed frame cannot be delivered.
        fixture.close_lane();
        fixture.feed(client, &encode_frame(FrameType::Input, b"hi"));

        let result = fixture.join_manager().await;
        assert_eq!(result, Err(IpcAdapterError::EventLaneClosed));
        assert!(handle.is_shutdown(), "the connection was cleaned up");
        assert!(
            handle.shutdown_count() >= 2,
            "reader and writer both shut down and were joined"
        );
    }

    // ---- Test 12b: post-establishment lane closure on a writer failure ---

    /// The same post-establishment lane closure on the writer's failure path: a
    /// write fails, and the writer's `ClientSendFailed` emit finds a closed lane.
    /// That typed `EventLaneClosed` must flow through the supervisor to the
    /// manager, which cleans up and returns `Err(EventLaneClosed)`. The current
    /// code swallows the writer's `blocking_emit` error, so the manager stays
    /// running and this hangs.
    #[tokio::test]
    async fn post_establish_lane_close_on_writer_failure_propagates_event_lane_closed() {
        let mut fixture = IpcFixture::new();
        let client = fixture.connect_client().await;
        let handle = fixture.handle(client);
        handle.fail_next_write("broken pipe");

        fixture.close_lane();
        fixture
            .send_effect(Effect::SendClient {
                client_id: client,
                operation_id: OperationId(42),
                bytes: b"x".to_vec(),
            })
            .await;

        let result = fixture.join_manager().await;
        assert_eq!(result, Err(IpcAdapterError::EventLaneClosed));
        assert!(handle.is_shutdown(), "the connection was cleaned up");
        assert!(
            handle.shutdown_count() >= 2,
            "reader and writer both shut down and were joined"
        );
    }

    // ---- Test 12c: writer panic forces reader shutdown -------------------

    /// A blocking writer that panics (without shutting its socket down) must not
    /// wedge its idle-or-parked reader counterpart: the supervisor forces
    /// shutdown, the reader finishes, and the manager surfaces a payload-free
    /// `WorkerPanicked(Writer)` rather than hanging. The current sequential-await
    /// supervisor awaits the parked reader first, so it hangs without the
    /// fixture's `Drop` force-shutdown.
    #[tokio::test]
    async fn writer_panic_forces_reader_shutdown_and_surfaces_worker_panicked() {
        let mut fixture = IpcFixture::new();
        let client = fixture.connect_client().await;
        let handle = fixture.handle(client);

        let panicking = handle.arm_panic();
        fixture
            .send_effect(Effect::SendClient {
                client_id: client,
                operation_id: OperationId(1),
                bytes: b"boom".to_vec(),
            })
            .await;
        panicking.await.expect("writer began the panicking write");

        let result = fixture.join_manager().await;
        assert_eq!(
            result,
            Err(IpcAdapterError::WorkerPanicked(WorkerSide::Writer))
        );
        assert!(
            handle.is_shutdown(),
            "the reader was forced down and joined"
        );
    }

    // ---- Test 12d: reader panic unblocks the idle writer -----------------

    /// A blocking reader that panics while its writer sits idle must not wedge the
    /// writer: the supervisor cancels and forces shutdown so the idle writer
    /// unblocks and is joined, and the manager surfaces `WorkerPanicked(Reader)`.
    /// The current supervisor awaits the panicked reader (ignored) then the idle
    /// writer, which never unblocks, so it hangs.
    #[tokio::test]
    async fn reader_panic_unblocks_idle_writer_and_surfaces_worker_panicked() {
        let mut fixture = IpcFixture::new();
        let client = fixture.connect_client().await;
        let handle = fixture.handle(client);

        handle.arm_read_panic();

        let result = fixture.join_manager().await;
        assert_eq!(
            result,
            Err(IpcAdapterError::WorkerPanicked(WorkerSide::Reader))
        );
        assert!(
            handle.is_shutdown(),
            "the idle writer was canceled/unblocked and joined"
        );
    }

    // ---- Test 13a: listener WouldBlock policy ----------------------------

    /// The real listener bridge parks on `WouldBlock` while no connection is
    /// pending and stops cleanly (`Ok`) once cancelled.
    #[tokio::test]
    async fn listener_bridge_polls_wouldblock_until_cancelled() {
        let (listener, _resolved) = listen_on_session_socket("tcp://127.0.0.1:0").unwrap();
        let (accepted_tx, _accepted_rx) = mpsc::channel::<Box<dyn SessionStream>>(4);
        let cancel = CancellationToken::new();
        let bridge = spawn_listener_bridge(listener, accepted_tx, cancel.clone());
        cancel.cancel();
        let result = tokio::time::timeout(super::test_support::ANTI_HANG, bridge)
            .await
            .expect("bridge stops")
            .expect("bridge task joined");
        assert_eq!(result, Ok(()));
    }

    // ---- Test 13b: fatal listener error ----------------------------------

    /// A fatal listener error returns the typed error and the manager cleans up
    /// its owned connections.
    #[tokio::test]
    async fn fatal_listener_error_returns_typed_error_and_cleans_up() {
        let mut fixture =
            IpcFixture::with_listener_result(Err(IpcAdapterError::ListenerAccept("boom".into())));
        let client = fixture.connect_client().await;
        let handle = fixture.handle(client);

        fixture.fail_listener();

        let result = fixture.join_manager().await;
        assert_eq!(
            result,
            Err(IpcAdapterError::ListenerAccept("boom".into())),
            "the fatal listener error is surfaced"
        );
        assert!(handle.is_shutdown(), "existing client cleaned up");
    }

    // ---- Test 13c: route-close cleanup surfaces a worker fatal -----------

    /// When the effect route closes, the manager's graceful shutdown joins every
    /// supervisor and must reconcile a fatal a supervisor discovered during its
    /// own teardown (a closed lane or a worker panic): it returns that error
    /// rather than a silent `Ok`, while still joining every supervisor. The
    /// previous cleanup discarded supervisor outcomes entirely.
    #[tokio::test]
    async fn route_close_join_surfaces_worker_fatal_rather_than_swallowing() {
        use std::collections::HashMap;
        use tokio::task::JoinSet;

        let events = RecordingEvents::new();
        let mut manager: IpcManager<RecordingEvents> = IpcManager {
            events,
            capacity: 1,
            connections: HashMap::new(),
            next_id: 0,
            accepting_stopped: false,
            accept_open: false,
            listener_cancel: CancellationToken::new(),
            listener_join: None,
            setup_failures: SetupDiagnostics::default(),
        };

        // Three supervisors reaped during the route-close join, one of which
        // reports a fatal it discovered while cleaning up its counterpart.
        let mut join_set: JoinSet<SupervisorResult> = JoinSet::new();
        join_set.spawn(async { Ok(ClientId(0)) });
        join_set.spawn(async { Err(IpcAdapterError::WorkerPanicked(WorkerSide::Reader)) });
        join_set.spawn(async { Ok(ClientId(2)) });

        let (_accepted_tx, mut accepted_rx) = mpsc::channel::<Box<dyn SessionStream>>(1);
        let fatal = manager
            .graceful_shutdown(&mut accepted_rx, &mut join_set)
            .await;

        assert_eq!(
            fatal,
            Some(IpcAdapterError::WorkerPanicked(WorkerSide::Reader)),
            "the worker fatal discovered while joining is surfaced, not swallowed"
        );
        assert!(
            join_set.is_empty(),
            "every supervisor was still joined despite the fatal"
        );
    }

    // ---- Test 14: isolated setup failure ---------------------------------

    /// A connection whose setup fails is isolated (shut down) without failing the
    /// manager, and a later valid client still connects.
    #[tokio::test]
    async fn setup_failure_is_isolated_and_later_client_connects() {
        let mut fixture = IpcFixture::new();
        let (failing, failing_handle) = FakeSessionStream::failing_write_timeout();
        fixture.inject(failing).await;
        failing_handle.wait_shutdown().await;

        let good = fixture.connect_client().await;
        fixture.send(good, b"ok").await.unwrap();
        assert_eq!(fixture.read(good).await, b"ok");
        assert_eq!(
            fixture.events().connected(),
            vec![good],
            "only the healthy client connected"
        );
    }

    // ---- Test 14a: setup diagnostics stay bounded ------------------------

    /// Isolated setup failures are retained as bounded diagnostics — a running
    /// count and only the most recent failure — no matter how many connections
    /// fail their setup, rather than an unbounded per-failure list. After many
    /// failures only the latest is kept, so the storage never grows with the
    /// failure count.
    #[test]
    fn setup_diagnostics_retain_bounded_count_and_latest_only() {
        let mut diagnostics = SetupDiagnostics::default();
        assert_eq!(diagnostics.count, 0);
        assert!(diagnostics.last.is_none());

        for i in 0..1000 {
            diagnostics.record(
                ClientId(i),
                ConnectionSetupError::Config(format!("cause {i}")),
            );
        }

        assert_eq!(diagnostics.count, 1000, "every setup failure is counted");
        assert_eq!(
            diagnostics.last,
            Some((
                ClientId(999),
                ConnectionSetupError::Config("cause 999".into())
            )),
            "only the most recent failure is retained; earlier ones are dropped"
        );
    }

    // ---- Test 14b: many setup failures then a valid client ---------------

    /// Many connections that fail their setup are each isolated (shut down)
    /// without failing the manager, and a later valid client still connects and
    /// works — the manager stays healthy after a burst of bounded-diagnostic
    /// setup failures.
    #[tokio::test]
    async fn many_setup_failures_stay_bounded_and_later_client_connects() {
        let mut fixture = IpcFixture::new();
        for _ in 0..64 {
            let (failing, failing_handle) = FakeSessionStream::failing_write_timeout();
            fixture.inject(failing).await;
            failing_handle.wait_shutdown().await;
        }

        let good = fixture.connect_client().await;
        fixture.send(good, b"ok").await.unwrap();
        assert_eq!(fixture.read(good).await, b"ok");
        assert_eq!(
            fixture.events().connected(),
            vec![good],
            "only the healthy client connected after the failing burst"
        );
    }

    // ---- Test 15: blocking workers do not block the runtime --------------

    /// A blocking writer parked mid-write must not occupy a Tokio worker: while it
    /// is gated on a blocking thread, a spawned task still runs to completion. No
    /// wall-clock sleep is used — a permit gate holds the write and a bounded
    /// timeout is only the anti-hang net.
    #[tokio::test]
    async fn blocking_writer_does_not_block_the_runtime() {
        let mut fixture = IpcFixture::with_client_capacity(1);
        let client = fixture.connect_client().await;
        fixture.pause_writer(client).await;

        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ = done_tx.send(());
        });
        tokio::time::timeout(super::test_support::ANTI_HANG, done_rx)
            .await
            .expect("runtime responsive while the writer blocks")
            .expect("spawned task completed");
    }

    // ---- Test 16: loopback smoke -----------------------------------------

    /// An end-to-end loopback (TCP) smoke test over the *real* listener bridge and
    /// sockets: the five-second write timeout is set (proved by the connection
    /// completing), a split frame reaches one `ClientFrame`, a server `SendClient`
    /// reaches the client, and a `CloseClient` drains the client's bytes before it
    /// sees EOF. It never waits five seconds.
    #[tokio::test]
    async fn loopback_smoke_split_frame_send_and_close() {
        let (listener, resolved) = listen_on_session_socket("tcp://127.0.0.1:0").unwrap();
        let events = RecordingEvents::new();
        let (effect_tx, effect_rx) = mpsc::channel::<Effect>(64);
        let (accepted_tx, accepted_rx) = mpsc::channel::<Box<dyn SessionStream>>(16);
        let cancel = CancellationToken::new();
        let bridge = spawn_listener_bridge(listener, accepted_tx, cancel.clone());
        let manager = tokio::spawn(run_ipc_manager(
            effect_rx,
            accepted_rx,
            cancel.clone(),
            bridge,
            events.clone(),
            CLIENT_OUTPUT_CAPACITY,
        ));

        // Drive the whole client side on a blocking thread: connect, write a split
        // frame, then read the server bytes and the EOF the server's close yields.
        let client_task = tokio::task::spawn_blocking(move || {
            let mut client = connect_session_socket(&resolved).expect("client connects");
            let frame = encode_frame(FrameType::Input, b"hi");
            client.write_all(&frame[..3]).unwrap();
            client.flush().unwrap();
            client.write_all(&frame[3..]).unwrap();
            client.flush().unwrap();
            let mut got = [0u8; 3];
            client.read_exact(&mut got).unwrap();
            let mut tail = [0u8; 16];
            let eof = client.read(&mut tail).unwrap();
            (got.to_vec(), eof)
        });

        let anti_hang = super::test_support::ANTI_HANG;
        let id = tokio::time::timeout(anti_hang, events.wait_connected(0))
            .await
            .expect("client connects (five-second write timeout set)");
        let frames = tokio::time::timeout(anti_hang, events.wait_frames(id, 1))
            .await
            .expect("split frame decodes");
        assert_eq!(frames[0].frame_type, FrameType::Input);
        assert_eq!(frames[0].payload, b"hi");

        effect_tx
            .send(Effect::SendClient {
                client_id: id,
                operation_id: OperationId(1),
                bytes: b"srv".to_vec(),
            })
            .await
            .unwrap();
        effect_tx
            .send(Effect::CloseClient { client_id: id })
            .await
            .unwrap();

        let (got, eof) = tokio::time::timeout(anti_hang, client_task)
            .await
            .expect("client finishes")
            .expect("client task joined");
        assert_eq!(got, b"srv", "server SendClient bytes reach the client");
        assert_eq!(eof, 0, "close drains then the client sees EOF");

        // Teardown: close the route and cancel the listener, then join.
        drop(effect_tx);
        cancel.cancel();
        tokio::time::timeout(anti_hang, manager)
            .await
            .expect("manager finishes")
            .expect("manager task joined")
            .expect("manager returns Ok");
    }
}
