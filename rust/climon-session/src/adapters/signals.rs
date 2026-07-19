//! Signals / resize adapter: the owned workers that turn OS termination and
//! window-size changes into engine events, terminating on the supervisor's
//! cancellation token.
//!
//! Two platform-shaped workers share the same cfg-free cores:
//!
//! - on **Unix**, one owned signal loop registers `SIGTERM`/`SIGINT`/`SIGWINCH`
//!   and, each cycle, drains already-pending signals and then parks a bounded
//!   interval — never blocking forever in `Signals::forever()`. `SIGTERM`/
//!   `SIGINT` emit [`SessionEvent::ShutdownRequested`] (duplicates are fine; the
//!   state is idempotent) and never kill the pty directly; `SIGWINCH` reads the
//!   current local size and emits [`SessionEvent::LocalResized`].
//! - on **Windows** (no `SIGWINCH`), one owned poller samples the visible
//!   console size every 200 ms and emits [`SessionEvent::LocalResized`] only when
//!   it *changes*. It carries no Unix-only signal behaviour.
//!
//! Both cores ([`run_signal_loop`] and [`run_resize_poller`]) are
//! platform-agnostic and driven by injected source traits, so tests exercise the
//! exact production logic — signal batches, size sequences, dedupe, cancellation,
//! and a closed event lane — without sending real process signals. Every
//! event-lane failure is an explicit [`SignalAdapterError`]; the workers return
//! owned [`JoinHandle`]s and are never detached.
//!
//! [`SessionEvent::ShutdownRequested`]: crate::engine::event::SessionEvent::ShutdownRequested
//! [`SessionEvent::LocalResized`]: crate::engine::event::SessionEvent::LocalResized

// Every item below is exercised by this module's tests now and wired into the
// supervisor (Task 14) later, so — like the other adapters it mirrors — the
// module carries a crate-staged `dead_code` allowance until that wiring lands.
#![allow(dead_code)]

use std::fmt;
use std::time::Duration;

use tokio::task::{spawn_blocking, JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::engine::coordinator::ControlEventSender;
use crate::engine::event::SessionEvent;

/// How long the Unix signal loop parks between pending-signal drains. Bounds the
/// cancellation latency of an otherwise-idle signal loop without a busy spin.
const SIGNAL_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// How long the Windows resize poller parks between console-size samples. Matches
/// the legacy host's 200 ms console-resize poll.
const RESIZE_POLL_INTERVAL: Duration = Duration::from_millis(200);

// ---- errors ------------------------------------------------------------

/// A failure that ends a signals/resize worker. Every variant is payload-free.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SignalAdapterError {
    /// The control event lane closed, so a shutdown/resize event could not be
    /// delivered. The worker reports this rather than exiting silently.
    EventLaneClosed,
    /// The underlying signal source failed (e.g. its registration/iterator
    /// broke). Carries a payload-free cause string.
    SignalSource(String),
}

impl fmt::Display for SignalAdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SignalAdapterError::EventLaneClosed => write!(
                f,
                "control event lane closed before a signal/resize event was delivered"
            ),
            SignalAdapterError::SignalSource(cause) => {
                write!(f, "signal source failed: {cause}")
            }
        }
    }
}

impl std::error::Error for SignalAdapterError {}

// ---- event sink --------------------------------------------------------

/// Blocking delivery of the control-lane events the signals/resize workers emit
/// (shutdown, local resize). Both workers run off the Tokio workers (dedicated
/// `spawn_blocking` tasks), so events are emitted with a blocking call.
/// Implemented for [`ControlEventSender`] in production; a closed lane is
/// reported as [`SignalAdapterError::EventLaneClosed`].
pub(crate) trait SignalEventSink: Send + 'static {
    /// Emits `event`, blocking for bounded capacity, or failing if the lane has
    /// closed.
    fn emit(&self, event: SessionEvent) -> Result<(), SignalAdapterError>;
}

