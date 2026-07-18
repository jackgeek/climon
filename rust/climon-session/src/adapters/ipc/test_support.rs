//! Test-only fixture and fakes for the ipc adapter. Every test drives the *real*
//! [`super::run_ipc_manager`], connection supervisors, and blocking
//! reader/writer loops; only the wire transport ([`FakeSessionStream`]) and the
//! control-lane sink ([`RecordingEvents`]) are doubled so behaviour is
//! deterministic. The recorded byte forms exist only in these recorders; the
//! production adapter never renders client bytes into any string.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot, Notify};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use climon_proto::frame::DecodedFrame;

use crate::adapters::ipc::{run_ipc_manager, ClientEventSink, IpcAdapterError};
use crate::engine::effect::{ClientId, Effect, OperationId};
use crate::engine::event::SessionEvent;
use crate::socket::SessionStream;

/// A bounded anti-hang net for the integrated tests. It is a *safety* net only:
/// every test drives completion through channels/recorders and no assertion
/// depends on wall-clock timing. A correct implementation finishes well within
/// it; a regression that hangs trips it deterministically.
pub(crate) const ANTI_HANG: Duration = Duration::from_secs(5);

// ---- fake session stream -----------------------------------------------

/// A scripted read step for a [`FakeSessionStream`].
enum ReadStep {
    /// Return these bytes from a `read`.
    Chunk(Vec<u8>),
    /// Fail the `read` with this cause (an unexpected socket read error).
    Error(String),
}

/// The shared state behind a [`FakeSessionStream`] and all of its clones (reader,
/// writer, and the manager's shutdown handle share one `Arc<FakeInner>`), so a
/// test can feed reads, inspect writes, gate the writer, and shut the stream
/// down from the same state the real workers drive.
struct FakeInner {
    // read side (driven by the blocking reader)
    reads: Mutex<VecDeque<ReadStep>>,
    read_eof: AtomicBool,
    read_cv: Condvar,
    // write side (driven by the blocking writer)
    written: Mutex<Vec<u8>>,
    write_notify: Notify,
    paused: Mutex<bool>,
    pause_cv: Condvar,
    write_started: Mutex<Option<oneshot::Sender<()>>>,
    write_error: Mutex<Option<String>>,
    panic_signal: Mutex<Option<oneshot::Sender<()>>>,
    // shutdown (forced teardown)
    shutdown: AtomicBool,
    shutdown_count: AtomicUsize,
    shutdown_notify: Notify,
    // configuration records + scripted setup failures
    write_timeout: Mutex<Option<Option<Duration>>>,
    nonblocking: Mutex<Option<bool>>,
    set_nonblocking_err: Mutex<Option<String>>,
    set_write_timeout_err: Mutex<Option<String>>,
    clone_err: Mutex<Option<String>>,
}

impl FakeInner {
    fn new() -> Arc<FakeInner> {
        Arc::new(FakeInner {
            reads: Mutex::new(VecDeque::new()),
            read_eof: AtomicBool::new(false),
            read_cv: Condvar::new(),
            written: Mutex::new(Vec::new()),
            write_notify: Notify::new(),
            paused: Mutex::new(false),
            pause_cv: Condvar::new(),
            write_started: Mutex::new(None),
            write_error: Mutex::new(None),
            panic_signal: Mutex::new(None),
            shutdown: AtomicBool::new(false),
            shutdown_count: AtomicUsize::new(0),
            shutdown_notify: Notify::new(),
            write_timeout: Mutex::new(None),
            nonblocking: Mutex::new(None),
            set_nonblocking_err: Mutex::new(None),
            set_write_timeout_err: Mutex::new(None),
            clone_err: Mutex::new(None),
        })
    }
}

/// A test [`SessionStream`] backed by shared [`FakeInner`]. The reader reads its
/// scripted chunks; the writer records what it writes and can be gated; every
/// clone shares one `Arc<FakeInner>` so `shutdown_both` on any handle unblocks
/// them all.
pub(crate) struct FakeSessionStream {
    inner: Arc<FakeInner>,
}

/// A handle a test keeps to drive/inspect one connection's [`FakeSessionStream`]
/// (feed reads, read what was written, gate the writer, force EOF, observe
/// shutdown) after the manager has taken ownership of the stream itself.
#[derive(Clone)]
pub(crate) struct FakeStreamHandle {
    inner: Arc<FakeInner>,
}

