//! The actor-based session engine.
//!
//! Selecting the actor engine via `CLIMON_SESSION_ENGINE=actor` runs the
//! [`supervisor`], which owns a multi-thread Tokio runtime, brings the
//! coordinator and every resource adapter up and down, and returns the child's
//! exit code. [`run_session_host`] is the synchronous boundary the host facade
//! calls; it owns the runtime and blocks on the async [`supervisor::run`].

use climon_proto::meta::SessionMeta;

use crate::error::{SessionError, SessionResult};
use crate::host::SessionHostOptions;

pub(crate) mod coordinator;
pub(crate) mod effect;
pub(crate) mod event;
pub(crate) mod state;
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
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(SessionError::Io)?;
    runtime.block_on(supervisor::run(id.to_string(), meta, options))
}
