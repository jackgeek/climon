//! climon self-update library. Rust port of the TypeScript `src/update/*`
//! client updater modules.
//!
//! The Ed25519 detached signature scheme and embedded update public key match
//! the Bun release tooling **byte-for-byte**, so a Rust client can verify
//! artifacts produced by the existing release pipeline.
//!
//! Modules mirror their TS source files:
//! - [`verify`]          <- `src/update/verify.ts`
//! - [`pubkey`]          <- `src/update/pubkey.ts`

pub mod artifact;
pub mod bootstrap;
pub mod check;
pub mod clock;
pub mod download;
pub mod launch_hooks;
pub mod manifest;
pub mod pointer;
pub mod pubkey;
pub mod reaper;
pub mod state;
pub mod update_cli;
pub mod update_cmd;
pub mod verify;
pub mod version;
