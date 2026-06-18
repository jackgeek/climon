//! climon self-update library. Rust port of the TypeScript `src/update/*`
//! client updater modules.
//!
//! The cryptographic schemes (Ed25519 detached signatures, the
//! AES-256-GCM + scrypt encryption envelope) and the embedded update public key
//! match the Bun release tooling **byte-for-byte**, so a Rust client can verify
//! and decrypt artifacts produced by the existing release pipeline. The
//! self-swap is atomic and never kills running sessions or the running process.
//!
//! Modules mirror their TS source files:
//! - [`verify`]          <- `src/update/verify.ts`
//! - [`pubkey`]          <- `src/update/pubkey.ts`
//! - [`crypto_envelope`] <- `src/update/crypto-envelope.ts`

pub mod check;
pub mod clock;
pub mod crypto_envelope;
pub mod download;
pub mod install_manifest;
pub mod launch_hooks;
pub mod manifest;
pub mod pubkey;
pub mod state;
pub mod swap;
pub mod update_cli;
pub mod update_cmd;
pub mod verify;
pub mod version;
