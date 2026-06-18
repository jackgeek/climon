//! macOS install helpers: shell-profile PATH editing + process termination.
//! 1:1 port of `src/install/macos.ts`. Pure path/string logic is cross-platform
//! and unit-tested everywhere; `pkill` is gated to Unix.

use std::fs;
use std::path::{Path, PathBuf};

/// A detected user shell and the profile file climon edits for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellProfile {
    pub shell: String,
    pub profile_path: PathBuf,
}

fn profile_file_for_shell(shell: &str) -> &'static str {
    match shell {
        "zsh" => ".zshrc",
        "bash" => ".bash_profile",
        "fish" => ".config/fish/conf.d/climon.fish",
        _ => ".zshrc",
    }
}

fn shell_basename(shell_path: &str) -> &str {
    shell_path.rsplit('/').next().unwrap_or("zsh")
}

/// Returns the user's home directory (`$HOME`, falling back to `.`).
pub(crate) fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Detects the shell profile from an explicit `SHELL` value and home dir.
pub fn detect_shell_profile_with(shell_env: Option<&str>, home: &Path) -> ShellProfile {
    let shell = shell_basename(shell_env.unwrap_or("/bin/zsh")).to_string();
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

fn path_ref(install_dir: &str, home: &Path) -> String {
    let home = home.to_string_lossy();
    if install_dir.starts_with(home.as_ref()) {
        format!("$HOME{}", &install_dir[home.len()..])
    } else {
        install_dir.to_string()
    }
}

/// `export PATH="<dir>:$PATH"` with `$HOME` substitution.
pub fn path_export_line_with(install_dir: &str, home: &Path) -> String {
    format!("export PATH=\"{}:$PATH\"", path_ref(install_dir, home))
}

/// `export PATH="<dir>:$PATH"` against the real home directory.
pub fn path_export_line(install_dir: &str) -> String {
    path_export_line_with(install_dir, &home_dir())
}

/// `fish_add_path "<dir>"` with `$HOME` substitution.
pub fn fish_path_line_with(install_dir: &str, home: &Path) -> String {
    format!("fish_add_path \"{}\"", path_ref(install_dir, home))
}

/// `fish_add_path "<dir>"` against the real home directory.
pub fn fish_path_line(install_dir: &str) -> String {
    fish_path_line_with(install_dir, &home_dir())
}

/// Whether `profile_content` already references `install_dir` (literal or `$HOME` form).
pub fn profile_contains_path_with(profile_content: &str, install_dir: &str, home: &Path) -> bool {
    let path_ref = path_ref(install_dir, home);
    profile_content.contains(install_dir) || profile_content.contains(&path_ref)
}

/// Whether `profile_content` references `install_dir`, against the real home.
pub fn profile_contains_path(profile_content: &str, install_dir: &str) -> bool {
    profile_contains_path_with(profile_content, install_dir, &home_dir())
}

/// Appends a PATH line to the profile if not already present. Returns whether
/// the profile was changed. Uses the real home dir for `$HOME` substitution.
pub fn ensure_profile_path(install_dir: &str, profile: &ShellProfile) -> std::io::Result<bool> {
    ensure_profile_path_with(install_dir, profile, &home_dir())
}

/// [`ensure_profile_path`] with an explicit home dir (for tests).
pub fn ensure_profile_path_with(
    install_dir: &str,
    profile: &ShellProfile,
    home: &Path,
) -> std::io::Result<bool> {
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

/// The default macOS install directory: `~/.local/bin`.
pub fn get_default_install_dir() -> PathBuf {
    home_dir().join(".local").join("bin")
}

/// Terminates running climon processes via `pkill`. Unix only; a non-match
/// (non-zero exit) is treated as success.
#[cfg(unix)]
pub fn kill_running_climon_processes() {
    let _ = std::process::Command::new("pkill")
        .args(["-f", "(^|/)climon(-server)?$"])
        .output();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "climon-macos-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn path_export_line_substitutes_home() {
        let home = Path::new("/Users/ada");
        assert_eq!(
            path_export_line_with("/Users/ada/.local/bin", home),
            "export PATH=\"$HOME/.local/bin:$PATH\""
        );
    }

    #[test]
    fn path_export_line_literal_when_not_under_home() {
        let home = Path::new("/Users/ada");
        assert_eq!(
            path_export_line_with("/opt/climon/bin", home),
            "export PATH=\"/opt/climon/bin:$PATH\""
        );
    }

    #[test]
    fn fish_path_line_substitutes_home() {
        let home = Path::new("/Users/ada");
        assert_eq!(
            fish_path_line_with("/Users/ada/.local/bin", home),
            "fish_add_path \"$HOME/.local/bin\""
        );
    }

    #[test]
    fn profile_contains_home_form() {
        let home = Path::new("/Users/ada");
        let content = "export PATH=\"$HOME/.local/bin:$PATH\"\n";
        assert!(profile_contains_path_with(
            content,
            "/Users/ada/.local/bin",
            home
        ));
    }

    #[test]
    fn profile_contains_literal_form() {
        let home = Path::new("/Users/ada");
        let content = "export PATH=\"/Users/ada/.local/bin:$PATH\"\n";
        assert!(profile_contains_path_with(
            content,
            "/Users/ada/.local/bin",
            home
        ));
    }

    #[test]
    fn profile_does_not_contain() {
        let home = Path::new("/Users/ada");
        let content = "export PATH=\"/other/bin:$PATH\"\n";
        assert!(!profile_contains_path_with(
            content,
            "/usr/local/bin/climon",
            home
        ));
    }

    #[test]
    fn detect_zsh() {
        let p = detect_shell_profile_with(Some("/bin/zsh"), Path::new("/Users/ada"));
        assert_eq!(p.shell, "zsh");
        assert!(p.profile_path.to_string_lossy().ends_with(".zshrc"));
    }

    #[test]
    fn detect_bash_profile() {
        let p = detect_shell_profile_with(Some("/bin/bash"), Path::new("/Users/ada"));
        assert_eq!(p.shell, "bash");
        assert!(p.profile_path.to_string_lossy().ends_with(".bash_profile"));
    }

    #[test]
    fn detect_fish() {
        let p = detect_shell_profile_with(Some("/usr/local/bin/fish"), Path::new("/Users/ada"));
        assert_eq!(p.shell, "fish");
        assert!(p.profile_path.to_string_lossy().contains("fish"));
    }

    #[test]
    fn detect_unknown_defaults_to_zshrc() {
        let p = detect_shell_profile_with(Some("/bin/ksh"), Path::new("/Users/ada"));
        assert_eq!(p.shell, "ksh");
        assert!(p.profile_path.to_string_lossy().ends_with(".zshrc"));
    }

    #[test]
    fn ensure_appends_to_empty_profile() {
        let dir = temp_dir();
        let profile_path = dir.join(".zshrc");
        let profile = ShellProfile {
            shell: "zsh".into(),
            profile_path: profile_path.clone(),
        };
        let changed =
            ensure_profile_path_with("/test/.local/bin", &profile, Path::new("/Users/ada"))
                .unwrap();
        assert!(changed);
        assert_eq!(
            fs::read_to_string(&profile_path).unwrap(),
            "export PATH=\"/test/.local/bin:$PATH\"\n"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_appends_with_trailing_newline() {
        let dir = temp_dir();
        let profile_path = dir.join(".zshrc");
        fs::write(&profile_path, "# existing content\n").unwrap();
        let profile = ShellProfile {
            shell: "zsh".into(),
            profile_path: profile_path.clone(),
        };
        let changed =
            ensure_profile_path_with("/test/.local/bin", &profile, Path::new("/Users/ada"))
                .unwrap();
        assert!(changed);
        assert_eq!(
            fs::read_to_string(&profile_path).unwrap(),
            "# existing content\nexport PATH=\"/test/.local/bin:$PATH\"\n"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_appends_with_newline_separator() {
        let dir = temp_dir();
        let profile_path = dir.join(".zshrc");
        fs::write(&profile_path, "# no trailing newline").unwrap();
        let profile = ShellProfile {
            shell: "zsh".into(),
            profile_path: profile_path.clone(),
        };
        let changed =
            ensure_profile_path_with("/test/.local/bin", &profile, Path::new("/Users/ada"))
                .unwrap();
        assert!(changed);
        assert_eq!(
            fs::read_to_string(&profile_path).unwrap(),
            "# no trailing newline\nexport PATH=\"/test/.local/bin:$PATH\"\n"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_noop_when_already_present() {
        let dir = temp_dir();
        let profile_path = dir.join(".zshrc");
        fs::write(&profile_path, "export PATH=\"/test/.local/bin:$PATH\"\n").unwrap();
        let profile = ShellProfile {
            shell: "zsh".into(),
            profile_path: profile_path.clone(),
        };
        let changed =
            ensure_profile_path_with("/test/.local/bin", &profile, Path::new("/Users/ada"))
                .unwrap();
        assert!(!changed);
        assert_eq!(
            fs::read_to_string(&profile_path).unwrap(),
            "export PATH=\"/test/.local/bin:$PATH\"\n"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_uses_fish_add_path() {
        let dir = temp_dir();
        let profile_path = dir.join("climon.fish");
        let profile = ShellProfile {
            shell: "fish".into(),
            profile_path: profile_path.clone(),
        };
        let changed =
            ensure_profile_path_with("/test/.local/bin", &profile, Path::new("/Users/ada"))
                .unwrap();
        assert!(changed);
        assert_eq!(
            fs::read_to_string(&profile_path).unwrap(),
            "fish_add_path \"/test/.local/bin\"\n"
        );
        fs::remove_dir_all(&dir).ok();
    }
}
