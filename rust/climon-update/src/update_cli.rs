//! `climon update` entrypoint. Port of `src/update/update-cli.ts`.

use std::path::Path;

use climon_config::config::{read_global_config_setting, Env};
use serde_json::Value;

use crate::check::DEFAULT_MANIFEST_URL;
use crate::manifest::fetch_manifest;
use crate::pubkey::UPDATE_PUBLIC_KEY_B64;
use crate::state::clear_available_version;
use crate::distribution::embedded_distribution_password;
use crate::update_cmd::{run_update_command, UpdateCommandOptions, UpdateStatus};
use crate::version::VERSION;

/// Resolves the release decryption password: an explicit global
/// `update.password` (manual override / rotation) wins; otherwise the password
/// embedded into a gated build is used. Returns `None` when neither is present.
/// Split from [`get_configured_update_password`] so precedence is unit-testable
/// regardless of how the test binary was built.
fn resolve_update_password(env: &Env, embedded: Option<String>) -> Option<String> {
    if let Some(Value::String(s)) = read_global_config_setting("update.password", env) {
        if !s.is_empty() {
            return Some(s);
        }
    }
    embedded
}

/// Reads the release decryption password (per-machine; never shadowed by a
/// project-local config). Prefers an explicit `update.password`, then falls back
/// to the password embedded into gated builds. Returns `None` when unset.
pub fn get_configured_update_password(env: &Env) -> Option<String> {
    resolve_update_password(env, embedded_distribution_password())
}

/// `climon update` entrypoint: resolves the install dir and applies an update.
/// Returns the process exit code (0 success/up-to-date/deferred; 1 on failure).
pub fn run_update_cli(_argv: &[String], env: &Env) -> i32 {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("climon update failed: {e}");
            return 1;
        }
    };
    let install_dir = exe.parent().unwrap_or(Path::new(".")).to_path_buf();

    let manifest = match fetch_manifest(DEFAULT_MANIFEST_URL) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("climon update failed: {e}");
            return 1;
        }
    };

    let password = get_configured_update_password(env);
    let opts = UpdateCommandOptions {
        install_dir: &install_dir,
        current_version: VERSION,
        manifest: &manifest,
        public_key_b64: UPDATE_PUBLIC_KEY_B64,
        decrypt_password: password.as_deref(),
        platform: crate::manifest::current_node_platform(),
        arch: crate::manifest::current_node_arch(),
    };

    let result = match run_update_command(&opts, &mut |s| print!("{s}")) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("climon update failed: {e}");
            return 1;
        }
    };

    if result.status == UpdateStatus::Updated {
        clear_available_version(env);
    }

    match result.status {
        UpdateStatus::VerifyFailed | UpdateStatus::DecryptFailed | UpdateStatus::NoArtifact => 1,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use climon_config::config::{write_config_setting, WriteScope};

    fn temp_env() -> (tempfile::TempDir, Env) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        let env = Env::new(Some(&home), dir.path());
        (dir, env)
    }

    #[test]
    fn password_returns_none_when_unset() {
        let (_d, env) = temp_env();
        assert_eq!(get_configured_update_password(&env), None);
    }

    #[test]
    fn password_returns_configured_global_value() {
        let (_d, env) = temp_env();
        write_config_setting(
            "update.password",
            "shared-pw",
            WriteScope::Global,
            &env,
            std::path::Path::new("."),
        )
        .unwrap();
        assert_eq!(
            get_configured_update_password(&env).as_deref(),
            Some("shared-pw")
        );
    }

    #[test]
    fn resolve_prefers_config_over_embedded() {
        let (_d, env) = temp_env();
        write_config_setting(
            "update.password",
            "config-pw",
            WriteScope::Global,
            &env,
            std::path::Path::new("."),
        )
        .unwrap();
        assert_eq!(
            resolve_update_password(&env, Some("embedded-pw".to_string())).as_deref(),
            Some("config-pw")
        );
    }

    #[test]
    fn resolve_falls_back_to_embedded_when_config_unset() {
        let (_d, env) = temp_env();
        assert_eq!(
            resolve_update_password(&env, Some("embedded-pw".to_string())).as_deref(),
            Some("embedded-pw")
        );
    }

    #[test]
    fn resolve_returns_none_when_neither_present() {
        let (_d, env) = temp_env();
        assert_eq!(resolve_update_password(&env, None), None);
    }
}
