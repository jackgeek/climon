//! Launcher update hooks. Port of `src/update/launch-hooks.ts`.
//!
//! `maybe_show_update_banner` prints a one-line banner (or, in auto mode, spawns
//! a detached `climon update`); `maybe_spawn_background_check` fires a detached
//! `climon __update-check` at most once per interval. Neither blocks the launch
//! nor interrupts running sessions.

use std::process::{Command, Stdio};

use climon_config::config::Env;

use crate::manifest::compare_semver;
use crate::state::{
    get_available_version, get_license_notice_shown, is_auto_update, mark_license_notice_shown,
    should_check, DEFAULT_INTERVAL_MS,
};
use crate::version::VERSION;

/// What the launcher should do about a cached available version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BannerDecision {
    /// Nothing to do (no newer cached version).
    None,
    /// Auto-update is on: apply in a detached child instead of a banner.
    SpawnUpdate,
    /// Print this banner string to stderr (already newline-terminated).
    Show(String),
}

/// Decides what to do given the cached state, without side effects. Re-compares
/// against `current_version` so a stale-equal cache never triggers a banner.
pub fn banner_decision(env: &Env, current_version: &str) -> BannerDecision {
    let next = match get_available_version(env) {
        Some(n) => n,
        None => return BannerDecision::None,
    };
    if compare_semver(&next, current_version) <= 0 {
        return BannerDecision::None;
    }
    if is_auto_update(env) {
        return BannerDecision::SpawnUpdate;
    }
    BannerDecision::Show(format!(
        "Update {current_version} \u{2192} {next} available \u{2014} run `climon --update`\n"
    ))
}

/// Prints a one-line banner when a newer version is cached. In auto mode it
/// applies in a detached child so the session starts immediately and running
/// sessions are never interrupted (the swap is non-destructive).
pub fn maybe_show_update_banner(env: &Env) {
    match banner_decision(env, VERSION) {
        BannerDecision::None => {}
        BannerDecision::SpawnUpdate => {
            if let Ok(exe) = std::env::current_exe() {
                spawn_detached(&exe.to_string_lossy(), &["update"]);
            }
        }
        BannerDecision::Show(banner) => {
            eprint!("{banner}");
        }
    }
}

/// True when a pre-open-source install has not yet seen the license-change
/// notice. Legacy installs are detected by a leftover `eula.*` key in the global
/// config; fresh installs never carry one, so they never see the notice.
pub fn license_notice_decision(env: &Env) -> bool {
    let legacy = climon_config::config::read_global_config_setting("eula.version", env).is_some()
        || climon_config::config::read_global_config_setting("eula.accepted", env).is_some();
    legacy && !get_license_notice_shown(env)
}

/// Prints the one-time MIT license-change notice to stderr for upgrading installs
/// and records that it has been shown so it never repeats.
pub fn maybe_show_license_notice(env: &Env) {
    if license_notice_decision(env) {
        eprintln!(
            "climon is now open source under the MIT License \u{2014} run 'climon license' for details."
        );
        mark_license_notice_shown(env);
    }
}

/// Spawns a detached background version check at most once per interval.
pub fn maybe_spawn_background_check(exec_path: &str, env: &Env) {
    if !should_check(env, DEFAULT_INTERVAL_MS) {
        return;
    }
    spawn_detached(exec_path, &["__update-check"]);
}

/// Spawns `exec_path args...` fully detached with no stdio, never waiting.
fn spawn_detached(exec_path: &str, args: &[&str]) {
    let mut cmd = Command::new(exec_path);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
    }

    // Fire and forget: drop the handle without waiting (mirrors child.unref()).
    let _ = cmd.spawn();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::set_available_version;
    use crate::version::VERSION;

    fn temp_env() -> (tempfile::TempDir, Env) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        let env = Env::new(Some(&home), dir.path());
        (dir, env)
    }

    #[test]
    fn shows_the_banner_when_cached_version_is_newer() {
        let (_d, env) = temp_env();
        set_available_version("999.0.0", &env);
        match banner_decision(&env, VERSION) {
            BannerDecision::Show(s) => assert!(s.contains("999.0.0")),
            other => panic!("expected Show, got {other:?}"),
        }
    }

    #[test]
    fn no_banner_when_cached_version_equals_running() {
        let (_d, env) = temp_env();
        set_available_version(VERSION, &env);
        assert_eq!(banner_decision(&env, VERSION), BannerDecision::None);
    }

    #[test]
    fn no_banner_with_no_cached_version() {
        let (_d, env) = temp_env();
        assert_eq!(banner_decision(&env, VERSION), BannerDecision::None);
    }

    #[test]
    fn auto_update_spawns_instead_of_banner() {
        let (_d, env) = temp_env();
        set_available_version("999.0.0", &env);
        let cwd = std::path::Path::new(".");
        climon_config::config::write_config_setting(
            "update.auto",
            "true",
            climon_config::config::WriteScope::Global,
            &env,
            cwd,
        )
        .unwrap();
        assert_eq!(banner_decision(&env, VERSION), BannerDecision::SpawnUpdate);
    }

    #[test]
    fn shows_license_notice_once_for_legacy_installs() {
        let (_d, env) = temp_env();
        // Simulate a pre-open-source install by writing a raw legacy `eula.*`
        // key. It is no longer in the config registry, so it must be written
        // directly rather than via `write_config_setting`, which rejects
        // unknown keys.
        std::fs::write(
            climon_config::config::get_config_path(&env),
            r#"{"eula":{"version":"1"}}"#,
        )
        .unwrap();
        assert!(license_notice_decision(&env));
        maybe_show_license_notice(&env);
        assert!(!license_notice_decision(&env));
    }

    #[test]
    fn no_license_notice_for_fresh_installs() {
        let (_d, env) = temp_env();
        assert!(!license_notice_decision(&env));
    }
}
