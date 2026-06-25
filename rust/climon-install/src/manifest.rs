//! Install manifest: the canonical, ordered list of files to copy from the
//! extracted artifact into the install directory. 1:1 port of
//! `src/install/install-manifest.ts`.
//!
//! This is the single source of truth shared by the Windows installer, the Unix
//! installer, and the non-destructive updater swap, so its shape must stay
//! byte-for-byte compatible with the Bun installer.

use serde::{Deserialize, Serialize};

/// Target platform for the manifest. Mirrors the TS `NodeJS.Platform` values
/// actually used by the installer (`win32` / `linux` / `darwin`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Linux,
    Darwin,
}

impl Platform {
    /// The TS `NodeJS.Platform` string for this platform.
    pub fn as_node_platform(self) -> &'static str {
        match self {
            Platform::Windows => "win32",
            Platform::Linux => "linux",
            Platform::Darwin => "darwin",
        }
    }

    /// Parses a TS `NodeJS.Platform` string (used by the cross-language fixture).
    pub fn from_node_platform(value: &str) -> Option<Platform> {
        match value {
            "win32" => Some(Platform::Windows),
            "linux" => Some(Platform::Linux),
            "darwin" => Some(Platform::Darwin),
            _ => None,
        }
    }
}

/// The host platform, resolved at compile time.
pub fn current_platform() -> Platform {
    #[cfg(target_os = "windows")]
    {
        Platform::Windows
    }
    #[cfg(target_os = "macos")]
    {
        Platform::Darwin
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Platform::Linux
    }
}

/// One file to copy from the extracted artifact into the install directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallFile {
    pub source: String,
    pub dest: String,
}

impl InstallFile {
    fn new(source: impl Into<String>, dest: impl Into<String>) -> InstallFile {
        InstallFile {
            source: source.into(),
            dest: dest.into(),
        }
    }
}

/// Returns the ordered list of files to install for a platform. Add future
/// locale resource files here and they are installed and swapped automatically.
pub fn install_files_for_platform(platform: Platform) -> Vec<InstallFile> {
    let exe = if platform == Platform::Windows {
        ".exe"
    } else {
        ""
    };
    vec![
        InstallFile::new(format!("install{exe}"), format!("climon{exe}")),
        InstallFile::new(format!("climon-server{exe}"), format!("climon-server{exe}")),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_installs_climon_and_server_from_bare_source_names() {
        assert_eq!(
            install_files_for_platform(Platform::Linux),
            vec![
                InstallFile::new("install", "climon"),
                InstallFile::new("climon-server", "climon-server"),
            ]
        );
    }

    #[test]
    fn windows_installs_exe_variants() {
        assert_eq!(
            install_files_for_platform(Platform::Windows),
            vec![
                InstallFile::new("install.exe", "climon.exe"),
                InstallFile::new("climon-server.exe", "climon-server.exe"),
            ]
        );
    }

    #[test]
    fn darwin_matches_the_unix_layout() {
        assert_eq!(
            install_files_for_platform(Platform::Darwin),
            install_files_for_platform(Platform::Linux)
        );
    }
}
