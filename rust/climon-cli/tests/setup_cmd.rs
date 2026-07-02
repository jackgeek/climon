//! Integration test for the Phase-11-wired `climon setup` command: it now
//! re-runs onboarding via climon-install instead of the deferred stub.

use std::path::PathBuf;
use std::process::Command;

use climon_config::config::{read_global_config_setting, Env};
use serde_json::Value;

fn temp_home() -> PathBuf {
    // Per-process atomic counter guarantees a distinct directory for every call:
    // the PID disambiguates concurrent test binaries and the counter disambiguates
    // the parallel test threads within this binary. A time-based suffix alone can
    // collide because both threads share this harness PID and the clock is coarse,
    // which previously let one test's cleanup delete another's home mid-write.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("climon-cli-setup-{}-{n}", std::process::id()));
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
fn setup_non_interactive_persists_opt_ins_and_exits_zero() {
    let home = temp_home();
    let output = run_setup(&home, &["--apply", "--telemetry=on", "--auto-update=off"]);
    assert!(output.status.success(), "setup should exit 0: {output:?}");

    let env = Env::new(Some(home.to_str().unwrap()), &home);
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
fn setup_non_interactive_without_flags_exits_zero() {
    let home = temp_home();
    let output = run_setup(&home, &["--apply"]);
    assert!(output.status.success(), "setup should exit 0: {output:?}");
    let env = Env::new(Some(home.to_str().unwrap()), &home);
    assert!(matches!(
        read_global_config_setting("install.id", &env),
        Some(Value::String(_))
    ));
    std::fs::remove_dir_all(&home).ok();
}