impl SignalEventSink for ControlEventSender {
    fn emit(&self, event: SessionEvent) -> Result<(), SignalAdapterError> {
        // Shutdown/resize are always control-lane events, so `WrongLane` is
        // unreachable; treat either lane failure as a closed lane.
        self.blocking_send(event)
            .map_err(|_| SignalAdapterError::EventLaneClosed)
    }
}

// ---- signal source (Unix) ----------------------------------------------

/// A termination/resize signal the adapter reacts to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SignalKind {
    /// `SIGTERM` — graceful termination.
    Terminate,
    /// `SIGINT` — interactive interrupt.
    Interrupt,
    /// `SIGWINCH` — the controlling terminal was resized.
    WindowChange,
}

/// The outcome of one [`SignalSource::poll`].
pub(crate) enum SignalPoll {
    /// The signals received since the last poll (possibly empty).
    Signals(Vec<SignalKind>),
    /// The adapter was cancelled during the poll; the loop exits.
    Cancelled,
}

/// The signal source the Unix loop owns. Kept behind a trait so tests can inject
/// signal batches without sending real process signals. Each `poll` returns
/// promptly (draining pending signals, then parking a bounded interval) and
/// reports [`SignalPoll::Cancelled`] rather than blocking forever.
pub(crate) trait SignalSource: Send + 'static {
    /// Returns the signals received since the last poll, or
    /// [`SignalPoll::Cancelled`] if the adapter was cancelled while waiting. A
    /// payload-free `Err` string describes an unexpected source failure.
    fn poll(&mut self, cancel: &CancellationToken) -> Result<SignalPoll, String>;
}

/// The current local terminal size, read for a `SIGWINCH`. Kept behind a trait
/// so tests can inject a size without a real terminal.
pub(crate) trait LocalSizeSource: Send + 'static {
    /// The current visible `(cols, rows)` of the local terminal.
    fn current_size(&self) -> (u16, u16);
}

/// Runs the Unix signal loop to completion: on each poll, translate every
/// received signal into an event — `SIGTERM`/`SIGINT` to
/// [`SessionEvent::ShutdownRequested`], `SIGWINCH` to
/// [`SessionEvent::LocalResized`] with the current local size — until the source
/// reports cancellation (or the top-level token is already cancelled). A closed
/// lane returns [`SignalAdapterError::EventLaneClosed`]; a source failure returns
/// [`SignalAdapterError::SignalSource`]. Never kills the pty directly.
fn run_signal_loop<S, Z, E>(
    mut signals: S,
    size: Z,
    events: E,
    cancel: CancellationToken,
) -> Result<(), SignalAdapterError>
where
    S: SignalSource,
    Z: LocalSizeSource,
    E: SignalEventSink,
{
    loop {
        if cancel.is_cancelled() {
            return Ok(());
        }
        match signals
            .poll(&cancel)
            .map_err(SignalAdapterError::SignalSource)?
        {
            SignalPoll::Cancelled => return Ok(()),
            SignalPoll::Signals(kinds) => {
                for kind in kinds {
                    match kind {
                        SignalKind::Terminate | SignalKind::Interrupt => {
                            events.emit(SessionEvent::ShutdownRequested)?;
                        }
                        SignalKind::WindowChange => {
                            let (cols, rows) = size.current_size();
                            events.emit(SessionEvent::LocalResized { cols, rows })?;
                        }
                    }
                }
            }
        }
    }
}

// ---- resize poller (Windows) -------------------------------------------

/// The outcome of one [`ResizeSizeSource::poll`].
pub(crate) enum SizePoll {
    /// The visible size sampled after the poll interval.
    Sample((u16, u16)),
    /// The adapter was cancelled during the poll; the loop exits.
    Cancelled,
}

