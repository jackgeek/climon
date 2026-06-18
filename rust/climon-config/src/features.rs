//! Feature flag registry. 1:1 port of `src/features.ts`.

use serde_json::Value;

/// Development maturity of a feature, ordered least -> most production-ready.
/// Only `Ready` is considered safe; enabling any other status warns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeatureStatus {
    Experimental,
    Incomplete,
    Untested,
    KnownIssues,
    Ready,
}

impl FeatureStatus {
    /// The wire/docs spelling used by the TS `FeatureStatus` union.
    pub fn as_str(self) -> &'static str {
        match self {
            FeatureStatus::Experimental => "experimental",
            FeatureStatus::Incomplete => "incomplete",
            FeatureStatus::Untested => "untested",
            FeatureStatus::KnownIssues => "known-issues",
            FeatureStatus::Ready => "ready",
        }
    }
}

/// A single feature flag. The config key is `feature.<name>`.
#[derive(Debug, Clone, Copy)]
pub struct FeatureFlag {
    /// Flag name; the config key is `feature.<name>`.
    pub name: &'static str,
    /// Effective value when config does not set the flag (`"enabled"`/`"disabled"`).
    pub default: &'static str,
    /// Development maturity; surfaced in docs/help/dashboard and drives the enable warning.
    pub status: FeatureStatus,
    /// Human-readable description for docs/help.
    pub description: &'static str,
    /// Application-level override shipped with the binary. When set, this value
    /// wins over config and the default, locking the flag.
    pub override_value: Option<&'static str>,
}

/// The registry of feature flags. Mirrors `FEATURE_FLAGS`.
pub const FEATURE_FLAGS: &[FeatureFlag] = &[FeatureFlag {
    name: "sessionSpawning",
    default: "disabled",
    status: FeatureStatus::Experimental,
    description: "Allow spawning new sessions from the dashboard.",
    override_value: None,
}];

/// Config key prefix for feature flags.
pub const FEATURE_CONFIG_PREFIX: &str = "feature.";

/// Resolved state of a feature flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeatureFlagState {
    pub enabled: bool,
    pub locked: bool,
    pub status: FeatureStatus,
}

fn find_flag(name: &str) -> Option<&'static FeatureFlag> {
    FEATURE_FLAGS.iter().find(|flag| flag.name == name)
}

/// Resolves one flag against a raw config value. Precedence: override > config > default.
pub fn resolve_flag_state(flag: &FeatureFlag, config_value: Option<&str>) -> FeatureFlagState {
    let locked = flag.override_value.is_some();
    let effective = flag.override_value.or(config_value).unwrap_or(flag.default);
    FeatureFlagState {
        enabled: effective == "enabled",
        locked,
        status: flag.status,
    }
}

fn raw_config_value<'a>(config: &'a Value, name: &str) -> Option<&'a str> {
    config.get("feature")?.get(name)?.as_str()
}

/// Whether the named flag is enabled for the given parsed config.
pub fn is_feature_enabled(config: &Value, name: &str) -> bool {
    match find_flag(name) {
        Some(flag) => resolve_flag_state(flag, raw_config_value(config, name)).enabled,
        None => false,
    }
}

/// Whether the named flag is locked by a build override.
pub fn is_feature_locked(name: &str) -> bool {
    find_flag(name)
        .map(|flag| flag.override_value.is_some())
        .unwrap_or(false)
}

/// The maturity status of the named flag, or an error for an unknown flag.
pub fn feature_status(name: &str) -> Result<FeatureStatus, String> {
    find_flag(name)
        .map(|flag| flag.status)
        .ok_or_else(|| format!("Unknown feature flag: {name}"))
}

/// Returns the flag name if `key` is `feature.<known>`, else `None`.
pub fn parse_feature_config_key(key: &str) -> Option<&'static str> {
    let name = key.strip_prefix(FEATURE_CONFIG_PREFIX)?;
    find_flag(name).map(|flag| flag.name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_contains_session_spawning_defaults() {
        let flag = find_flag("sessionSpawning").expect("flag exists");
        assert_eq!(flag.default, "disabled");
        assert_eq!(flag.status, FeatureStatus::Experimental);
        assert_eq!(flag.override_value, None);
    }

    #[test]
    fn resolve_precedence_override_then_config_then_default() {
        let base = FEATURE_FLAGS[0];
        assert!(!resolve_flag_state(&base, None).enabled);
        assert!(resolve_flag_state(&base, Some("enabled")).enabled);
        let overridden = FeatureFlag {
            override_value: Some("enabled"),
            ..base
        };
        let state = resolve_flag_state(&overridden, Some("disabled"));
        assert!(state.enabled);
        assert!(state.locked);
    }

    #[test]
    fn is_feature_enabled_reads_config() {
        let config = json!({ "feature": { "sessionSpawning": "enabled" } });
        assert!(is_feature_enabled(&config, "sessionSpawning"));
        assert!(!is_feature_enabled(&json!({}), "sessionSpawning"));
        assert!(!is_feature_enabled(&json!({}), "unknownFlag"));
    }

    #[test]
    fn parse_feature_config_key_matches_known_only() {
        assert_eq!(
            parse_feature_config_key("feature.sessionSpawning"),
            Some("sessionSpawning")
        );
        assert_eq!(parse_feature_config_key("feature.nope"), None);
        assert_eq!(parse_feature_config_key("session.color"), None);
    }

    #[test]
    fn feature_status_errors_for_unknown() {
        assert_eq!(
            feature_status("sessionSpawning").unwrap(),
            FeatureStatus::Experimental
        );
        assert!(feature_status("nope").is_err());
        assert!(!is_feature_locked("sessionSpawning"));
    }
}