impl FakeSessionStream {
    /// Builds a fresh fake stream and the handle a test keeps to drive it.
    pub(crate) fn new() -> (FakeSessionStream, FakeStreamHandle) {
        let inner = FakeInner::new();
        (
            FakeSessionStream {
                inner: Arc::clone(&inner),
            },
            FakeStreamHandle { inner },
        )
    }

    /// Builds a fake stream whose `set_write_timeout` fails, to exercise isolated
    /// connection-setup failure.
    pub(crate) fn failing_write_timeout() -> (FakeSessionStream, FakeStreamHandle) {
        let (stream, handle) = FakeSessionStream::new();
        *stream.inner.set_write_timeout_err.lock().unwrap() = Some("timeout unsupported".into());
        (stream, handle)
    }
}

impl FakeStreamHandle {
    /// Pushes one chunk of bytes for the reader to return, waking a parked reader.
    pub(crate) fn feed(&self, bytes: &[u8]) {
        self.inner
            .reads
            .lock()
            .unwrap()
            .push_back(ReadStep::Chunk(bytes.to_vec()));
        self.inner.read_cv.notify_all();
    }

    /// Signals a normal peer close: once the reader drains scripted chunks it
    /// sees EOF (a graceful disconnect), not a forced shutdown.
    pub(crate) fn close_peer(&self) {
        self.inner.read_eof.store(true, Ordering::SeqCst);
        self.inner.read_cv.notify_all();
    }

    /// Arms the next write to fail with `cause`, so the writer treats it as a
    /// write failure (and isolates the client).
    pub(crate) fn fail_next_write(&self, cause: &str) {
        *self.inner.write_error.lock().unwrap() = Some(cause.to_string());
    }

    /// Arms the next write to panic (modelling a writer thread that dies without
    /// claiming the terminal, so its outbound receiver closes). Returns a receiver
    /// that fires just before the panic unwinds.
    pub(crate) fn arm_panic(&self) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        *self.inner.panic_signal.lock().unwrap() = Some(tx);
        rx
    }

    /// Arms the writer gate and a one-shot "write started" signal, so the next
    /// write records that it began (occupying the writer's in-flight slot) and
    /// then blocks until shutdown.
    fn arm_pause(&self, started: oneshot::Sender<()>) {
        *self.inner.paused.lock().unwrap() = true;
        *self.inner.write_started.lock().unwrap() = Some(started);
    }

    /// Waits (async) until the writer has written some bytes, then drains and
    /// returns them.
    pub(crate) async fn read_written(&self) -> Vec<u8> {
        loop {
            let notified = self.inner.write_notify.notified();
            {
                let mut written = self.inner.written.lock().unwrap();
                if !written.is_empty() {
                    return std::mem::take(&mut *written);
                }
            }
            notified.await;
        }
    }

    /// The bytes the writer has written so far (without draining).
    pub(crate) fn written(&self) -> Vec<u8> {
        self.inner.written.lock().unwrap().clone()
    }

    /// Waits until the writer has written at least `min_len` bytes, then returns a
    /// clone of everything written so far (without draining).
    pub(crate) async fn wait_written(&self, min_len: usize) -> Vec<u8> {
        loop {
            let notified = self.inner.write_notify.notified();
            {
                let written = self.inner.written.lock().unwrap();
                if written.len() >= min_len {
                    return written.clone();
                }
            }
            notified.await;
        }
    }

    /// Whether the stream has been shut down (forced teardown or reader exit).
    pub(crate) fn is_shutdown(&self) -> bool {
        self.inner.shutdown.load(Ordering::SeqCst)
    }

    /// How many times `shutdown_both` has been called on this stream. Both the
    /// reader and the writer shut down on exit, so a count of at least two proves
    /// both blocking workers ran to completion (were joined, not detached).
    pub(crate) fn shutdown_count(&self) -> usize {
        self.inner.shutdown_count.load(Ordering::SeqCst)
    }

    /// Waits until the stream has been shut down.
    pub(crate) async fn wait_shutdown(&self) {
        loop {
            let notified = self.inner.shutdown_notify.notified();
            if self.inner.shutdown.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }

    /// Forces the stream down and wakes every parked reader/writer, so a test's
    /// blocking workers can never be left parked at teardown (used by the
    /// fixture's `Drop`). It does not count as a real `shutdown_both`.
    pub(crate) fn force_shutdown(&self) {
        self.inner.shutdown.store(true, Ordering::SeqCst);
        self.inner.read_cv.notify_all();
        self.inner.pause_cv.notify_all();
        self.inner.write_notify.notify_waiters();
        self.inner.shutdown_notify.notify_one();
    }

    /// The exact write timeout the manager configured on this stream, if any.
    pub(crate) fn configured_write_timeout(&self) -> Option<Option<Duration>> {
        *self.inner.write_timeout.lock().unwrap()
    }

    /// Whether the manager configured blocking mode (`set_nonblocking(false)`).
    pub(crate) fn configured_blocking(&self) -> Option<bool> {
        self.inner.nonblocking.lock().unwrap().map(|nb| !nb)
    }
}

