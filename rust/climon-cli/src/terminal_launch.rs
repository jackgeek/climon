//! Opens a GUI terminal-emulator window running an attached `climon` command,
//! so a non-headless (visible) session spawned from the dashboard is visible to
//! the user of this machine. Pure command builders are unit-tested; `launch`
//! performs the actual spawn.

use std::path::Path;

/// A concrete OS command to run: program plus its argument vector.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
}

/// Single-quote a string for safe embedding in a POSIX shell script.
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// macOS: drive Terminal.app via AppleScript, cd'ing into `cwd` first.
pub fn build_macos(cwd: &Path, climon_cmd: &str) -> LaunchSpec {
    let script = format!(
        "tell application \"Terminal\" to do script \"cd {} && {}\"",
        sh_quote(&cwd.to_string_lossy()).replace('"', "\\\""),
        climon_cmd.replace('"', "\\\"")
    );
    LaunchSpec {
        program: "osascript".into(),
        args: vec!["-e".into(), script],
    }
}

/// Windows: Windows Terminal with an explicit working directory.
pub fn build_windows(cwd: &Path, climon_cmd: &str) -> LaunchSpec {
    let mut args = vec!["-d".to_string(), cwd.to_string_lossy().to_string()];
    args.extend(climon_cmd.split_whitespace().map(str::to_string));
    LaunchSpec {
        program: "wt.exe".into(),
        args,
    }
}

/// Build from a user `session.terminalProgram` template containing `{cmd}`.
/// The template is whitespace-split into program + args; the single `{cmd}`
/// token is replaced by the climon command split into its own tokens.
pub fn build_from_template(template: &str, _cwd: &Path, climon_cmd: &str) -> Option<LaunchSpec> {
    let mut tokens = template.split_whitespace();
    let program = tokens.next()?.to_string();
    let mut args = Vec::new();
    for tok in tokens {
        if tok == "{cmd}" {
            args.extend(climon_cmd.split_whitespace().map(str::to_string));
        } else {
            args.push(tok.to_string());
        }
    }
    Some(LaunchSpec { program, args })
}

/// Linux autodetect with an injectable PATH predicate (for testing).
pub fn build_linux_with<F: Fn(&str) -> bool>(
    cwd: &Path,
    climon_cmd: &str,
    on_path: F,
) -> Option<LaunchSpec> {
    const CANDIDATES: &[&str] = &["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];
    let cwd_s = cwd.to_string_lossy().to_string();
    for term in CANDIDATES {
        if on_path(term) {
            let mut args: Vec<String> = match *term {
                "gnome-terminal" => vec![format!("--working-directory={cwd_s}"), "--".into()],
                "konsole" => vec!["--workdir".into(), cwd_s.clone(), "-e".into()],
                _ => vec!["-e".into()],
            };
            args.extend(climon_cmd.split_whitespace().map(str::to_string));
            return Some(LaunchSpec {
                program: (*term).to_string(),
                args,
            });
        }
    }
    None
}

/// Returns whether `program` resolves on PATH (used by the real autodetect).
fn program_on_path(program: &str) -> bool {
    crate::pathenv::which(program).is_some()
}

/// Resolve a [`LaunchSpec`] for the current OS, honoring `terminal_program`
/// (the `session.terminalProgram` config value) when set. Returns `None` when
/// no terminal could be resolved (e.g. headless Linux box with no emulator).
pub fn resolve_spec(
    cwd: &Path,
    climon_cmd: &str,
    terminal_program: Option<&str>,
) -> Option<LaunchSpec> {
    if let Some(tpl) = terminal_program.filter(|t| !t.trim().is_empty()) {
        return build_from_template(tpl, cwd, climon_cmd);
    }
    #[cfg(target_os = "macos")]
    {
        return Some(build_macos(cwd, climon_cmd));
    }
    #[cfg(target_os = "windows")]
    {
        return Some(build_windows(cwd, climon_cmd));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return build_linux_with(cwd, climon_cmd, program_on_path);
    }
    #[allow(unreachable_code)]
    {
        let _ = program_on_path;
        None
    }
}

/// Actually open the terminal window. Returns Err when no terminal could be
/// resolved or the spawn failed, so the caller can fall back to headless.
pub fn launch(cwd: &Path, climon_cmd: &str, terminal_program: Option<&str>) -> Result<(), String> {
    let spec = resolve_spec(cwd, climon_cmd, terminal_program)
        .ok_or_else(|| "no terminal emulator found on this machine".to_string())?;
    std::process::Command::new(&spec.program)
        .args(&spec.args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch {}: {e}", spec.program))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_uses_applescript_with_cd_and_command() {
        let spec = build_macos(Path::new("/work/dir"), "climon copilot");
        assert_eq!(spec.program, "osascript");
        // The AppleScript cd's into the dir then runs the command in Terminal.
        let joined = spec.args.join(" ");
        assert!(joined.contains("Terminal"));
        assert!(joined.contains("cd '/work/dir'"));
        assert!(joined.contains("climon copilot"));
    }

    #[test]
    fn windows_uses_wt_with_working_directory() {
        let spec = build_windows(Path::new("C:/work"), "climon copilot");
        assert_eq!(spec.program, "wt.exe");
        assert_eq!(spec.args[0], "-d");
        assert_eq!(spec.args[1], "C:/work");
        // Remaining args run the command.
        assert!(spec.args.join(" ").contains("climon copilot"));
    }

    #[test]
    fn linux_override_template_substitutes_cmd_placeholder() {
        let spec = build_from_template("alacritty -e {cmd}", Path::new("/w"), "climon copilot")
            .expect("template parses");
        assert_eq!(spec.program, "alacritty");
        assert_eq!(spec.args, vec!["-e", "climon", "copilot"]);
    }

    #[test]
    fn linux_autodetect_prefers_first_available() {
        // detect() takes an injectable "is this program on PATH?" predicate.
        let spec = build_linux_with(Path::new("/w"), "climon copilot", |p| p == "gnome-terminal");
        let spec = spec.expect("a terminal was found");
        assert_eq!(spec.program, "gnome-terminal");
        assert!(spec.args.join(" ").contains("climon copilot"));
    }

    #[test]
    fn linux_autodetect_none_available_returns_none() {
        let spec = build_linux_with(Path::new("/w"), "climon copilot", |_| false);
        assert!(spec.is_none());
    }
}
