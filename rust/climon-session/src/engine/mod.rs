//! Temporary stub for the actor-based session engine.
//!
//! This module will host the idiomatic Rust rewrite of the session daemon
//! (see the design/plan docs). Until that work lands, selecting the actor
//! engine via `CLIMON_SESSION_ENGINE=actor` fails fast with
//! [`SessionError::ActorUnavailable`].

use climon_proto::meta::SessionMeta;

use crate::error::{SessionError, SessionResult};
use crate::host::SessionHostOptions;

pub fn run_session_host(
    _id: &str,
    _meta: SessionMeta,
    _options: SessionHostOptions,
) -> SessionResult<i32> {
    Err(SessionError::ActorUnavailable)
}