impl Read for FakeSessionStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut reads = self.inner.reads.lock().unwrap();
        loop {
            if self.inner.shutdown.load(Ordering::SeqCst) {
                return Ok(0);
            }
            match reads.pop_front() {
                Some(ReadStep::Chunk(mut data)) => {
                    let n = data.len().min(buf.len());
                    buf[..n].copy_from_slice(&data[..n]);
                    if n < data.len() {
                        let rest = data.split_off(n);
                        reads.push_front(ReadStep::Chunk(rest));
                    }
                    return Ok(n);
                }
                Some(ReadStep::Error(message)) => return Err(io::Error::other(message)),
                None => {
                    if self.inner.read_eof.load(Ordering::SeqCst) {
                        return Ok(0);
                    }
                    // A live peer with nothing more to send: park until a chunk,
                    // an EOF, or a shutdown wakes us.
                    reads = self.inner.read_cv.wait(reads).unwrap();
                }
            }
        }
    }
}

impl Write for FakeSessionStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if let Some(started) = self.inner.write_started.lock().unwrap().take() {
            let _ = started.send(());
        }
        // Model a writer thread that dies without claiming the terminal: signal,
        // then panic (outside every fake lock) so the writer's outbound receiver
        // closes during unwind.
        let panic_signal = self.inner.panic_signal.lock().unwrap().take();
        if let Some(signal) = panic_signal {
            let _ = signal.send(());
            panic!("fake writer panic");
        }
        {
            let mut paused = self.inner.paused.lock().unwrap();
            while *paused && !self.inner.shutdown.load(Ordering::SeqCst) {
                paused = self.inner.pause_cv.wait(paused).unwrap();
            }
        }
        if self.inner.shutdown.load(Ordering::SeqCst) {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "stream shut down",
            ));
        }
        if let Some(message) = self.inner.write_error.lock().unwrap().take() {
            return Err(io::Error::other(message));
        }
        self.inner.written.lock().unwrap().extend_from_slice(buf);
        self.inner.write_notify.notify_one();
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl SessionStream for FakeSessionStream {
    fn try_clone_box(&self) -> io::Result<Box<dyn SessionStream>> {
        if let Some(message) = &*self.inner.clone_err.lock().unwrap() {
            return Err(io::Error::other(message.clone()));
        }
        Ok(Box::new(FakeSessionStream {
            inner: Arc::clone(&self.inner),
        }))
    }

    fn shutdown_both(&self) -> io::Result<()> {
        self.inner.shutdown.store(true, Ordering::SeqCst);
        self.inner.shutdown_count.fetch_add(1, Ordering::SeqCst);
        self.inner.read_cv.notify_all();
        self.inner.pause_cv.notify_all();
        self.inner.write_notify.notify_waiters();
        self.inner.shutdown_notify.notify_one();
        Ok(())
    }

    fn set_write_timeout(&self, dur: Option<Duration>) -> io::Result<()> {
        if let Some(message) = &*self.inner.set_write_timeout_err.lock().unwrap() {
            return Err(io::Error::other(message.clone()));
        }
        *self.inner.write_timeout.lock().unwrap() = Some(dur);
        Ok(())
    }

    fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        if let Some(message) = &*self.inner.set_nonblocking_err.lock().unwrap() {
            return Err(io::Error::other(message.clone()));
        }
        *self.inner.nonblocking.lock().unwrap() = Some(nonblocking);
        Ok(())
    }
}

// ---- recording event sink ----------------------------------------------

