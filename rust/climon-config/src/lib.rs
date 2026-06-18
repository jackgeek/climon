//! climon configuration subsystem.
//!
//! A 1:1 Rust port of the TypeScript client's config surface so the Rust client
//! reads, cascades, and writes config files byte-for-byte compatibly with the
//! unmodified Bun server. Modules mirror their TS source files:
//!
//! - [`features`]        <- `src/features.ts`
//! - [`config_settings`] <- `src/config-settings.ts`
//! - [`jsonc`]           <- `src/config-jsonc.ts`
//! - [`config`]          <- `src/config.ts`
//! - [`docs`]            <- `scripts/generate-config-docs.ts`
//!
//! The dynamic config representation is [`serde_json::Value`] (mirroring the TS
//! `Record<string, unknown>`); the JSONC writer is hand-rolled so it regenerates
//! registry comments exactly like `renderJsoncConfig` rather than round-tripping
//! through a generic serializer that would drop comments.

pub mod config;
pub mod config_settings;
pub mod docs;
pub mod features;
pub mod jsonc;
