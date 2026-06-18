//! Log levels and effective-level resolution.
//!
//! Port of `src/logging/level.ts` (level set/parse/precedence) and the
//! `LogLevel` type from `src/logging/types.ts`. Numeric values match pino so
//! records and sinks order/filter identically to the TypeScript client.

use crate::env::Env;

/// A log level. Ordered by severity; `Silent` disables all output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
    Silent,
}

/// All levels, in the same order as the TypeScript `LEVELS` array.
pub const LOG_LEVELS: [LogLevel; 7] = [
    LogLevel::Trace,
    LogLevel::Debug,
    LogLevel::Info,
    LogLevel::Warn,
    LogLevel::Error,
    LogLevel::Fatal,
    LogLevel::Silent,
];

impl LogLevel {
    /// The wire string for this level (matches the TS union members).
    pub fn as_str(&self) -> &'static str {
        match self {
            LogLevel::Trace => "trace",
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
            LogLevel::Fatal => "fatal",
            LogLevel::Silent => "silent",
        }
    }

    /// Parses a level string, returning `None` for unknown values.
    pub fn from_str_opt(value: &str) -> Option<LogLevel> {
        LOG_LEVELS.into_iter().find(|l| l.as_str() == value)
    }

    /// The pino numeric level (`trace`=10 … `fatal`=60). `Silent` has no number
    /// (pino uses `Infinity`); represented as `None` so nothing ever passes a
    /// silent threshold.
    pub fn pino_number(&self) -> Option<u16> {
        match self {
            LogLevel::Trace => Some(10),
            LogLevel::Debug => Some(20),
            LogLevel::Info => Some(30),
            LogLevel::Warn => Some(40),
            LogLevel::Error => Some(50),
            LogLevel::Fatal => Some(60),
            LogLevel::Silent => None,
        }
    }
}

/// Returns true when `value` is a valid log level string.
///
/// Port of `isLogLevel`.
pub fn is_log_level(value: &str) -> bool {
    LogLevel::from_str_opt(value).is_some()
}

/// Resolves the effective log level. Precedence (port of `resolveLevel`):
///   `CLIMON_LOG_LEVEL` env (if valid) > `config_level` (if valid) >
///   `silent` when `NODE_ENV == "test"` > default `trace`.
pub fn resolve_level(config_level: Option<&str>, env: &Env) -> LogLevel {
    if let Some(from_env) = env.get("CLIMON_LOG_LEVEL") {
        if let Some(level) = LogLevel::from_str_opt(from_env) {
            return level;
        }
    }
    if let Some(config) = config_level {
        if let Some(level) = LogLevel::from_str_opt(config) {
            return level;
        }
    }
    if env.get("NODE_ENV") == Some("test") {
        return LogLevel::Silent;
    }
    LogLevel::Trace
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_log_level_accepts_pino_levels_and_silent() {
        for l in ["trace", "debug", "info", "warn", "error", "fatal", "silent"] {
            assert!(is_log_level(l), "{l} should be a level");
        }
    }

    #[test]
    fn is_log_level_rejects_junk() {
        assert!(!is_log_level("loud"));
        assert!(!is_log_level(""));
    }

    #[test]
    fn env_level_wins_over_config() {
        let env = Env::from_pairs([("CLIMON_LOG_LEVEL", "debug")]);
        assert_eq!(resolve_level(Some("warn"), &env), LogLevel::Debug);
    }

    #[test]
    fn invalid_env_value_falls_through_to_config() {
        let env = Env::from_pairs([("CLIMON_LOG_LEVEL", "loud")]);
        assert_eq!(resolve_level(Some("warn"), &env), LogLevel::Warn);
    }

    #[test]
    fn config_value_used_when_env_unset() {
        let env = Env::default();
        assert_eq!(resolve_level(Some("error"), &env), LogLevel::Error);
    }

    #[test]
    fn node_env_test_forces_silent_when_unset() {
        let env = Env::from_pairs([("NODE_ENV", "test")]);
        assert_eq!(resolve_level(None, &env), LogLevel::Silent);
    }

    #[test]
    fn explicit_env_overrides_node_env_test() {
        let env = Env::from_pairs([("NODE_ENV", "test"), ("CLIMON_LOG_LEVEL", "info")]);
        assert_eq!(resolve_level(None, &env), LogLevel::Info);
    }

    #[test]
    fn defaults_to_trace_when_nothing_set() {
        let env = Env::default();
        assert_eq!(resolve_level(None, &env), LogLevel::Trace);
    }

    #[test]
    fn pino_numbers_match() {
        assert_eq!(LogLevel::Trace.pino_number(), Some(10));
        assert_eq!(LogLevel::Info.pino_number(), Some(30));
        assert_eq!(LogLevel::Fatal.pino_number(), Some(60));
        assert_eq!(LogLevel::Silent.pino_number(), None);
    }
}