/// An in-memory [`ClientEventSink`] recording every emitted [`SessionEvent`],
/// with a `closed` flag to simulate a closed control lane. `wait_for` lets a test
/// await a specific recorded event deterministically.
#[derive(Clone)]
pub(crate) struct RecordingEvents {
    events: Arc<Mutex<Vec<SessionEvent>>>,
    notify: Arc<Notify>,
    closed: Arc<AtomicBool>,
}

impl RecordingEvents {
    pub(crate) fn new() -> RecordingEvents {
        RecordingEvents {
            events: Arc::new(Mutex::new(Vec::new())),
            notify: Arc::new(Notify::new()),
            closed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// A recorder whose lane is already closed, so every emit fails.
    pub(crate) fn closed_lane() -> RecordingEvents {
        let events = RecordingEvents::new();
        events.closed.store(true, Ordering::SeqCst);
        events
    }

    fn record(&self, event: SessionEvent) -> Result<(), IpcAdapterError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(IpcAdapterError::EventLaneClosed);
        }
        self.events.lock().unwrap().push(event);
        self.notify.notify_one();
        Ok(())
    }

    /// Awaits the first recorded event for which `f` returns `Some`.
    async fn wait_for<F, T>(&self, mut f: F) -> T
    where
        F: FnMut(&[SessionEvent]) -> Option<T>,
    {
        loop {
            let notified = self.notify.notified();
            {
                let guard = self.events.lock().unwrap();
                if let Some(value) = f(&guard) {
                    return value;
                }
            }
            notified.await;
        }
    }

    /// The connected client ids, in emission order.
    pub(crate) fn connected(&self) -> Vec<ClientId> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                SessionEvent::ClientConnected(id) => Some(*id),
                _ => None,
            })
            .collect()
    }

    /// The disconnected client ids, in emission order.
    pub(crate) fn disconnected(&self) -> Vec<ClientId> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                SessionEvent::ClientDisconnected(id) => Some(*id),
                _ => None,
            })
            .collect()
    }

    /// The send-failed `(client, operation)` pairs, in emission order.
    pub(crate) fn send_failed(&self) -> Vec<(ClientId, OperationId)> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                SessionEvent::ClientSendFailed {
                    client_id,
                    operation_id,
                } => Some((*client_id, *operation_id)),
                _ => None,
            })
            .collect()
    }

    /// The decoded frames emitted for `client`, in emission order.
    pub(crate) fn frames_for(&self, client: ClientId) -> Vec<DecodedFrame> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                SessionEvent::ClientFrame { client_id, frame } if *client_id == client => {
                    Some(frame.clone())
                }
                _ => None,
            })
            .collect()
    }

    /// The ordered event tags for `client` (connect/frame/disconnect/send-failed),
    /// used to assert that no redundant terminal event follows an intentional
    /// close.
    pub(crate) fn tags_for(&self, client: ClientId) -> Vec<&'static str> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                SessionEvent::ClientConnected(id) if *id == client => Some("connected"),
                SessionEvent::ClientDisconnected(id) if *id == client => Some("disconnected"),
                SessionEvent::ClientFrame { client_id, .. } if *client_id == client => {
                    Some("frame")
                }
                SessionEvent::ClientSendFailed { client_id, .. } if *client_id == client => {
                    Some("send_failed")
                }
                _ => None,
            })
            .collect()
    }

    /// Awaits the `after`-th (0-based) [`SessionEvent::ClientConnected`].
    pub(crate) async fn wait_connected(&self, after: usize) -> ClientId {
        self.wait_for(|events| {
            events
                .iter()
                .filter_map(|event| match event {
                    SessionEvent::ClientConnected(id) => Some(*id),
                    _ => None,
                })
                .nth(after)
        })
        .await
    }

    /// Awaits the `after`-th (0-based) [`SessionEvent::ClientDisconnected`].
    pub(crate) async fn wait_disconnected(&self, after: usize) -> ClientId {
        self.wait_for(|events| {
            events
                .iter()
                .filter_map(|event| match event {
                    SessionEvent::ClientDisconnected(id) => Some(*id),
                    _ => None,
                })
                .nth(after)
        })
        .await
    }

    /// Awaits the `after`-th (0-based) [`SessionEvent::ClientSendFailed`].
    pub(crate) async fn wait_send_failed(&self, after: usize) -> (ClientId, OperationId) {
        self.wait_for(|events| {
            events
                .iter()
                .filter_map(|event| match event {
                    SessionEvent::ClientSendFailed {
                        client_id,
                        operation_id,
                    } => Some((*client_id, *operation_id)),
                    _ => None,
                })
                .nth(after)
        })
        .await
    }

    /// Awaits until at least `count` frames have been recorded for `client`.
    pub(crate) async fn wait_frames(&self, client: ClientId, count: usize) -> Vec<DecodedFrame> {
        self.wait_for(|events| {
            let frames: Vec<DecodedFrame> = events
                .iter()
                .filter_map(|event| match event {
                    SessionEvent::ClientFrame { client_id, frame } if *client_id == client => {
                        Some(frame.clone())
                    }
                    _ => None,
                })
                .collect();
            (frames.len() >= count).then_some(frames)
        })
        .await
    }
}

