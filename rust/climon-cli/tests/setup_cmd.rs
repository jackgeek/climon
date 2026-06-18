//! Integration test for the Phase-11-wired `climon setup` command: it now
//! re-runs onboarding via climon-install instead of the deferred stub.

use std::path::PathBuf;
use std::process::Command;

use climon_config::config::{read_global_config_setting, Env};
use serde_json::Value;

fn temp_home() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("climon-cli-setup-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn run_setup(home: &PathBuf, args: &[&str]) -> std::process::Output {
    let bin = env!("CARGO_BIN_EXE_climon");
    Command::new(bin)
        .arg("setup")
        .args(args)
        .env("CLIMON_HOME", home)
        .output()
        .expect("run climon setup")
}

#[test]
fn setup_non_interactive_accept_persists_opt_ins_and_exits_zero() {
    let home = temp_home();
    let output = run_setup(
        &home,
        &[
            "--apply",
            "--accept-eula",
            "--telemetry=on",
            "--auto-update=off",
        ],
    );
    assert!(output.status.success(), "setup should exit 0: {output:?}");

    let env = Env::new(Some(home.to_str().unwrap()), &home);
    assert_eq!(
        read_global_config_setting("eula.accepted", &env),
        Some(Value::Bool(true))
    );
    assert_eq!(
        read_global_config_setting("telemetry.enabled", &env),
        Some(Value::Bool(true))
    );
    assert_eq!(
        read_global_config_setting("update.auto", &env),
        Some(Value::Bool(false))
    );
    assert!(matches!(
        read_global_config_setting("install.id", &env),
        Some(Value::String(_))
    ));

    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn setup_non_interactive_without_accept_exits_one() {
    let home = temp_home();
    let output = run_setup(&home, &["--apply"]);
    assert_eq!(output.status.code(), Some(1));
    std::fs::remove_dir_all(&home).ok();
}
