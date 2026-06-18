//! Linux install helpers: shell-profile PATH editing + process termination.
//! 1:1 port of `src/install/linux.ts`. Mirrors [`crate::macos`] but defaults to
//! bash/`.bashrc` and creates the profile's parent directory (e.g. the fish
//! `conf.d/`) before appending.

use std::fs;
use std::path::{Path, PathBuf};

use crate::macos::{
    fish_path_line_with, home_dir, path_export_line_with, profile_contains_path_with, ShellProfile,
};

fn profile_file_for_shell(shell: &str) -> &'static str {
    match shell {
        "zsh" => ".zshrc",
        "bash" => ".bashrc",
        "fish" => ".config/fish/conf.d/climon.fish",
        _ => ".bashrc",
    }
}

fn shell_basename(shell_path: &str) -> &str {
    shell_path.rsplit('/').next().unwrap_or("bash")
}

/// Detects the shell profile from an explicit `SHELL` value and home dir.
pub fn detect_shell_profile_with(shell_env: Option<&str>, home: &Path) -> ShellProfile {
    let shell = shell_basename(shell_env.unwrap_or("/bin/bash")).to_string();
    let profile_file = profile_file_for_shell(&shell);
    ShellProfile {
        shell,
        profile_path: home.join(profile_file),
    }
}

/// Detects the shell profile from the real process environment.
pub fn detect_shell_profile() -> ShellProfile {
    detect_shell_profile_with(std::env::var("SHELL").ok().as_deref(), &home_dir())
}

/// Appends a PATH line to the profile if not already present, creating the
/// profile's parent directory first. Returns whether the profile was changed.
pub fn ensure_profile_path(install_dir: &str, profile: &ShellProfile) -> std::io::Result<bool> {
    ensure_profile_path_with(install_dir, profile, &home_dir())
}

/// [`ensure_profile_path`] with an explicit home dir (for tests).
pub fn ensure_profile_path_with(
    install_dir: &str,
    profile: &ShellProfile,
    home: &Path,
) -> std::io::Result<bool> {
    if let Some(parent) = profile.profile_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
    }

    let existing_content = fs::read_to_string(&profile.profile_path).unwrap_or_default();

    if profile_contains_path_with(&existing_content, install_dir, home) {
        return Ok(false);
    }

    let line = if profile.shell == "fish" {
        fish_path_line_with(install_dir, home)
    } else {
        path_export_line_with(install_dir, home)
    };

    let prefix = if !existing_content.is_empty() && !existing_content.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    let mut content = existing_content;
    content.push_str(prefix);
    content.push_str(&line);
    content.push('\n');
    fs::write(&profile.profile_path, content)?;
    Ok(true)
}

/// The default Linux install directory: `~/.local/bin`.
pub fn get_default_install_dir() -> PathBuf {
    home_dir().join(".local").join("bin")
}

/// Terminates running climon processes via `pkill`. Unix only.
#[cfg(unix)]
pub fn kill_running_climon_processes() {
    let _ = std::process::Command::new("pkill")
        .args(["-f", "(^|/)climon(-server)?$"])
        .output();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_bash_defaults_to_bashrc() {
        let p = detect_shell_profile_with(Some("/bin/bash"), Path::new("/home/ada"));
        assert_eq!(p.shell, "bash");
        assert!(p.profile_path.to_string_lossy().ends_with(".bashrc"));
    }

    #[test]
    fn detect_unknown_defaults_to_bashrc() {
        let p = detect_shell_profile_with(Some("/bin/ksh"), Path::new("/home/ada"));
        assert_eq!(p.shell, "ksh");
        assert!(p.profile_path.to_string_lossy().ends_with(".bashrc"));
    }

    #[test]
    fn ensure_creates_parent_dir_for_fish() {
        let dir = std::env::temp_dir().join(format!(
            "climon-linux-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let profile_path = dir.join(".config/fish/conf.d/climon.fish");
        let profile = ShellProfile {
            shell: "fish".into(),
            profile_path: profile_path.clone(),
        };
        let changed =
            ensure_profile_path_with("/test/.local/bin", &profile, Path::new("/home/ada")).unwrap();
        assert!(changed);
        assert_eq!(
            fs::read_to_string(&profile_path).unwrap(),
            "fish_add_path \"/test/.local/bin\"\n"
        );
        fs::remove_dir_all(&dir).ok();
    }
}