impl ClientEventSink for RecordingEvents {
    #[allow(clippy::manual_async_fn)]
    fn emit(
        &self,
        event: SessionEvent,
    ) -> impl std::future::Future<Output = Result<(), IpcAdapterError>> + Send {
        let this = self.clone();
        async move { this.record(event) }
    }

    fn blocking_emit(&self, event: SessionEvent) -> Result<(), IpcAdapterError> {
        self.record(event)
    }
}

// ---- send failure ------------------------------------------------------

/// The error a [`IpcFixture::send`] returns when the send isolated its client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SendFailure {
    pub(crate) client_id: ClientId,
}

// ---- fixture -----------------------------------------------------------

/// A sentinel client id no real connection is ever assigned; used for probe
/// effects that flush the manager without touching a client.
const SYNC_SENTINEL: ClientId = ClientId(u64::MAX);

/// Drives the real ipc manager over an injected accepted-stream channel and a
/// capacity-one effect channel (so probe effects deterministically flush the
/// manager). Fakes stand in only for the sockets and the control lane.
pub(crate) struct IpcFixture {
    events: RecordingEvents,
    effects: mpsc::Sender<Effect>,
    accepted: Option<mpsc::Sender<Box<dyn SessionStream>>>,
    listener_cancel: CancellationToken,
    listener_result: Arc<Mutex<Option<Result<(), IpcAdapterError>>>>,
    listener_ready: Option<oneshot::Sender<()>>,
    manager: Option<JoinHandle<Result<(), IpcAdapterError>>>,
    next_op: u64,
    connected_seen: usize,
    handles: HashMap<ClientId, FakeStreamHandle>,
    all_handles: Vec<FakeStreamHandle>,
}

impl IpcFixture {
    /// Builds a fixture whose per-client outbound queues have `capacity` buffer
    /// slots.
    pub(crate) fn with_client_capacity(capacity: usize) -> IpcFixture {
        IpcFixture::build(capacity, Ok(()))
    }

    /// Builds a fixture with the production per-client capacity.
    pub(crate) fn new() -> IpcFixture {
        IpcFixture::with_client_capacity(crate::engine::CLIENT_OUTPUT_CAPACITY)
    }

    /// Builds a fixture whose simulated listener bridge, once it stops, returns
    /// `listener_result` (used to exercise a fatal listener error).
    pub(crate) fn with_listener_result(result: Result<(), IpcAdapterError>) -> IpcFixture {
        IpcFixture::build(crate::engine::CLIENT_OUTPUT_CAPACITY, result)
    }

    /// Builds a fixture whose control event lane is already closed, so the first
    /// emit fails.
    pub(crate) fn with_closed_lane() -> IpcFixture {
        IpcFixture::build_with_events(
            crate::engine::CLIENT_OUTPUT_CAPACITY,
            Ok(()),
            RecordingEvents::closed_lane(),
        )
    }

    fn build(capacity: usize, listener_result: Result<(), IpcAdapterError>) -> IpcFixture {
        IpcFixture::build_with_events(capacity, listener_result, RecordingEvents::new())
    }

