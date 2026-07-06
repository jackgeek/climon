//! climon remote uplink/ingest bridge.
//!
//! A faithful Rust port of the TypeScript client's `src/remote/` tree. It keeps
//! byte-for-byte wire/metadata interop with the unchanged Bun dashboard server
//! and the existing Bun client's remote peers. Modules mirror their TS source:
//!
//! - [`mux`]              <- `src/remote/mux.ts` (byte-critical framing)
//! - [`client_id`]        <- `src/remote/client-id.ts`
//! - [`ingest_port`]      <- `src/remote/ingest-port.ts`
//! - [`ingest_bind_host`] <- `src/remote/ingest-bind-host.ts`
//! - [`ingest_state`]     <- `src/remote/ingest-state.ts`
//! - [`keepalive`]        <- `src/remote/keepalive.ts`
//! - [`peer`]             <- `src/remote/peer.ts`
//! - [`remote_host`]      <- `RemoteHostState` from `src/remote/ingest.ts`
//!
//! All remote input is treated as untrusted; see `docs/security.md`.

pub mod client_id;
pub mod demotion;
pub mod discovery;
pub mod ingest;
pub mod ingest_bind_host;
pub mod ingest_port;
pub mod ingest_state;
pub mod ingest_status;
pub mod ingest_tunnel_id;
pub mod keepalive;
pub mod link;
pub mod mux;
pub mod peer;
pub mod process;
pub mod remote_host;
pub mod shutdown_request;
pub mod shutdown_watch;
pub mod singleton;
pub mod spawn_auth;
pub mod target_set;
pub mod teardown;
pub mod time;
pub mod tunnel;
pub mod uplink;
pub mod uplink_status;