/// The console-size source the Windows poller owns. Kept behind a trait so tests
/// can inject a size sequence without a real console. Each `poll` parks the poll
/// interval (observing cancellation) and then samples the visible size.
pub(crate) trait ResizeSizeSource: Send + 'static {
    /// Parks the poll interval, then returns the current visible size, or
    /// [`SizePoll::Cancelled`] if the adapter was cancelled while waiting.
    fn poll(&mut self, cancel: &CancellationToken) -> SizePoll;
}

/// Runs the resize poller to completion: sample the visible size each interval
/// and emit [`SessionEvent::LocalResized`] **only when it changes** from the last
/// sample, until the source reports cancellation. A closed lane returns
/// [`SignalAdapterError::EventLaneClosed`]. This core is platform-agnostic so it
/// is tested on every platform even where the real console source is Windows-only.
fn run_resize_poller<Z, E>(
    mut source: Z,
    initial: (u16, u16),
    events: E,
    cancel: CancellationToken,
) -> Result<(), SignalAdapterError>
where
    Z: ResizeSizeSource,
    E: SignalEventSink,
{
    let mut last = initial;
    loop {
        if cancel.is_cancelled() {
            return Ok(());
        }
        match source.poll(&cancel) {
            SizePoll::Cancelled => return Ok(()),
            SizePoll::Sample(size) => {
                if size != last {
                    last = size;
                    events.emit(SessionEvent::LocalResized {
                        cols: size.0,
                        rows: size.1,
                    })?;
                }
            }
        }
    }
}

/// Sleeps up to `total`, in small steps, returning `true` as soon as `cancel`
/// fires. Lets the blocking production sources park between samples while still
/// observing cancellation promptly.
fn sleep_or_cancel(cancel: &CancellationToken, total: Duration) -> bool {
    const STEP: Duration = Duration::from_millis(20);
    let mut remaining = total;
    while remaining > Duration::ZERO {
        if cancel.is_cancelled() {
            return true;
        }
        let nap = remaining.min(STEP);
        std::thread::sleep(nap);
        remaining = remaining.saturating_sub(nap);
    }
    cancel.is_cancelled()
}

// ---- production assembly -----------------------------------------------

#[cfg(unix)]
mod platform {
    use super::{
        run_signal_loop, sleep_or_cancel, LocalSizeSource, SignalAdapterError, SignalEventSink,
        SignalKind, SignalPoll, SignalSource, SIGNAL_POLL_INTERVAL,
    };
    use std::io;

    use climon_pty::terminal_size;
    use signal_hook::consts::{SIGINT, SIGTERM, SIGWINCH};
    use signal_hook::iterator::Signals;
    use tokio::task::{spawn_blocking, JoinHandle};
    use tokio_util::sync::CancellationToken;

    /// The production [`SignalSource`]: owns a `signal_hook` registration for
    /// `SIGTERM`/`SIGINT`/`SIGWINCH`. Each poll drains the already-pending
    /// signals (non-blocking) and, when none are pending, parks a bounded
    /// interval — never `Signals::forever()`, which cannot be cancelled.
    struct SignalHookSource {
        signals: Signals,
    }

    impl SignalHookSource {
        fn new() -> io::Result<SignalHookSource> {
            Ok(SignalHookSource {
                signals: Signals::new([SIGTERM, SIGINT, SIGWINCH])?,
            })
        }
    }

    impl SignalSource for SignalHookSource {
        fn poll(&mut self, cancel: &CancellationToken) -> Result<SignalPoll, String> {
            let mut kinds = Vec::new();
            for signal in self.signals.pending() {
                match signal {
                    SIGTERM => kinds.push(SignalKind::Terminate),
                    SIGINT => kinds.push(SignalKind::Interrupt),
                    SIGWINCH => kinds.push(SignalKind::WindowChange),
                    _ => {}
                }
            }
            if !kinds.is_empty() {
                return Ok(SignalPoll::Signals(kinds));
            }
            if sleep_or_cancel(cancel, SIGNAL_POLL_INTERVAL) {
                return Ok(SignalPoll::Cancelled);
            }
            Ok(SignalPoll::Signals(Vec::new()))
        }
    }

