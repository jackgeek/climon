//! Command-line argument parsing for the `climon` client.
//!
//! A faithful port of `src/cli/args.ts` (plus `parsePriority`/`parseColorMode`
//! from `src/session-meta.ts`). The TS client uses a hand-rolled parser — not a
//! declarative one — because of its bare-flag→shell behavior and the hidden
//! `__session`/`__uplink`/`__ingest`/`__update-check` entrypoints. This port
//! keeps that hand-rolled structure so the accepted argv surface stays
//! byte-for-byte compatible with the Bun client.

use climon_proto::meta::AnsiColor;

use crate::version::VERSION;

/// A session color flag value. Mirrors the TS `SessionColorMode | null` used for
/// the `--color` flag: absent (`Option::None`), explicit "none" ([`ColorFlag::None`],
/// serialized by the launcher to a cleared color), "auto" ([`ColorFlag::Auto`]),
/// or a concrete color.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorFlag {
    /// `--color none` — clears any inherited/config color (TS `null`).
    None,
    /// `--color auto` — defer concrete color selection to session creation.
    Auto,
    /// A concrete ANSI color.
    Color(AnsiColor),
}

impl ColorFlag {
    /// The wire string climon emits for `--color` (mirrors `BuildColor`).
    pub fn wire_name(&self) -> &'static str {
        match self {
            ColorFlag::None => "none",
            ColorFlag::Auto => "auto",
            ColorFlag::Color(color) => color.name(),
        }
    }
}

/// The parsed top-level command. Mirrors the TS `ParsedCommand` union.
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedCommand {
    Help,
    Version,
    Shell {
        priority: Option<i64>,
        color: Option<ColorFlag>,
        name: Option<String>,
    },
    Server {
        port: Option<f64>,
        enable_remotes: bool,
        no_takeover: bool,
    },
    Ls,
    Kill {
        id: String,
    },
    KillAll,
    Run {
        argv: Vec<String>,
        headless: bool,
        priority: Option<i64>,
        color: Option<ColorFlag>,
        name: Option<String>,
    },
    /// `climon __spawn [--headless] [--cwd D] [--cols N] [--rows N] [meta] <cmd>`
    /// — internal command used by the dashboard server to create a session on
    /// this machine, either headless or in a visible terminal window.
    Spawn {
        argv: Vec<String>,
        headless: bool,
        cwd: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
        name: Option<String>,
        color: Option<ColorFlag>,
        priority: Option<i64>,
    },
    Config {
        argv: Vec<String>,
    },
    Link {
        argv: Vec<String>,
    },
    Uplink,
    Session {
        id: String,
    },
    Cleanup,
    Update {
        argv: Vec<String>,
    },
    Setup {
        argv: Vec<String>,
    },
    UpdateCheck,
    Ingest,
    /// `climon licenses` — print embedded third-party license notices. This is a
    /// Phase-8 addition with no TS counterpart; it is intentionally absent from
    /// the help text to preserve byte-exact `--help` output.
    Licenses,
}

/// Canonical ANSI color names in `ANSI_COLORS` order (matches `session-meta.ts`).
const ANSI_COLOR_NAMES: &str = "black, red, green, yellow, blue, magenta, cyan, white";

/// Returns the help text, embedding the version on line 1. Byte-identical to the
/// TS `helpText` template literal.
pub fn help_text() -> String {
    format!(
        "climon v{VERSION} — web-based monitor for interactive CLI sessions

Usage:
  climon [--priority N] [--color C] [--name S]
                               Start a monitored session for the current shell
  climon [--priority N] [--color C] [--name S] <command> [args...]
                               Run a command in a monitored PTY session
                               (priority 0-1000; color: auto|none|black|red|
                               green|yellow|blue|magenta|cyan|white)
  climon server [--port N] [--enable-remotes] [--no-takeover]
                               Start the dashboard web server (loopback only)
                               (--no-takeover: never terminate an existing
                               server; start on the next available port)
  climon ls                    List monitored sessions
  climon config <key> [value]   Get/set configuration (git-style)
  climon config --help          Show config settings, defaults, and scopes
  climon config --debug         Show config files, keys, and values (redacted) in resolution order
  climon config --purge         Prompt to delete config files in resolution order
  climon cleanup                Stop this machine's dashboard, ingest, and uplink
  climon link [--peer-home P]   Link WSL<->Windows dashboard discovery
  climon kill <id>             Terminate a session
  climon kill --all            Kill or remove all active sessions
  climon update                Download, verify, and apply the latest version
                               (never interrupts running sessions)
  climon setup                 Re-run onboarding (licence, telemetry, updates)
  climon --version             Show the climon version
  climon --help                Show this help
"
    )
}

