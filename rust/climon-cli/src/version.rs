//! The climon version string, injected at build time from the repo-root
//! `package.json` by `build.rs`. Mirrors the TS `src/version.ts` so the Rust
//! client and the Bun client/server always report the same value.

/// The climon version (e.g. `1.0.6`), sourced from `package.json`.
pub const VERSION: &str = env!("CLIMON_VERSION");
