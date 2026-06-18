//! The climon version, injected at build time from `package.json` by `build.rs`.
//! Mirrors `src/version.ts` so the updater compares against the same value the
//! Bun client reports.

/// The climon version (e.g. `1.0.6`).
pub const VERSION: &str = env!("CLIMON_VERSION");