    /// The production [`LocalSizeSource`]: reads stdin's terminal size for a
    /// `SIGWINCH`.
    struct UnixLocalSize;

    impl LocalSizeSource for UnixLocalSize {
        fn current_size(&self) -> (u16, u16) {
            terminal_size(libc::STDIN_FILENO)
        }
    }

    /// Spawns the Unix signal adapter on a dedicated blocking thread and returns
    /// its owned handle. Fails only if the signal registration cannot be created.
    /// No task is detached; the supervisor owns and later joins the handle.
    pub(crate) fn spawn_signal_adapter<E: SignalEventSink>(
        events: E,
        cancel: CancellationToken,
    ) -> io::Result<JoinHandle<Result<(), SignalAdapterError>>> {
        let signals = SignalHookSource::new()?;
        Ok(spawn_blocking(move || {
            run_signal_loop(signals, UnixLocalSize, events, cancel)
        }))
    }
}

#[cfg(windows)]
mod platform {
    use super::{
        run_resize_poller, sleep_or_cancel, ResizeSizeSource, SignalAdapterError, SignalEventSink,
        SizePoll, RESIZE_POLL_INTERVAL,
    };

    use climon_pty::terminal_size;
    use tokio::task::{spawn_blocking, JoinHandle};
    use tokio_util::sync::CancellationToken;

    /// The production [`ResizeSizeSource`]: parks 200 ms, then samples the
    /// visible console size (a null handle falls back to `STD_OUTPUT_HANDLE`).
    struct ConsoleSizeSource;

    impl ResizeSizeSource for ConsoleSizeSource {
        fn poll(&mut self, cancel: &CancellationToken) -> SizePoll {
            if sleep_or_cancel(cancel, RESIZE_POLL_INTERVAL) {
                return SizePoll::Cancelled;
            }
            SizePoll::Sample(terminal_size(std::ptr::null_mut()))
        }
    }

    /// Spawns the Windows resize adapter on a dedicated blocking thread and
    /// returns its owned handle. No task is detached; the supervisor owns and
    /// later joins the handle.
    pub(crate) fn spawn_resize_adapter<E: SignalEventSink>(
        events: E,
        cancel: CancellationToken,
    ) -> JoinHandle<Result<(), SignalAdapterError>> {
        let initial = terminal_size(std::ptr::null_mut());
        spawn_blocking(move || run_resize_poller(ConsoleSizeSource, initial, events, cancel))
    }
}

#[cfg(windows)]
#[allow(unused_imports)]
pub(crate) use platform::spawn_resize_adapter;
#[cfg(unix)]
#[allow(unused_imports)]
pub(crate) use platform::spawn_signal_adapter;

/// Spawns the resize-only adapter used to observe local size changes. On Windows
/// this is the console-size poller; on Unix, resize arrives via `SIGWINCH` in the
/// signal adapter, so this is provided for cross-platform callers as the
/// cfg-free core wired to a caller-supplied source.
pub(crate) fn spawn_resize_poller<Z, E>(
    source: Z,
    initial: (u16, u16),
    events: E,
    cancel: CancellationToken,
) -> JoinHandle<Result<(), SignalAdapterError>>
where
    Z: ResizeSizeSource,
    E: SignalEventSink,
{
    spawn_blocking(move || run_resize_poller(source, initial, events, cancel))
}