/// Replicates JavaScript's `Number(value.trim())` enough for CLI inputs:
/// trims, treats an empty string as `0`, and otherwise parses a float (NaN on
/// failure).
fn js_number(value: &str) -> f64 {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// Parses and validates a priority value into an integer in 0..=1000. Mirrors
/// `parsePriority`.
pub fn parse_priority(value: &str) -> Result<i64, String> {
    let n = js_number(value);
    if !n.is_finite() || n.fract() != 0.0 {
        return Err(format!(
            "Priority must be an integer between 0 and 1000 (got \"{value}\")."
        ));
    }
    if !(0.0..=1000.0).contains(&n) {
        return Err(format!(
            "Priority must be between 0 and 1000 (got \"{value}\")."
        ));
    }
    Ok(n as i64)
}

/// Parses a color mode for session creation/defaults. "auto" and "none" are
/// accepted; otherwise a concrete color. Mirrors `parseColorMode`.
pub fn parse_color_mode(value: &str) -> Result<ColorFlag, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized == "auto" {
        return Ok(ColorFlag::Auto);
    }
    if normalized == "none" {
        return Ok(ColorFlag::None);
    }
    if let Some(color) = AnsiColor::from_name(&normalized) {
        return Ok(ColorFlag::Color(color));
    }
    Err(format!(
        "Color must be one of: auto, none, {ANSI_COLOR_NAMES} (got \"{value}\")."
    ))
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct SessionFlags {
    priority: Option<i64>,
    color: Option<ColorFlag>,
    name: Option<String>,
}

/// Consumes leading `--priority`/`--color`/`--name` flags (both `--flag value`
/// and `--flag=value` forms) from the front of `tokens`. Mirrors
/// `parseSessionFlags`.
fn parse_session_flags(tokens: &[String]) -> Result<(SessionFlags, Vec<String>), String> {
    let mut flags = SessionFlags::default();
    let mut i = 0usize;
    while i < tokens.len() {
        let token = &tokens[i];
        let eq = token.find('=');
        let (key, inline_value): (&str, Option<&str>) = match (token.starts_with("--"), eq) {
            (true, Some(idx)) => (&token[..idx], Some(&token[idx + 1..])),
            _ => (token.as_str(), None),
        };

        // Consumes the flag value: the inline `=value` form or the next token.
        // Advances `i` past a consumed next token.
        macro_rules! take_value {
            () => {{
                if let Some(v) = inline_value {
                    v.to_string()
                } else {
                    match tokens.get(i + 1) {
                        Some(next) => {
                            i += 1;
                            next.clone()
                        }
                        None => return Err(format!("Missing value for {key}.")),
                    }
                }
            }};
        }

        match key {
            "--priority" => {
                let raw = take_value!();
                flags.priority = Some(parse_priority(&raw)?);
            }
            "--color" => {
                let raw = take_value!();
                flags.color = Some(parse_color_mode(&raw)?);
            }
            "--name" => {
                flags.name = Some(take_value!());
            }
            _ => break,
        }
        i += 1;
    }
    Ok((flags, tokens[i..].to_vec()))
}

fn shell_from_flags(flags: SessionFlags) -> ParsedCommand {
    ParsedCommand::Shell {
        priority: flags.priority,
        color: flags.color,
        name: flags.name,
    }
}

fn run_from_flags(argv: Vec<String>, headless: bool, flags: SessionFlags) -> ParsedCommand {
    ParsedCommand::Run {
        argv,
        headless,
        priority: flags.priority,
        color: flags.color,
        name: flags.name,
    }
}

/// Parses the client's argv (everything after the program name). Mirrors
/// `parseArgs`.
pub fn parse_args(argv: &[String]) -> Result<ParsedCommand, String> {
    if argv.is_empty() {
        return Ok(ParsedCommand::Shell {
            priority: None,
            color: None,
            name: None,
        });
    }

    // Bare leading flags trigger shell mode (or run, if a command follows).
    let first = &argv[0];
    if first.starts_with("--")
        && !matches!(
            first.as_str(),
            "--help" | "-h" | "--version" | "-v" | "--update"
        )
    {
        let (flags, rest) = parse_session_flags(argv)?;
        if rest.is_empty() {
            return Ok(shell_from_flags(flags));
        }
        return Ok(run_from_flags(rest, false, flags));
    }

    let rest: Vec<String> = argv[1..].to_vec();

    match first.as_str() {
        "help" | "--help" | "-h" => Ok(ParsedCommand::Help),
        "--version" | "-v" => Ok(ParsedCommand::Version),
        "--update" | "update" => Ok(ParsedCommand::Update { argv: rest }),
        "setup" => Ok(ParsedCommand::Setup { argv: rest }),
        "__update-check" => Ok(ParsedCommand::UpdateCheck),
        "server" => {
            let mut port: Option<f64> = None;
            let mut enable_remotes = false;
            let mut no_takeover = false;
            let mut i = 0usize;
            while i < rest.len() {
                let arg = &rest[i];
                if arg == "--port" {
                    port = Some(js_number(rest.get(i + 1).map(String::as_str).unwrap_or("")));
                    i += 1;
                } else if let Some(value) = arg.strip_prefix("--port=") {
                    port = Some(js_number(value));
                } else if arg == "--enable-remotes" {
                    enable_remotes = true;
                } else if arg == "--no-takeover" {
                    no_takeover = true;
                }
                i += 1;
            }
            Ok(ParsedCommand::Server {
                port,
                enable_remotes,
                no_takeover,
            })
        }
        "ls" | "list" => Ok(ParsedCommand::Ls),
        "kill" => {
            let id = rest.first();
            match id {
                Some(v) if v == "--all" => Ok(ParsedCommand::KillAll),
                Some(v) => Ok(ParsedCommand::Kill { id: v.clone() }),
                None => Err("Provide a session id, e.g. `climon kill <id>`.".to_string()),
            }
        }
        "run" => {
            let mut headless = false;
            let mut remaining: Vec<String> = Vec::new();
            let mut saw_non_headless = false;
            for arg in &rest {
                if arg == "--headless" && !saw_non_headless && remaining.is_empty() {
                    headless = true;
                } else {
                    saw_non_headless = true;
                    remaining.push(arg.clone());
                }
            }
            let (flags, run_argv) = parse_session_flags(&remaining)?;
            if run_argv.is_empty() {
                return Err("Provide a command to run, e.g. `climon run npm test`.".to_string());
            }
            Ok(run_from_flags(run_argv, headless, flags))
        }
        "__spawn" => {
            let mut headless = false;
            let mut cwd: Option<String> = None;
            let mut cols: Option<u16> = None;
            let mut rows: Option<u16> = None;
            let mut rest_tokens: Vec<String> = Vec::new();
            let mut it = rest.into_iter();
            while let Some(tok) = it.next() {
                match tok.as_str() {
                    "--headless" if rest_tokens.is_empty() => headless = true,
                    "--cwd" if rest_tokens.is_empty() => {
                        cwd = Some(it.next().ok_or("Missing value for --cwd.".to_string())?);
                    }
                    "--cols" if rest_tokens.is_empty() => {
                        cols = Some(
                            it.next()
                                .ok_or("Missing value for --cols.".to_string())?
                                .parse()
                                .map_err(|_| "Invalid --cols.".to_string())?,
                        );
                    }
                    "--rows" if rest_tokens.is_empty() => {
                        rows = Some(
                            it.next()
                                .ok_or("Missing value for --rows.".to_string())?
                                .parse()
                                .map_err(|_| "Invalid --rows.".to_string())?,
                        );
                    }
                    _ => rest_tokens.push(tok),
                }
            }
            let (flags, argv) = parse_session_flags(&rest_tokens)?;
            if argv.is_empty() {
                return Err(
                    "Provide a command to spawn, e.g. `climon __spawn npm test`.".to_string(),
                );
            }
            Ok(ParsedCommand::Spawn {
                argv,
                headless,
                cwd,
                cols,
                rows,
                name: flags.name,
                color: flags.color,
                priority: flags.priority,
            })
        }
        "config" => Ok(ParsedCommand::Config { argv: rest }),
        "cleanup" => Ok(ParsedCommand::Cleanup),
        "link" => Ok(ParsedCommand::Link { argv: rest }),
        "__uplink" => Ok(ParsedCommand::Uplink),
        "__ingest" => Ok(ParsedCommand::Ingest),
        "licenses" => Ok(ParsedCommand::Licenses),
        "__session" => {
            if rest.len() != 1 {
                return Err("Provide a session id, e.g. `climon __session <id>`.".to_string());
            }
            Ok(ParsedCommand::Session {
                id: rest[0].clone(),
            })
        }
        _ => {
            let (flags, run_argv) = parse_session_flags(argv)?;
            if run_argv.is_empty() {
                return Err("Provide a command to run, e.g. `climon npm test`.".to_string());
            }
            Ok(run_from_flags(run_argv, false, flags))
        }
    }
}

/// Color option for [`build_run_args`]. Mirrors the server `SpawnMetaOptions`
/// `color` field: absent (`Option::None`), explicit cleared (`BuildColor::None`,
/// serialized to "none"), "auto", or a concrete color.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildColor {
    None,
    Auto,
    Color(AnsiColor),
}

