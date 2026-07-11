//! Dedicated climon installer, shipped as `install[.exe]`. Replaces the old
//! `install`->`climon` rename + `climon-alpha` sentinel. Embeds the two Windows
//! stubs (tiny, stable) and delegates to `climon_install::run_installer`, which
//! resolves the install dir, places binaries (versioned artifacts + stubs +
//! pointers on Windows; plain copy on Unix), sets PATH, runs onboarding, and
//! prints the changelog. When those same bytes are invoked as `climon[.exe]`,
//! they bootstrap already-shipped legacy updaters through `climon-update`.

use std::ffi::{OsStr, OsString};
use std::path::Path;

const VERSION: &str = env!("CLIMON_VERSION");

/// Embedded Windows client stub bytes (`climon.exe`). Empty on non-Windows/dev.
const CLIENT_STUB: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/client_stub.bin"));
/// Embedded Windows server stub bytes (`climon-server.exe`). Empty on non-Windows/dev.
const SERVER_STUB: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/server_stub.bin"));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntrypointMode {
    Installer,
    LegacyBootstrap,
}

fn classify_entrypoint(basename: &OsStr) -> Result<EntrypointMode, String> {
    if basename == "install" || basename == "install.exe" {
        Ok(EntrypointMode::Installer)
    } else if basename == "climon" || basename == "climon.exe" {
        Ok(EntrypointMode::LegacyBootstrap)
    } else {
        Err(format!(
            "unexpected setup executable basename: {}",
            basename.to_string_lossy()
        ))
    }
}

fn run(current_exe: &Path, original_args: Vec<OsString>) -> i32 {
    let mode = current_exe
        .file_name()
        .ok_or_else(|| "setup executable path has no basename".to_string())
        .and_then(classify_entrypoint);
    match mode {
        Ok(EntrypointMode::Installer) => {
            climon_install::run_installer(VERSION, CLIENT_STUB, SERVER_STUB)
        }
        Ok(EntrypointMode::LegacyBootstrap) => {
            climon_update::bootstrap::run_legacy_bootstrap(current_exe, &original_args, VERSION)
        }
        Err(error) => {
            eprintln!("climon setup failed: {error}");
            2
        }
    }
}

fn main() {
    let current_exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("climon setup failed: cannot resolve executable path: {error}");
            std::process::exit(2);
        }
    };
    let original_args = std::env::args_os().skip(1).collect();
    std::process::exit(run(&current_exe, original_args));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn install_basenames_select_installer_mode() {
        assert_eq!(
            classify_entrypoint(OsStr::new("install")),
            Ok(EntrypointMode::Installer)
        );
        assert_eq!(
            classify_entrypoint(OsStr::new("install.exe")),
            Ok(EntrypointMode::Installer)
        );
    }

    #[test]
    fn climon_basenames_select_legacy_bootstrap_mode() {
        assert_eq!(
            classify_entrypoint(OsStr::new("climon")),
            Ok(EntrypointMode::LegacyBootstrap)
        );
        assert_eq!(
            classify_entrypoint(OsStr::new("climon.exe")),
            Ok(EntrypointMode::LegacyBootstrap)
        );
    }

    #[test]
    fn unexpected_basename_fails_closed() {
        assert!(classify_entrypoint(OsStr::new("renamed-installer")).is_err());
    }

    #[test]
    fn invalid_or_missing_basename_returns_usage_error() {
        assert_eq!(run(Path::new("renamed-installer"), Vec::new()), 2);
        assert_eq!(run(Path::new("/"), Vec::new()), 2);
    }
}
