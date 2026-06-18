//! Secret redaction.
//!
//! Port of `src/logging/redact.ts`. Censors secrets (auth tokens, tunnel
//! credentials, App Insights connection strings) to `[REDACTED]` in log
//! records, matching pino's `redact` path semantics for the configured paths.

use serde_json::Value;

/// The censor string substituted for every redacted value.
pub const CENSOR: &str = "[REDACTED]";

/// Redaction paths, in the exact order of `REDACT_OPTIONS.paths` in
/// `redact.ts`. A leading `*` matches any single property at that level.
pub const REDACT_PATHS: &[&str] = &[
    "connectionString",
    "*.connectionString",
    "authorization",
    "*.authorization",
    "password",
    "*.password",
    "token",
    "*.token",
    "auth",
    "*.auth",
    "accessToken",
    "*.accessToken",
    "tunnelToken",
    "*.tunnelToken",
];

/// Redacts the climon secret paths in `value` in place, replacing each existing
/// matched value with [`CENSOR`].
pub fn redact(value: &mut Value) {
    redact_with(value, REDACT_PATHS, CENSOR);
}

/// Redacts the given `paths` in `value` in place, replacing each existing
/// matched value with `censor`. A `*` path segment matches any single property.
pub fn redact_with(value: &mut Value, paths: &[&str], censor: &str) {
    for path in paths {
        let segments: Vec<&str> = path.split('.').collect();
        apply_path(value, &segments, censor);
    }
}

/// Applies one path (as segments) to `value`, censoring only existing leaves.
fn apply_path(value: &mut Value, segments: &[&str], censor: &str) {
    let Some((seg, rest)) = segments.split_first() else {
        return;
    };
    let Some(map) = value.as_object_mut() else {
        return;
    };

    if *seg == "*" {
        for child in map.values_mut() {
            if rest.is_empty() {
                *child = Value::String(censor.to_string());
            } else {
                apply_path(child, rest, censor);
            }
        }
    } else if let Some(child) = map.get_mut(*seg) {
        if rest.is_empty() {
            *child = Value::String(censor.to_string());
        } else {
            apply_path(child, rest, censor);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn censors_top_level_and_nested_sensitive_keys() {
        let mut v = json!({
            "connectionString": "InstrumentationKey=secret",
            "nested": { "token": "abc" },
            "msg": "hi",
        });
        redact(&mut v);
        assert_eq!(v["connectionString"], json!("[REDACTED]"));
        assert_eq!(v["nested"]["token"], json!("[REDACTED]"));
        assert_eq!(v["msg"], json!("hi"));
    }

    #[test]
    fn every_path_rule_censors_top_level() {
        for key in [
            "connectionString",
            "authorization",
            "password",
            "token",
            "auth",
            "accessToken",
            "tunnelToken",
        ] {
            let mut v = json!({ key: "secret", "keep": "ok" });
            redact(&mut v);
            assert_eq!(v[key], json!("[REDACTED]"), "top-level {key}");
            assert_eq!(v["keep"], json!("ok"));
        }
    }

    #[test]
    fn every_path_rule_censors_one_level_deep() {
        for key in [
            "connectionString",
            "authorization",
            "password",
            "token",
            "auth",
            "accessToken",
            "tunnelToken",
        ] {
            let mut v = json!({ "child": { key: "secret", "keep": "ok" } });
            redact(&mut v);
            assert_eq!(v["child"][key], json!("[REDACTED]"), "nested {key}");
            assert_eq!(v["child"]["keep"], json!("ok"));
        }
    }

    #[test]
    fn leaves_non_sensitive_keys_untouched() {
        let mut v = json!({ "user": "alice", "count": 3, "ok": true });
        let before = v.clone();
        redact(&mut v);
        assert_eq!(v, before);
    }

    #[test]
    fn skips_non_object_intermediate() {
        // `token` is a string here, not an object, so `*.token` must not panic
        // and the top-level rule still censors it.
        let mut v = json!({ "token": "abc" });
        redact(&mut v);
        assert_eq!(v["token"], json!("[REDACTED]"));
    }

    #[test]
    fn censor_replaces_value_of_any_type() {
        let mut v = json!({ "password": 1234, "nested": { "auth": { "k": "v" } } });
        redact(&mut v);
        assert_eq!(v["password"], json!("[REDACTED]"));
        assert_eq!(v["nested"]["auth"], json!("[REDACTED]"));
    }
}
