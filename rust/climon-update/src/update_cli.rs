//! `climon update` entrypoint. Port of `src/update/update-cli.ts`.

use std::path::Path;

use climon_config::config::Env;

use crate::check::DEFAULT_MANIFEST_URL;
use crate::manifest::fetch_manifest;
use crate::pubkey::UPDATE_PUBLIC_KEY_B64;
use crate::state::clear_available_version;
use crate::update_cmd::{run_update_command, UpdateCommandOptions, UpdateStatus};
use crate::version::VERSION;

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

    let opts = UpdateCommandOptions {
        install_dir: &install_dir,
        current_version: VERSION,
        manifest: &manifest,
        public_key_b64: UPDATE_PUBLIC_KEY_B64,
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
        UpdateStatus::VerifyFailed | UpdateStatus::NoArtifact => 1,
        _ => 0,
    }
}
