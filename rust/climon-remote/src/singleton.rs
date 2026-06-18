//! Pidfile-based singleton acquisition. 1:1 port of `src/remote/singleton.ts`.

use std::path::Path;

use crate::process::is_process_alive;

/// Result of a singleton acquisition attempt. Mirrors `SingletonResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SingletonResult {
    pub acquired: bool,
    /// PID of the existing holder when `acquired` is false.
    pub holder: Option<u32>,
}

/// Returns true if this process now owns the singleton, false if another live
/// instance holds it. Mirrors `acquireSingleton`.
pub fn acquire_singleton(pid_file: &Path) -> bool {
    acquire_singleton_detailed(pid_file).acquired
}

/// Like [`acquire_singleton`] but returns the blocking PID for diagnostics.
/// Mirrors `acquireSingletonDetailed`.
pub fn acquire_singleton_detailed(pid_file: &Path) -> SingletonResult {
    if let Ok(existing) = std::fs::read_to_string(pid_file) {
        if let Ok(pid) = existing.trim().parse::<u32>() {
            if pid > 0 && is_process_alive(pid) {
                return SingletonResult {
                    acquired: false,
                    holder: Some(pid),
                };
            }
        }
    }
    if let Some(parent) = pid_file.parent() {
        let _ = std::fs::create_dir_all(parent);
        set_mode(parent, 0o700);
    }
    let _ = std::fs::write(pid_file, format!("{}\n", std::process::id()));
    set_mode(pid_file, 0o600);
    SingletonResult {
        acquired: true,
        holder: None,
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "climon-singleton-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn acquires_when_no_pidfile_exists() {
        let dir = tmp("fresh");
        let pid_file = dir.join("nested").join("x.pid");
        let result = acquire_singleton_detailed(&pid_file);
        assert!(result.acquired);
        assert!(pid_file.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn does_not_acquire_when_a_live_holder_owns_the_pidfile() {
        let dir = tmp("held");
        let pid_file = dir.join("x.pid");
        std::fs::write(&pid_file, format!("{}\n", std::process::id())).unwrap();
        let result = acquire_singleton_detailed(&pid_file);
        assert!(!result.acquired);
        assert_eq!(result.holder, Some(std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn acquires_over_a_dead_holder() {
        let dir = tmp("dead");
        let pid_file = dir.join("x.pid");
        std::fs::write(&pid_file, "999999\n").unwrap();
        assert!(acquire_singleton(&pid_file));
        std::fs::remove_dir_all(&dir).ok();
    }
}
