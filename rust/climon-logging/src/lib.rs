//! `climon-logging` — Rust port of the TypeScript client logging subsystem
//! (`src/logging/*`).
//!
//! Provides structured NDJSON logging with pino-compatible numeric levels,
//! secret redaction, pretty terminal formatting, file sinks, and CLI I/O tee
//! helpers. The crate is sync and dependency-light (only `serde_json`).
//!
//! See `docs/superpowers/plans/2026-06-19-phase04-climon-logging.md` for the
//! port plan, including the documented decision to skip the server-only
//! Application Insights telemetry transport/transform.

pub mod cli_io;
pub mod env;
pub mod level;
pub mod logger;
pub mod pretty;
pub mod redact;
pub mod sinks;

/// Process-wide lock for tests that touch global state (the terminal-suspended
/// flag and the process-global logger). Held while a test mutates or reads that
/// state so the default parallel test runner cannot interleave them.
#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    use std::sync::{Mutex, OnceLock};
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