    fn build_with_events(
        capacity: usize,
        listener_result: Result<(), IpcAdapterError>,
        events: RecordingEvents,
    ) -> IpcFixture {
        let (effect_tx, effect_rx) = mpsc::channel::<Effect>(1);
        let (accepted_tx, accepted_rx) = mpsc::channel::<Box<dyn SessionStream>>(16);
        let listener_cancel = CancellationToken::new();
        let listener_result = Arc::new(Mutex::new(Some(listener_result)));
        let (ready_tx, ready_rx) = oneshot::channel::<()>();
        // A simulated listener bridge: idle until cancellation or an explicit
        // ready-drop, then report its scripted result.
        let listener_join = {
            let cancel = listener_cancel.clone();
            let result = Arc::clone(&listener_result);
            tokio::spawn(async move {
                tokio::select! {
                    _ = cancel.cancelled() => {}
                    _ = ready_rx => {}
                }
                result.lock().unwrap().take().unwrap_or(Ok(()))
            })
        };
        let manager = tokio::spawn(run_ipc_manager(
            effect_rx,
            accepted_rx,
            listener_cancel.clone(),
            listener_join,
            events.clone(),
            capacity,
        ));
        IpcFixture {
            events,
            effects: effect_tx,
            accepted: Some(accepted_tx),
            listener_cancel,
            listener_result,
            listener_ready: Some(ready_tx),
            manager: Some(manager),
            next_op: 1,
            connected_seen: 0,
            handles: HashMap::new(),
            all_handles: Vec::new(),
        }
    }

    fn next_op(&mut self) -> OperationId {
        let op = OperationId(self.next_op);
        self.next_op += 1;
        op
    }

    /// The recorder every client event is emitted into.
    pub(crate) fn events(&self) -> &RecordingEvents {
        &self.events
    }

    /// Injects a fake stream without waiting for it to connect, returning the
    /// handle a test keeps to drive/inspect it.
    pub(crate) async fn inject(&mut self, stream: FakeSessionStream) -> FakeStreamHandle {
        let handle = FakeStreamHandle {
            inner: Arc::clone(&stream.inner),
        };
        self.all_handles.push(handle.clone());
        self.accepted
            .as_ref()
            .expect("accept still open")
            .send(Box::new(stream))
            .await
            .expect("manager accepts stream");
        handle
    }

    /// Injects a healthy fake stream and waits for its
    /// [`SessionEvent::ClientConnected`], returning the assigned [`ClientId`].
    pub(crate) async fn connect_client(&mut self) -> ClientId {
        let (stream, handle) = FakeSessionStream::new();
        self.all_handles.push(handle.clone());
        self.accepted
            .as_ref()
            .expect("accept still open")
            .send(Box::new(stream))
            .await
            .expect("manager accepts stream");
        let index = self.connected_seen;
        let id = self.events.wait_connected(index).await;
        self.connected_seen += 1;
        self.handles.insert(id, handle);
        id
    }

    /// The handle for a previously connected client.
    pub(crate) fn handle(&self, client: ClientId) -> FakeStreamHandle {
        self.handles.get(&client).expect("known client").clone()
    }

    /// Wedges a client's writer: gate its writes, enqueue one filler frame it
    /// begins writing (occupying the in-flight slot), and wait until that write
    /// has begun so the per-client queue's remaining capacity is exact.
    pub(crate) async fn pause_writer(&mut self, client: ClientId) {
        let handle = self.handle(client);
        let (started_tx, started_rx) = oneshot::channel();
        handle.arm_pause(started_tx);
        let op = self.next_op();
        self.effects
            .send(Effect::SendClient {
                client_id: client,
                operation_id: op,
                bytes: b"<filler>".to_vec(),
            })
            .await
            .expect("effect route open");
        started_rx.await.expect("writer began the gated write");
    }

    /// Feeds inbound bytes to a client's reader (a real peer write).
    pub(crate) fn feed(&self, client: ClientId, bytes: &[u8]) {
        self.handle(client).feed(bytes);
    }

    /// Signals a normal peer close on a client's read side.
    pub(crate) fn close_peer(&self, client: ClientId) {
        self.handle(client).close_peer();
    }

    /// Drains and returns the bytes a client's writer has written.
    pub(crate) async fn read(&self, client: ClientId) -> Vec<u8> {
        self.handle(client).read_written().await
    }

    /// Sends one outbound frame to `client` through the effect route, flushing
    /// the manager afterwards. Returns `Err` if the send isolated the client
    /// (its per-client queue was full/closed), `Ok` otherwise.
    pub(crate) async fn send(&mut self, client: ClientId, bytes: &[u8]) -> Result<(), SendFailure> {
        let before = self.count_send_failed(client);
        let op = self.next_op();
        self.effects
            .send(Effect::SendClient {
                client_id: client,
                operation_id: op,
                bytes: bytes.to_vec(),
            })
            .await
            .expect("effect route open");
        self.flush_manager().await;
        if self.count_send_failed(client) > before {
            Err(SendFailure { client_id: client })
        } else {
            Ok(())
        }
    }

