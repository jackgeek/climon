//! Update background-check state, persisted in the global config. Port of
//! `src/update/state.ts`.

use std::path::Path;

use climon_config::config::{read_global_config_setting, write_config_setting, Env, WriteScope};
use serde_json::Value;

use crate::clock::{now_iso8601, now_ms, parse_iso8601_ms};

/// 24 hours in milliseconds; the default interval between background checks.
pub const DEFAULT_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

fn write_global(env: &Env, key: &str, value: &str) {
    // Writes target the global $CLIMON_HOME config; cwd is irrelevant for the
    // global scope so any path works.
    let cwd = Path::new(".");
    let _ = write_config_setting(key, value, WriteScope::Global, env, cwd);
}

/// True when enough time has passed since the last recorded check.
pub fn should_check(env: &Env, interval_ms: i64) -> bool {
    let last = read_global_config_setting("update.lastCheck", env);
    let last = match last {
        Some(Value::String(s)) if !s.is_empty() => s,
        _ => return true,
    };
    match parse_iso8601_ms(&last) {
        Some(last_ms) => now_ms() - last_ms >= interval_ms,
        None => true,
    }
}

/// Records that a check happened now.
pub fn record_check(env: &Env) {
    write_global(env, "update.lastCheck", &now_iso8601());
}

/// Returns the cached available (newer) version, if any.
pub fn get_available_version(env: &Env) -> Option<String> {
    match read_global_config_setting("update.availableVersion", env) {
        Some(Value::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

/// Caches a discovered newer version for banner display.
pub fn set_available_version(version: &str, env: &Env) {
    write_global(env, "update.availableVersion", version);
}

/// Clears the cached available version (e.g. after a successful update).
pub fn clear_available_version(env: &Env) {
    write_global(env, "update.availableVersion", "");
}

/// True when auto-update is enabled.
pub fn is_auto_update(env: &Env) -> bool {
    read_global_config_setting("update.auto", env) == Some(Value::Bool(true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_env() -> (tempfile::TempDir, Env) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        let env = Env::new(Some(&home), dir.path());
        (dir, env)
    }

    #[test]
    fn should_check_true_with_no_prior_check() {
        let (_d, env) = temp_env();
        assert!(should_check(&env, 60 * 60 * 1000));
    }

    #[test]
    fn record_check_makes_should_check_false_within_interval() {
        let (_d, env) = temp_env();
        record_check(&env);
        assert!(!should_check(&env, 60 * 60 * 1000));
    }

    #[test]
    fn should_check_true_again_once_interval_elapsed() {
        let (_d, env) = temp_env();
        let past = crate::clock::to_iso8601(now_ms() - 2 * 60 * 60 * 1000);
        let cwd = Path::new(".");
        write_config_setting("update.lastCheck", &past, WriteScope::Global, &env, cwd).unwrap();
        assert!(should_check(&env, 60 * 60 * 1000));
    }

    #[test]
    fn available_version_round_trips_and_clears() {
        let (_d, env) = temp_env();
        assert_eq!(get_available_version(&env), None);
        set_available_version("0.13.0", &env);
        assert_eq!(get_available_version(&env).as_deref(), Some("0.13.0"));
        clear_available_version(&env);
        assert_eq!(get_available_version(&env), None);
    }

    #[test]
    fn is_auto_update_reflects_update_auto() {
        let (_d, env) = temp_env();
        assert!(!is_auto_update(&env));
        let cwd = Path::new(".");
        write_config_setting("update.auto", "true", WriteScope::Global, &env, cwd).unwrap();
        assert!(is_auto_update(&env));
    }
}
