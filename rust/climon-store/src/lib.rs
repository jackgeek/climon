//! climon metadata store.
//!
//! A synchronous (`std::fs`, blocking) Rust port of the TypeScript client's
//! metadata store (`src/store.ts`, `src/session-id.ts`, `src/server-state.ts`).
//! It owns the `$CLIMON_HOME` filesystem layout that is the cross-process
//! coordination boundary between the client, the per-session daemon, and the
//! dashboard server. Wire/format compatibility with the unmodified Bun server is
//! the controlling invariant.
//!
//! Frozen [`climon_proto::meta::SessionMeta`] / [`climon_proto::meta::SessionMetaPatch`]
//! are reused, never redefined.

pub mod atomic;
pub mod error;
pub mod ipc_auth;
pub mod lock;
pub mod meta;
pub mod patch;
pub mod paths;
pub mod server_state;
pub mod session_id;

#[cfg(test)]
pub(crate) mod test_support;

pub use error::{StoreError, StoreResult};
pub use paths::Env;
pub use session_id::validate_session_id;
