//! Ordered install-file list shared by installer and updater swap. Port of
//! `src/install/install-manifest.ts`.

/// One file to copy from the extracted artifact into the install directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallFile {
    pub source: String,
    pub dest: String,
}

/// Returns the ordered list of files to install for a node-style platform
/// (`win32`/`darwin`/`linux`). This is the single source of truth shared by the
/// installer and the non-destructive updater swap.
pub fn install_files_for_platform(platform: &str) -> Vec<InstallFile> {
    if platform == "win32" {
        return vec![
            InstallFile {
                source: "climon.dll".to_string(),
                dest: "climon.dll".to_string(), // resolved to climon-<ver>.dll by the Windows apply path
            },
            InstallFile {
                source: "climon-server.exe".to_string(),
                dest: "climon-server.exe".to_string(), // resolved to climon-server-<ver>.exe
            },
        ];
    }
    vec![
        InstallFile {
            source: "climon".to_string(),
            dest: "climon".to_string(),
        },
        InstallFile {
            source: "climon-server".to_string(),
            dest: "climon-server".to_string(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_files_have_no_exe_suffix() {
        let files = install_files_for_platform("linux");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].source, "climon");
        assert_eq!(files[0].dest, "climon");
        assert_eq!(files[1].source, "climon-server");
        assert_eq!(files[1].dest, "climon-server");
    }

    #[test]
    fn windows_files_have_exe_suffix() {
        let files = install_files_for_platform("win32");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].source, "climon.dll");
        assert_eq!(files[0].dest, "climon.dll");
        assert_eq!(files[1].source, "climon-server.exe");
        assert_eq!(files[1].dest, "climon-server.exe");
    }
}
