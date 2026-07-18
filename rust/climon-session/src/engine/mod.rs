//! The actor-based session engine.
//!
//! Selecting the actor engine via `CLIMON_SESSION_ENGINE=actor` runs the
//! [`supervisor`], which owns a multi-thread Tokio runtime, brings the
//! coordinator and every resource adapter up and down, and returns the child's
//! exit code. [`run_session_host`] is the synchronous boundary the host facade
//! calls; it owns the runtime and blocks on the async [`supervisor::run`].

use std::time::Duration;

use climon_proto::meta::SessionMeta;

use crate::error::{SessionError, SessionResult};
use crate::host::SessionHostOptions;

pub(crate) mod coordinator;
pub(crate) mod effect;
pub(crate) mod event;
pub(crate) mod state;
#[cfg(test)]
mod stress;
pub(crate) mod supervisor;

/// Bounded capacity of the pty event lane (pty output/exit/failure).
pub(crate) const PTY_EVENT_CAPACITY: usize = 64;
/// Bounded capacity of the control event lane (all other events).
pub(crate) const CONTROL_EVENT_CAPACITY: usize = 64;
/// Bounded capacity of the pty command effect route (write/resize/kill).
pub(crate) const PTY_COMMAND_CAPACITY: usize = 128;
/// Bounded capacity of the client output effect route (send/close/stop).
pub(crate) const CLIENT_OUTPUT_CAPACITY: usize = 128;
/// Bounded capacity of the console output effect route (local writes).
pub(crate) const CONSOLE_OUTPUT_CAPACITY: usize = 64;
/// Bounded capacity of the metadata command effect route (patch/persist).
pub(crate) const METADATA_COMMAND_CAPACITY: usize = 64;

/// Runs the actor session engine to completion, owning its Tokio runtime.
///
/// Builds a multi-thread runtime and blocks on the async [`supervisor::run`],
/// which supervises the coordinator and adapters and returns the child's exit
/// code. The synchronous signature keeps the [`crate::host`] facade and the
/// hidden `climon __session` command unchanged.
pub fn run_session_host(
    id: &str,
    meta: SessionMeta,
    options: SessionHostOptions,
) -> SessionResult<i32> {
    block_on_session(
        supervisor::run(id.to_string(), meta, options),
        supervisor::JOIN_DEADLINE,
    )
}

/// Builds the actor engine's owned multi-thread runtime, blocks on `future`, and
/// then shuts the runtime down within `shutdown_deadline` rather than relying on
/// `Runtime`'s `Drop`.
///
/// The supervisor's teardown already drains and joins every owned task within
/// its own bounded deadline, so the normal path leaves nothing pending here and
/// this shutdown returns at once. But a `spawn_blocking` worker that ignored
/// cancellation (a local input read) is abandoned at that deadline, and dropping
/// a multi-thread runtime blocks the calling thread until the blocking pool
/// drains — forever, for such a worker. Bounding the shutdown keeps the
/// synchronous facade's return (and thus the daemon's exit) bounded even in that
/// degraded case; the abandoned worker is leaked and reaped when the process
/// exits. This is degraded cleanup only, never the normal path's
/// task-draining mechanism, so no owned work is detached under normal operation.
fn block_on_session<F>(future: F, shutdown_deadline: Duration) -> SessionResult<i32>
where
    F: std::future::Future<Output = SessionResult<i32>>,
{
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(SessionError::Io)?;
    let result = runtime.block_on(future);
    runtime.shutdown_timeout(shutdown_deadline);
    result
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use super::block_on_session;

    /// Runs `f` on a dedicated OS thread and fails the test if it does not finish
    /// within `bound` of real time, so a runtime-drop hang surfaces as a clean
    /// assertion failure rather than an indefinitely blocked (and undroppable)
    /// runtime. The worker thread is intentionally leaked on a hang; the test
    /// process reaps it on exit.
    fn run_bounded<T, F>(bound: Duration, f: F) -> T
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(f());
        });
        match rx.recv_timeout(bound) {
            Ok(value) => value,
            Err(_) => panic!("owned runtime did not return within {bound:?}: runtime-drop hang"),
        }
    }

    /// The synchronous facade owns the Tokio runtime, so it — not just the async
    /// supervisor — must stay bounded when the supervisor abandons a stuck
    /// `spawn_blocking` worker at its teardown deadline (a local input read that
    /// ignores cancellation). Dropping a multi-thread runtime blocks the calling
    /// thread until the blocking pool drains, so an unbounded drop hangs the
    /// daemon's exit forever even though the supervisor already returned. The
    /// facade must instead shut the runtime down within its bounded deadline and
    /// return the session result. The injected deadline is small so a real timer
    /// fires quickly, and a real-time watchdog turns any remaining hang into a
    /// failure.
    #[test]
    fn owned_runtime_returns_past_a_stuck_blocking_worker() {
        let code = run_bounded(Duration::from_secs(10), || {
            block_on_session(
                async {
                    // Model the abandoned local input worker: a spawn_blocking
                    // task that never returns. The supervisor's teardown leaves
                    // it running while the async work itself completes.
                    tokio::task::spawn_blocking(|| loop {
                        std::thread::park();
                    });
                    Ok(7)
                },
                Duration::from_millis(250),
            )
        })
        .expect("the owned-runtime facade returns the session result");
        assert_eq!(code, 7);
    }
}