    /// Sends a raw effect to the manager (for the unexpected-effect and
    /// stop/close tests).
    pub(crate) async fn send_effect(&self, effect: Effect) {
        self.effects.send(effect).await.expect("effect route open");
    }

    /// A `CloseClient` effect for `client`, then flush the manager so the close
    /// has been processed.
    pub(crate) async fn close_client(&mut self, client: ClientId) {
        self.send_effect(Effect::CloseClient { client_id: client })
            .await;
        self.flush_manager().await;
    }

    /// A `StopAcceptingClients` effect, then flush the manager.
    pub(crate) async fn stop_accepting(&mut self) {
        self.send_effect(Effect::StopAcceptingClients).await;
        self.flush_manager().await;
    }

    fn count_send_failed(&self, client: ClientId) -> usize {
        self.events
            .send_failed()
            .into_iter()
            .filter(|(id, _)| *id == client)
            .count()
    }

    /// Flushes the manager: with the capacity-one effect channel, two probe
    /// effects to a sentinel client cannot be accepted until the manager has
    /// fully processed every earlier effect, so on return all prior effects are
    /// done.
    pub(crate) async fn flush_manager(&mut self) {
        for _ in 0..2 {
            let op = self.next_op();
            self.effects
                .send(Effect::SendClient {
                    client_id: SYNC_SENTINEL,
                    operation_id: op,
                    bytes: Vec::new(),
                })
                .await
                .expect("effect route open");
        }
    }

    /// Awaits the next [`SessionEvent::ClientDisconnected`] after `after` prior
    /// disconnects.
    pub(crate) async fn wait_disconnected(&self, after: usize) -> ClientId {
        self.events.wait_disconnected(after).await
    }

    /// Awaits the next [`SessionEvent::ClientSendFailed`] after `after` prior send
    /// failures.
    pub(crate) async fn wait_send_failed(&self, after: usize) -> (ClientId, OperationId) {
        self.events.wait_send_failed(after).await
    }

    /// Awaits until at least `count` frames have been recorded for `client`.
    pub(crate) async fn wait_frames(&self, client: ClientId, count: usize) -> Vec<DecodedFrame> {
        self.events.wait_frames(client, count).await
    }

    /// Simulates a fatal listener error: drop the listener "ready" trigger so the
    /// simulated bridge resolves to its scripted result, and close the accepted
    /// channel so the manager observes the bridge stopping.
    pub(crate) fn fail_listener(&mut self) {
        self.listener_ready.take();
        self.accepted.take();
    }

    /// Drops the effect route and awaits the manager, returning its result. The
    /// accepted-stream channel is left open (the simulated bridge is cancelled by
    /// the manager's own graceful shutdown), mirroring production where only the
    /// bridge closes that channel.
    pub(crate) async fn finish(mut self) -> Result<(), IpcAdapterError> {
        // Replace the effect sender with a dead one so the manager's route closes.
        let (dead_tx, _dead_rx) = mpsc::channel::<Effect>(1);
        self.effects = dead_tx;
        let manager = self.manager.take().expect("manager present");
        tokio::time::timeout(ANTI_HANG, manager)
            .await
            .expect("manager finished")
            .expect("manager task joined")
    }

    /// Awaits the manager's result without dropping the effect route (for tests
    /// where a fatal condition — an unexpected effect, a closed lane, or a fatal
    /// listener error — makes the manager exit on its own).
    pub(crate) async fn join_manager(&mut self) -> Result<(), IpcAdapterError> {
        let manager = self.manager.take().expect("manager present");
        tokio::time::timeout(ANTI_HANG, manager)
            .await
            .expect("manager finished")
            .expect("manager task joined")
    }
}

impl Drop for IpcFixture {
    fn drop(&mut self) {
        // Force every fake stream down first, so a paused/parked blocking worker
        // is always woken and can exit — otherwise the runtime's shutdown would
        // wait forever on a gated write. Then cancel the simulated listener and
        // abort the manager.
        for handle in &self.all_handles {
            handle.force_shutdown();
        }
        self.listener_cancel.cancel();
        let _ = &self.listener_result;
        if let Some(manager) = self.manager.take() {
            manager.abort();
        }
    }
}