/// Spawns the signal adapter wired to caller-supplied sources. The production
/// Unix entry point ([`platform::spawn_signal_adapter`]) builds the real
/// `signal_hook` source; this cfg-free spawner is used by callers that own their
/// sources (and by tests).
pub(crate) fn spawn_signal_loop<S, Z, E>(
    signals: S,
    size: Z,
    events: E,
    cancel: CancellationToken,
) -> JoinHandle<Result<(), SignalAdapterError>>
where
    S: SignalSource,
    Z: LocalSizeSource,
    E: SignalEventSink,
{
    spawn_blocking(move || run_signal_loop(signals, size, events, cancel))
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tokio_util::sync::CancellationToken;

    use super::{
        run_resize_poller, run_signal_loop, LocalSizeSource, ResizeSizeSource, SignalAdapterError,
        SignalEventSink, SignalKind, SignalPoll, SignalSource, SizePoll,
    };
    use crate::engine::event::SessionEvent;

    const ANTI_HANG: Duration = Duration::from_secs(5);

    // ---- recording sink --------------------------------------------------

    /// A payload-free record of an emitted event, so tests assert behaviour
    /// without needing `SessionEvent` to be `Clone`/`Eq`.
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Recorded {
        Shutdown,
        Resized(u16, u16),
    }

    /// A [`SignalEventSink`] recording every emitted event into a shared vec; a
    /// `closed` flag simulates a closed control lane.
    #[derive(Clone)]
    struct RecordingSink {
        events: Arc<Mutex<Vec<Recorded>>>,
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

        fn recorded(&self) -> Vec<Recorded> {
            self.events.lock().unwrap().clone()
        }
    }

    impl SignalEventSink for RecordingSink {
        fn emit(&self, event: SessionEvent) -> Result<(), SignalAdapterError> {
            if self.closed.load(Ordering::SeqCst) {
                return Err(SignalAdapterError::EventLaneClosed);
            }
            let recorded = match event {
                SessionEvent::ShutdownRequested => Recorded::Shutdown,
                SessionEvent::LocalResized { cols, rows } => Recorded::Resized(cols, rows),
                other => panic!("unexpected event on the signal lane: {other:?}"),
            };
            self.events.lock().unwrap().push(recorded);
            Ok(())
        }
    }

    // ---- drop sentinel ---------------------------------------------------

    /// Flips a shared flag on drop, proving the worker ran to completion and
    /// released its owned source (i.e. was not detached).
    struct DropSentinel {
        dropped: Arc<AtomicBool>,
    }

    impl Drop for DropSentinel {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    // ---- fake sources ----------------------------------------------------

    /// A [`SignalSource`] that yields scripted signal batches, then reports
    /// cancellation once exhausted (or as soon as the token fires), so a test
    /// never blocks or sends a real signal.
    struct ScriptedSignals {
        batches: VecDeque<Vec<SignalKind>>,
        _sentinel: DropSentinel,
    }

    impl ScriptedSignals {
        fn new(
            batches: impl IntoIterator<Item = Vec<SignalKind>>,
            dropped: Arc<AtomicBool>,
        ) -> ScriptedSignals {
            ScriptedSignals {
                batches: batches.into_iter().collect(),
                _sentinel: DropSentinel { dropped },
            }
        }
    }

    impl SignalSource for ScriptedSignals {
        fn poll(&mut self, cancel: &CancellationToken) -> Result<SignalPoll, String> {
            if cancel.is_cancelled() {
                return Ok(SignalPoll::Cancelled);
            }
            match self.batches.pop_front() {
                Some(batch) => Ok(SignalPoll::Signals(batch)),
                None => Ok(SignalPoll::Cancelled),
            }
        }
    }

    /// A [`SignalSource`] that idles (empty batches) until cancelled, so a test
    /// can prove external cancellation joins the worker.
    struct IdleSignals {
        _sentinel: DropSentinel,
    }

    impl SignalSource for IdleSignals {
        fn poll(&mut self, cancel: &CancellationToken) -> Result<SignalPoll, String> {
            if cancel.is_cancelled() {
                return Ok(SignalPoll::Cancelled);
            }
            std::thread::sleep(Duration::from_millis(5));
            Ok(SignalPoll::Signals(Vec::new()))
        }
    }

    /// A [`SignalSource`] that fails on its first poll, so a test can prove a
    /// source failure surfaces as a typed error.
    struct FailingSignals;

    impl SignalSource for FailingSignals {
        fn poll(&mut self, _cancel: &CancellationToken) -> Result<SignalPoll, String> {
            Err("registration broke".to_string())
        }
    }

    /// A fixed local size for `SIGWINCH` handling.
    struct FixedSize((u16, u16));

    impl LocalSizeSource for FixedSize {
        fn current_size(&self) -> (u16, u16) {
            self.0
        }
    }

    /// A [`ResizeSizeSource`] that yields scripted samples, then reports
    /// cancellation once exhausted (or as soon as the token fires).
    struct ScriptedSizes {
        samples: VecDeque<(u16, u16)>,
        _sentinel: DropSentinel,
    }

    impl ScriptedSizes {
        fn new(
            samples: impl IntoIterator<Item = (u16, u16)>,
            dropped: Arc<AtomicBool>,
        ) -> ScriptedSizes {
            ScriptedSizes {
                samples: samples.into_iter().collect(),
                _sentinel: DropSentinel { dropped },
            }
        }
    }

    impl ResizeSizeSource for ScriptedSizes {
        fn poll(&mut self, cancel: &CancellationToken) -> SizePoll {
            if cancel.is_cancelled() {
                return SizePoll::Cancelled;
            }
            match self.samples.pop_front() {
                Some(sample) => SizePoll::Sample(sample),
                None => SizePoll::Cancelled,
            }
        }
    }

    /// A [`ResizeSizeSource`] that repeats one size until cancelled.
    struct IdleSizes {
        size: (u16, u16),
        _sentinel: DropSentinel,
    }

    impl ResizeSizeSource for IdleSizes {
        fn poll(&mut self, cancel: &CancellationToken) -> SizePoll {
            if cancel.is_cancelled() {
                return SizePoll::Cancelled;
            }
            std::thread::sleep(Duration::from_millis(5));
            SizePoll::Sample(self.size)
        }
    }

    // ---- signal tests ----------------------------------------------------

    // SIGTERM/SIGINT -> ShutdownRequested; SIGWINCH -> LocalResized (exact size).
    #[tokio::test]
    async fn signal_loop_maps_signals_to_events() {
        let sink = RecordingSink::new();
        let dropped = Arc::new(AtomicBool::new(false));
        let signals = ScriptedSignals::new(
            [
                vec![SignalKind::Terminate],
                vec![SignalKind::Interrupt],
                vec![SignalKind::WindowChange],
            ],
            dropped.clone(),
        );
        let cancel = CancellationToken::new();
        let handle = tokio::task::spawn_blocking({
            let sink = sink.clone();
            move || run_signal_loop(signals, FixedSize((120, 40)), sink, cancel)
        });
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("join timed out")
            .expect("task panicked");
        assert_eq!(result, Ok(()));
        assert_eq!(
            sink.recorded(),
            vec![
                Recorded::Shutdown,
                Recorded::Shutdown,
                Recorded::Resized(120, 40),
            ]
        );
        assert!(dropped.load(Ordering::SeqCst), "source not dropped");
    }

    // External cancellation joins the signal worker cleanly.
    #[tokio::test]
    async fn signal_loop_cancellation_joins() {
        let sink = RecordingSink::new();
        let dropped = Arc::new(AtomicBool::new(false));
        let signals = IdleSignals {
            _sentinel: DropSentinel {
                dropped: dropped.clone(),
            },
        };
        let cancel = CancellationToken::new();
        let handle = tokio::task::spawn_blocking({
            let cancel = cancel.clone();
            move || run_signal_loop(signals, FixedSize((80, 24)), sink, cancel)
        });
        // Let it idle a moment, then cancel and join.
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel.cancel();
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("join timed out")
            .expect("task panicked");
        assert_eq!(result, Ok(()));
        assert!(dropped.load(Ordering::SeqCst));
    }

    // A closed control lane while emitting is a typed error.
    #[tokio::test]
    async fn signal_loop_closed_lane_is_typed_error() {
        let sink = RecordingSink::closed();
        let dropped = Arc::new(AtomicBool::new(false));
        let signals = ScriptedSignals::new([vec![SignalKind::Terminate]], dropped.clone());
        let cancel = CancellationToken::new();
        let handle = tokio::task::spawn_blocking(move || {
            run_signal_loop(signals, FixedSize((80, 24)), sink, cancel)
        });
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("join timed out")
            .expect("task panicked");
        assert_eq!(result, Err(SignalAdapterError::EventLaneClosed));
        assert!(dropped.load(Ordering::SeqCst));
    }

    // A source failure surfaces as a typed error.
    #[tokio::test]
    async fn signal_loop_source_failure_is_typed_error() {
        let sink = RecordingSink::new();
        let cancel = CancellationToken::new();
        let handle = tokio::task::spawn_blocking(move || {
            run_signal_loop(FailingSignals, FixedSize((80, 24)), sink, cancel)
        });
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("join timed out")
            .expect("task panicked");
        assert!(matches!(
            result,
            Err(SignalAdapterError::SignalSource(cause)) if cause.contains("registration broke")
        ));
    }

    // ---- resize tests ----------------------------------------------------

    // Repeated same sizes emit nothing; each change emits exactly once.
    #[tokio::test]
    async fn resize_poller_dedupes_and_emits_on_change() {
        let sink = RecordingSink::new();
        let dropped = Arc::new(AtomicBool::new(false));
        let source = ScriptedSizes::new(
            [
                (80, 24),  // == initial: no emit
                (80, 24),  // repeat: no emit
                (100, 30), // change: emit
                (100, 30), // repeat: no emit
                (100, 30), // repeat: no emit
                (120, 40), // change: emit
            ],
            dropped.clone(),
        );
        let cancel = CancellationToken::new();
        let handle = tokio::task::spawn_blocking({
            let sink = sink.clone();
            move || run_resize_poller(source, (80, 24), sink, cancel)
        });
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("join timed out")
            .expect("task panicked");
        assert_eq!(result, Ok(()));
        assert_eq!(
            sink.recorded(),
            vec![Recorded::Resized(100, 30), Recorded::Resized(120, 40)]
        );
        assert!(dropped.load(Ordering::SeqCst));
    }

    // External cancellation joins the resize worker cleanly.
    #[tokio::test]
    async fn resize_poller_cancellation_joins() {
        let sink = RecordingSink::new();
        let dropped = Arc::new(AtomicBool::new(false));
        let source = IdleSizes {
            size: (80, 24),
            _sentinel: DropSentinel {
                dropped: dropped.clone(),
            },
        };
        let cancel = CancellationToken::new();
        let handle = tokio::task::spawn_blocking({
            let cancel = cancel.clone();
            move || run_resize_poller(source, (80, 24), sink, cancel)
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel.cancel();
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("join timed out")
            .expect("task panicked");
        assert_eq!(result, Ok(()));
        assert!(dropped.load(Ordering::SeqCst));
    }

    // A closed control lane while emitting a resize is a typed error.
    #[tokio::test]
    async fn resize_poller_closed_lane_is_typed_error() {
        let sink = RecordingSink::closed();
        let dropped = Arc::new(AtomicBool::new(false));
        // The first sample differs from the initial, forcing an emit.
        let source = ScriptedSizes::new([(100, 30)], dropped.clone());
        let cancel = CancellationToken::new();
        let handle =
            tokio::task::spawn_blocking(move || run_resize_poller(source, (80, 24), sink, cancel));
        let result = tokio::time::timeout(ANTI_HANG, handle)
            .await
            .expect("join timed out")
            .expect("task panicked");
        assert_eq!(result, Err(SignalAdapterError::EventLaneClosed));
        assert!(dropped.load(Ordering::SeqCst));
    }
}
