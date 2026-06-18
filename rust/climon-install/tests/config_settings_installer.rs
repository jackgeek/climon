//! Installer/update config-settings parity test. Ports
//! `tests/config-settings-installer.test.ts`, asserting the config registry the
//! installer and onboarding flow rely on (EULA gate, telemetry/auto-update
//! opt-ins, update bookkeeping, install id) keeps its shape. The registry
//! itself lives in the climon-config crate; this guards the contract the
//! climon-install crate depends on.

use climon_config::config_settings::{
    accepted_config_keys, build_default_config_from_settings, find_config_setting, ConfigType,
};
use serde_json::Value;

#[test]
fn eula_keys_are_registered_and_internal() {
    let accepted = find_config_setting("eula.accepted").unwrap();
    assert_eq!(accepted.kind, ConfigType::Boolean);
    assert!(accepted.internal);
    assert!(find_config_setting("eula.version").unwrap().internal);
    assert!(find_config_setting("eula.acceptedAt").unwrap().internal);
}

#[test]
fn telemetry_enabled_defaults_off_and_user_settable() {
    assert_eq!(
        find_config_setting("telemetry.enabled")
            .unwrap()
            .default_value,
        Some(Value::Bool(false))
    );
    assert!(accepted_config_keys().contains(&"telemetry.enabled".to_string()));
}

#[test]
fn update_auto_defaults_off_and_user_settable() {
    assert_eq!(
        find_config_setting("update.auto").unwrap().default_value,
        Some(Value::Bool(false))
    );
    assert!(accepted_config_keys().contains(&"update.auto".to_string()));
}

#[test]
fn update_bookkeeping_and_install_id_are_internal() {
    assert!(find_config_setting("update.lastCheck").unwrap().internal);
    assert!(
        find_config_setting("update.availableVersion")
            .unwrap()
            .internal
    );
    assert!(find_config_setting("install.id").unwrap().internal);
}

#[test]
fn defaults_object_carries_off_by_default_booleans() {
    let cfg = build_default_config_from_settings();
    assert_eq!(cfg["telemetry"]["enabled"], Value::Bool(false));
    assert_eq!(cfg["update"]["auto"], Value::Bool(false));
    assert_eq!(cfg["eula"]["accepted"], Value::Bool(false));
}
