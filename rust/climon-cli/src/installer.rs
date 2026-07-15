//! Self-install trigger detection. Port of `tryRunInstaller` in `src/index.ts`.
//!
//! The shipped release zips place a `climon-alpha` sentinel marker next to the
//! `climon` (install) binary. When present, the client hands off to the native
//! installer (`climon_install::run_installer`) instead of dispatching a normal
//! command — the same trigger the Bun client used, but the installer is now
//! native Rust rather than a loaded JS bundle.

use std::path::{Path, PathBuf};

/// The sentinel filename whose presence next to the executable triggers a
/// self-install. Kept identical to the Bun client's `INSTALLER_BUNDLE_NAME` so
/// existing release packaging stays compatible.
pub const INSTALLER_MARKER_NAME: &str = "climon-alpha";

/// The expected sentinel path for an executable directory.
pub fn installer_marker_path(exe_dir: &Path) -> PathBuf {
    exe_dir.join(INSTALLER_MARKER_NAME)
}

/// Whether the self-install sentinel exists next to an executable directory.
pub fn installer_marker_present(exe_dir: &Path) -> bool {
    installer_marker_path(exe_dir).exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "climon-cli-installer-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn marker_path_joins_sentinel_name() {
        let dir = Path::new("/opt/climon");
        assert_eq!(
            installer_marker_path(dir),
            PathBuf::from("/opt/climon/climon-alpha")
        );
    }

    #[test]
    fn detects_marker_when_present() {
        let dir = temp_dir("present");
        fs::write(dir.join(INSTALLER_MARKER_NAME), "sentinel").unwrap();
        assert!(installer_marker_present(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn no_marker_means_normal_dispatch() {
        let dir = temp_dir("absent");
        assert!(!installer_marker_present(&dir));
        fs::remove_dir_all(&dir).ok();
    }
}