/// Builds the `run --headless [...flags] <command>` argv the dashboard server
/// uses to spawn a child session. Faithful port of `buildRunArgs`
/// (`src/server/server.ts`); kept here as the inverse of [`parse_args`] for
/// round-trip interop testing.
pub fn build_run_args(
    command: &[String],
    priority: Option<i64>,
    color: Option<BuildColor>,
    name: Option<&str>,
) -> Vec<String> {
    let mut out = vec!["run".to_string(), "--headless".to_string()];
    if let Some(p) = priority {
        out.push("--priority".to_string());
        out.push(p.to_string());
    }
    if let Some(c) = color {
        out.push("--color".to_string());
        out.push(
            match c {
                BuildColor::None => "none",
                BuildColor::Auto => "auto",
                BuildColor::Color(color) => color.name(),
            }
            .to_string(),
        );
    }
    if let Some(n) = name {
        if !n.is_empty() {
            out.push("--name".to_string());
            out.push(n.to_string());
        }
    }
    out.extend(command.iter().cloned());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    fn parse(args: &[&str]) -> ParsedCommand {
        parse_args(&v(args)).expect("parse ok")
    }

    // ---- helpText ----

    #[test]
    fn help_text_includes_version() {
        assert!(help_text().contains(&format!("v{VERSION}")));
    }

    #[test]
    fn parse_spawn_headless_with_cwd_and_command() {
        assert_eq!(
            parse(&[
                "__spawn",
                "--headless",
                "--cwd",
                "/work",
                "--cols",
                "100",
                "--rows",
                "30",
                "npm",
                "test"
            ]),
            ParsedCommand::Spawn {
                argv: vec!["npm".into(), "test".into()],
                headless: true,
                cwd: Some("/work".into()),
                cols: Some(100),
                rows: Some(30),
                name: None,
                priority: None,
                color: None,
            }
        );
    }

    #[test]
    fn parse_spawn_visible_default_with_meta_flags() {
        assert_eq!(
            parse(&[
                "__spawn",
                "--cwd",
                "/w",
                "--name",
                "build",
                "--priority",
                "800",
                "bash"
            ]),
            ParsedCommand::Spawn {
                argv: vec!["bash".into()],
                headless: false,
                cwd: Some("/w".into()),
                cols: None,
                rows: None,
                name: Some("build".into()),
                priority: Some(800),
                color: None,
            }
        );
    }

    #[test]
    fn help_text_documents_bulk_kill() {
        let h = help_text();
        assert!(h.contains("climon kill --all"));
        assert!(h.contains("Kill or remove all active sessions"));
    }

    #[test]
    fn help_text_points_at_config_help() {
        assert!(help_text().contains("climon config --help"));
    }

    // ---- parseArgs ----

    #[test]
    fn defaults_to_shell_with_no_args() {
        assert_eq!(
            parse(&[]),
            ParsedCommand::Shell {
                priority: None,
                color: None,
                name: None
            }
        );
    }

    #[test]
    fn parses_help_flags() {
        assert_eq!(parse(&["--help"]), ParsedCommand::Help);
        assert_eq!(parse(&["-h"]), ParsedCommand::Help);
        assert_eq!(parse(&["help"]), ParsedCommand::Help);
    }

    #[test]
    fn parses_version_flags() {
        assert_eq!(parse(&["--version"]), ParsedCommand::Version);
        assert_eq!(parse(&["-v"]), ParsedCommand::Version);
    }

    #[test]
    fn parses_server_with_port() {
        assert_eq!(
            parse(&["server", "--port", "9000"]),
            ParsedCommand::Server {
                port: Some(9000.0),
                enable_remotes: false,
                no_takeover: false
            }
        );
    }

    #[test]
    fn parses_server_with_inline_port() {
        assert_eq!(
            parse(&["server", "--port=4000"]),
            ParsedCommand::Server {
                port: Some(4000.0),
                enable_remotes: false,
                no_takeover: false
            }
        );
    }

    #[test]
    fn parses_server_with_enable_remotes() {
        assert_eq!(
            parse(&["server", "--enable-remotes", "--port", "9000"]),
            ParsedCommand::Server {
                port: Some(9000.0),
                enable_remotes: true,
                no_takeover: false
            }
        );
    }

    #[test]
    fn parses_server_with_no_takeover() {
        assert_eq!(
            parse(&["server", "--no-takeover"]),
            ParsedCommand::Server {
                port: None,
                enable_remotes: false,
                no_takeover: true
            }
        );
        assert_eq!(
            parse(&[
                "server",
                "--no-takeover",
                "--port",
                "9000",
                "--enable-remotes"
            ]),
            ParsedCommand::Server {
                port: Some(9000.0),
                enable_remotes: true,
                no_takeover: true
            }
        );
    }

    #[test]
    fn parses_ls_and_kill() {
        assert_eq!(parse(&["ls"]), ParsedCommand::Ls);
        assert_eq!(parse(&["list"]), ParsedCommand::Ls);
        assert_eq!(
            parse(&["kill", "abc"]),
            ParsedCommand::Kill {
                id: "abc".to_string()
            }
        );
        assert_eq!(parse(&["kill", "--all"]), ParsedCommand::KillAll);
    }

    #[test]
    fn treats_unknown_commands_as_run() {
        assert_eq!(
            parse(&["copilot", "--foo"]),
            run_from_flags(v(&["copilot", "--foo"]), false, SessionFlags::default())
        );
    }

    #[test]
    fn parses_explicit_run_with_headless() {
        assert_eq!(
            parse(&["run", "--headless", "npm", "test"]),
            run_from_flags(v(&["npm", "test"]), true, SessionFlags::default())
        );
    }

    #[test]
    fn parses_explicit_run_without_headless() {
        assert_eq!(
            parse(&["run", "npm", "test"]),
            run_from_flags(v(&["npm", "test"]), false, SessionFlags::default())
        );
    }

    #[test]
    fn throws_when_run_has_no_command() {
        assert!(parse_args(&v(&["run"])).is_err());
        assert!(parse_args(&v(&["run", "--headless"])).is_err());
    }

    #[test]
    fn throws_when_kill_id_missing() {
        assert!(parse_args(&v(&["kill"])).is_err());
    }

    #[test]
    fn parses_config_passthrough_argv() {
        assert_eq!(
            parse(&["config", "--global", "remote.host", "h"]),
            ParsedCommand::Config {
                argv: v(&["--global", "remote.host", "h"])
            }
        );
    }

    #[test]
    fn parses_internal_uplink_entrypoint() {
        assert_eq!(parse(&["__uplink"]), ParsedCommand::Uplink);
    }

    #[test]
    fn parses_leading_session_flags_before_command() {
        assert_eq!(
            parse(&[
                "--priority",
                "800",
                "--color",
                "red",
                "--name",
                "dev",
                "npm",
                "run",
                "dev"
            ]),
            ParsedCommand::Run {
                argv: v(&["npm", "run", "dev"]),
                headless: false,
                priority: Some(800),
                color: Some(ColorFlag::Color(AnsiColor::Red)),
                name: Some("dev".to_string())
            }
        );
    }

    #[test]
    fn supports_flag_equals_value_form() {
        assert_eq!(
            parse(&["--priority=250", "--color=blue", "bash"]),
            ParsedCommand::Run {
                argv: v(&["bash"]),
                headless: false,
                priority: Some(250),
                color: Some(ColorFlag::Color(AnsiColor::Blue)),
                name: None
            }
        );
    }

    #[test]
    fn parses_color_auto() {
        assert_eq!(
            parse(&["--color", "Auto", "bash"]),
            ParsedCommand::Run {
                argv: v(&["bash"]),
                headless: false,
                priority: None,
                color: Some(ColorFlag::Auto),
                name: None
            }
        );
    }

    #[test]
    fn stops_parsing_flags_at_first_non_flag_token() {
        assert_eq!(
            parse(&["npm", "run", "build", "--color"]),
            run_from_flags(
                v(&["npm", "run", "build", "--color"]),
                false,
                SessionFlags::default()
            )
        );
    }

    #[test]
    fn explicit_run_with_headless_and_priority() {
        assert_eq!(
            parse(&["run", "--headless", "--priority", "10", "sleep", "30"]),
            ParsedCommand::Run {
                argv: v(&["sleep", "30"]),
                headless: true,
                priority: Some(10),
                color: None,
                name: None
            }
        );
    }

    #[test]
    fn rejects_invalid_priority() {
        let err = parse_args(&v(&["--priority", "2000", "bash"])).unwrap_err();
        assert!(err.contains("0 and 1000"));
    }

    #[test]
    fn rejects_invalid_color() {
        let err = parse_args(&v(&["--color", "orange", "bash"])).unwrap_err();
        assert!(err.contains("must be one of"));
    }

    #[test]
    fn bare_flags_with_no_command_defaults_to_shell() {
        assert_eq!(
            parse(&["--name", "my session"]),
            ParsedCommand::Shell {
                priority: None,
                color: None,
                name: Some("my session".to_string())
            }
        );
        assert_eq!(
            parse(&["--priority", "5", "--color", "blue"]),
            ParsedCommand::Shell {
                priority: Some(5),
                color: Some(ColorFlag::Color(AnsiColor::Blue)),
                name: None
            }
        );
    }

    // ---- update / setup ----

    #[test]
    fn update_parses_to_update_command() {
        assert_eq!(parse(&["update"]), ParsedCommand::Update { argv: vec![] });
        assert_eq!(parse(&["--update"]), ParsedCommand::Update { argv: vec![] });
        assert_eq!(
            parse(&["update", "--check"]),
            ParsedCommand::Update {
                argv: v(&["--check"])
            }
        );
    }

    #[test]
    fn setup_carries_argv() {
        assert_eq!(
            parse(&["setup", "--telemetry=on"]),
            ParsedCommand::Setup {
                argv: v(&["--telemetry=on"])
            }
        );
    }

    // ---- buildRunArgs ----

    #[test]
    fn build_run_args_no_flags() {
        assert_eq!(
            build_run_args(&v(&["npm", "run", "dev"]), None, None, None),
            v(&["run", "--headless", "npm", "run", "dev"])
        );
    }

    #[test]
    fn build_run_args_all_flags() {
        assert_eq!(
            build_run_args(
                &v(&["bash"]),
                Some(800),
                Some(BuildColor::Color(AnsiColor::Red)),
                Some("shell")
            ),
            v(&[
                "run",
                "--headless",
                "--priority",
                "800",
                "--color",
                "red",
                "--name",
                "shell",
                "bash"
            ])
        );
    }

    #[test]
    fn build_run_args_color_none() {
        assert_eq!(
            build_run_args(&v(&["bash"]), None, Some(BuildColor::None), None),
            v(&["run", "--headless", "--color", "none", "bash"])
        );
    }

    #[test]
    fn build_run_args_color_auto() {
        assert_eq!(
            build_run_args(&v(&["bash"]), None, Some(BuildColor::Auto), None),
            v(&["run", "--headless", "--color", "auto", "bash"])
        );
    }
}
