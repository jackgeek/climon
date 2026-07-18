//! Temporary stub for the actor-based session engine.
//!
//! This module will host the idiomatic Rust rewrite of the session daemon
//! (see the design/plan docs). Until that work lands, selecting the actor
//! engine via `CLIMON_SESSION_ENGINE=actor` fails fast with
//! [`SessionError::ActorUnavailable`].

use climon_proto::meta::SessionMeta;

use crate::error::{SessionError, SessionResult};
use crate::host::SessionHostOptions;

pub(crate) mod coordinator;
pub(crate) mod effect;
pub(crate) mod event;
pub(crate) mod state;

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

pub fn run_session_host(
    _id: &str,
    _meta: SessionMeta,
    _options: SessionHostOptions,
) -> SessionResult<i32> {
    Err(SessionError::ActorUnavailable)
}
