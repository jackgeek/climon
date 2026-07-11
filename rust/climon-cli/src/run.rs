//! Client command dispatch, shared by the Unix `climon` bin and the Windows
//! `climon.dll` cdylib. Moved out of `main.rs` so both build targets dispatch
//! through one entrypoint. Port of `src/index.ts` main().

// Task 8: the ingest host spawn closure returns the large typed
// `DevtunnelFailure`; allow the lint crate-consistent with gateway.rs.
#![allow(clippy::result_large_err)]

use std::io::{BufRead, Write};

use crate::args::{help_text, parse_args, ParsedCommand};
use crate::config_cmd::{run_config_command, ConfigCommandIo};
use crate::detect_shell::{build_shell_argv, detect_parent_shell};
use crate::launcher::{
    default_alive, default_kill, kill_all_sessions, kill_session, list_sessions_command,
    start_monitored_command, StartOptions,
};
use crate::server_exec::delegate_to_server;
use crate::version::VERSION;
use crate::{CLIMON_LICENSE, THIRD_PARTY_LICENSES};
use climon_config::config::Env as ConfigEnv;
use climon_logging::cli_io::{log_cli_command, write_stderr, write_stdout};
use climon_logging::logger::{init_logger, LoggerInitOptions};
use climon_logging::sinks::LogRole;
use climon_proto::meta::SessionMeta;
use climon_session::host::{run_session_host, SessionHostOptions};
use climon_store::meta::read_session_meta;
use climon_store::Env as StoreEnv;
use climon_update::check::run_background_check_default;
use climon_update::launch_hooks::{
    maybe_show_license_notice, maybe_show_update_banner, maybe_spawn_background_check,
};
use climon_update::update_cli::run_update_cli;

/// Runs the client with an explicit argv (excluding the program name), returning
/// a process exit code. This is the single entrypoint for both build targets.
pub fn run(argv: &[String]) -> i32 {
    match dispatch(argv) {
        Ok(code) => code,
        Err(message) => {
            write_stderr(&format!("climon: {message}\n"), true);
            1
        }
    }
}

fn dispatch(argv: &[String]) -> Result<i32, String> {
    let parsed = parse_args(argv)?;

    // Update banner + background check on the interactive launch paths, mirroring
    // src/index.ts (lines 71-74). The swap is non-destructive, so this never
    // interrupts running sessions.
    if matches!(
        parsed,
        ParsedCommand::Shell { .. } | ParsedCommand::Run { .. }
    ) {
        let cfg_env = ConfigEnv::real();
        maybe_show_license_notice(&cfg_env);
        maybe_show_update_banner(&cfg_env);
        let exec_path = std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "climon".to_string());
        maybe_spawn_background_check(&exec_path, &cfg_env);

        // Best-effort reaper of superseded versioned binaries on the interactive
        // launch paths only (Windows). Skipped on scripted commands so it never
        // adds latency; deletions of locked files silently no-op.
        #[cfg(windows)]
        {
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    let _ = climon_update::reaper::reap_superseded(dir);
                }
            }
        }
    }

    let name = command_name(&parsed);
    if name != "uplink" && name != "update-check" {
        let _ = init_logger(
            LogRole::Client,
            LoggerInitOptions {
                version: Some(VERSION.to_string()),
                ..Default::default()
            },
        );
        log_cli_command(name);
    }

    match parsed {
        ParsedCommand::Help { implicit } => {
            let cfg_env = ConfigEnv::real();
            let experimental = climon_config::config::load_config(&cfg_env)
                .map(|cfg| crate::args::ExperimentalHelp {
                    remotes: climon_config::features::is_feature_enabled(&cfg, "remotes")
                        || climon_config::features::is_feature_enabled(&cfg, "wslBridge"),
                    wsl_bridge: climon_config::features::is_feature_enabled(&cfg, "wslBridge"),
                })
                .unwrap_or_default();
            if implicit {
                write_stderr(
                    "climon on its own no longer starts a session — showing help instead.\nUse `climon shell` to start a monitored shell, or `climon <command>` to run a command.\n\n",
                    false,
                );
            }
            write_stdout(&help_text(experimental), false);
            Ok(0)
        }
        ParsedCommand::Version => {
            write_stdout(&format!("climon v{VERSION}\n"), true);
            Ok(0)
        }
        ParsedCommand::Server { .. } => {
            let env: std::collections::HashMap<String, String> = std::env::vars().collect();
            let exec_path = std::env::current_exe()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "climon".to_string());
            Ok(delegate_to_server(argv, &env, &exec_path))
        }
        ParsedCommand::Shell {
            priority,
            color,
            name,
            theme,
        } => {
            let shell = detect_parent_shell();
            let shell_argv = build_shell_argv(&shell);
            let shell_name = name.unwrap_or_else(|| strip_exe(basename(&shell)).to_string());
            start_monitored_command(
                &shell_argv,
                StartOptions {
                    headless: false,
                    name: Some(shell_name),
                    priority,
                    color,
                    theme,
                },
            )
        }
        ParsedCommand::Ls => list_sessions_command(),
        ParsedCommand::Kill { id } => kill_session(&id, default_kill(), default_alive()),
        ParsedCommand::KillAll => kill_all_sessions(default_kill(), default_alive()),
        ParsedCommand::Run {
            argv,
            headless,
            priority,
            color,
            name,
            theme,
        } => start_monitored_command(
            &argv,
            StartOptions {
                headless,
                name,
                priority,
                color,
                theme,
            },
        ),
        ParsedCommand::Config { argv } => Ok(run_config(&argv)),
        ParsedCommand::Spawn {
            argv,
            headless,
            cwd,
            cols,
            rows,
            name,
            color,
            priority,
            theme,
        } => {
            let req = crate::spawn_command::SpawnRequest {
                argv,
                headless,
                cwd: cwd.unwrap_or_else(|| {
                    std::env::current_dir()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| ".".to_string())
                }),
                cols: cols.unwrap_or(80),
                rows: rows.unwrap_or(24),
                name,
                color,
                priority,
                theme,
                terminal_program: crate::spawn_command::resolve_terminal_program(),
            };
            crate::spawn_command::run_spawn_command(req)
        }
        ParsedCommand::Cleanup => Ok(run_cleanup()),
        ParsedCommand::Remotes { watch, json } => run_remotes_command(watch, json),
        ParsedCommand::Link { argv } => Ok(run_link(&argv)),
        ParsedCommand::Uplink => Ok(run_uplink_entry()),
        ParsedCommand::Ingest => Ok(run_ingest_entry()),
        ParsedCommand::Session { id } => {
            climon_store::validate_session_id(&id).map_err(|e| e.to_string())?;
            let store_env = StoreEnv::from_env();
            let meta: Option<SessionMeta> =
                read_session_meta(&store_env, &id).map_err(|e| e.to_string())?;
            let meta = meta.ok_or_else(|| format!("No session found with id '{id}'."))?;
            run_session_host(&id, meta, SessionHostOptions { headless: true })
                .map_err(|e| e.to_string())
        }
        ParsedCommand::License => {
            write_stdout(CLIMON_LICENSE, false);
            write_stdout("\n\n=== Third-party attributions ===\n\n", false);
            write_stdout(THIRD_PARTY_LICENSES, false);
            Ok(0)
        }
        ParsedCommand::Setup { argv } => run_setup(&argv),
        // `climon update` / `__update-check`: wired to climon-update (Phase 10).
        ParsedCommand::Update { argv } => {
            let cfg_env = ConfigEnv::real();
            Ok(run_update_cli(&argv, &cfg_env))
        }
        ParsedCommand::UpdateCheck => {
            let cfg_env = ConfigEnv::real();
            run_background_check_default(&cfg_env, climon_update::version::VERSION);
            Ok(0)
        }
    }
}

/// Runs `climon config` with stdio wired to the process streams and an
/// interactive purge confirmation reading from stdin.
fn run_config(argv: &[String]) -> i32 {
    let env = ConfigEnv::real();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    let mut confirm = |_path: &str| -> bool {
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        if std::io::stdin().lock().read_line(&mut line).is_err() {
            return false;
        }
        let answer = line.trim().to_ascii_lowercase();
        answer == "y" || answer == "yes"
    };
    let mut io = ConfigCommandIo {
        stdout: &mut stdout,
        stderr: &mut stderr,
        confirm: &mut confirm,
    };
    run_config_command(argv, &env, &cwd, &mut io)
}

/// Runs `climon setup`, re-running onboarding (telemetry/auto-update
/// opt-ins, install id) against the real config environment. Mirrors the TS
/// `index.ts` `setup` case delegating to `runSetupCommand`.
fn run_setup(argv: &[String]) -> Result<i32, String> {
    let env = ConfigEnv::real();
    climon_install::run_setup_command(argv, &env)
}

/// `climon cleanup`: tear down this OS's dashboard stack and remove beacons.
fn run_cleanup() -> i32 {
    use crate::cleanup_cmd::{cleanup_deps, run_cleanup_command, CleanupCommandIo};
    use crate::process_kill::{is_process_alive, kill_process};
    let env = ConfigEnv::real();
    let deps = cleanup_deps(Box::new(is_process_alive), Box::new(kill_process), 3000);
    let mut io = CleanupCommandIo {
        stdout: &mut |t: &str| write_stdout(t, true),
        stderr: &mut |t: &str| write_stderr(t, true),
    };
    run_cleanup_command(&env, deps, &mut io)
}

/// `climon remotes [--watch] [--json]`: render both directions of the remote
/// bridge from the durable status beacons. Thin I/O + watch loop over the pure
/// `remotes_cmd` core.
fn run_remotes_command(watch: bool, json: bool) -> Result<i32, String> {
    use std::io::IsTerminal;
    let cfg_env = ConfigEnv::real();
    let remotes_enabled = climon_config::config::load_config(&cfg_env)
        .map(|cfg| {
            climon_config::features::is_feature_enabled(&cfg, "remotes")
                || climon_config::features::is_feature_enabled(&cfg, "wslBridge")
        })
        .unwrap_or(false);
    let is_tty = std::io::stdout().is_terminal();

    let render_once = || {
        let now = climon_remote::time::now_ms();
        let view = crate::remotes_cmd::read_view(&cfg_env, now, remotes_enabled);
        if json {
            serde_json::to_string_pretty(&view).unwrap_or_else(|_| "{}".to_string())
        } else {
            crate::remotes_cmd::render_human(&view, now, is_tty)
        }
    };

    if !watch || json {
        write_stdout(&render_once(), true);
        return Ok(0);
    }

    // --watch: clear + redraw on an interval until interrupted.
    loop {
        write_stdout("\x1b[2J\x1b[H", false); // clear screen, home cursor
        write_stdout(&render_once(), true);
        std::thread::sleep(std::time::Duration::from_millis(1000));
    }
}

/// `climon link [--peer-home <path>]`: wire WSL<->Windows dashboard discovery.
fn run_link(argv: &[String]) -> i32 {
    use crate::link_cmd::run_link_command;
    use std::io::IsTerminal;
    let env = ConfigEnv::real();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let is_tty = std::io::stdin().is_terminal();
    let mut confirm = |question: &str| -> bool {
        write_stdout(question, true);
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        if std::io::stdin().lock().read_line(&mut line).is_err() {
            return true;
        }
        let answer = line.trim().to_ascii_lowercase();
        answer.is_empty() || answer == "y" || answer == "yes"
    };
    run_link_command(argv, &env, &cwd, is_tty, &mut confirm, &mut |t: &str| {
        write_stdout(t, true)
    })
}

/// `climon __uplink`: run the devbox uplink supervisor on a tokio runtime.
fn run_uplink_entry() -> i32 {
    let config_env = ConfigEnv::real();
    let store_env = StoreEnv::from_env();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            write_stderr(
                &format!("climon uplink: failed to start runtime: {e}\n"),
                true,
            );
            return 1;
        }
    };
    runtime.block_on(climon_remote::uplink::run_uplink(
        config_env, store_env, &cwd,
    ))
}

/// `climon __ingest`: run the ingest daemon on a tokio runtime, stopping on
/// SIGINT/SIGTERM. Returns a process code derived from the daemon's exit reason.
fn run_ingest_entry() -> i32 {
    use crate::uplink_spawn::spawn_uplink_detached;
    use climon_remote::ingest::{run_ingest_daemon, IngestDaemonDeps, IngestExit};
    use std::sync::Arc;
    use tokio::sync::Notify;

    let config_env = ConfigEnv::real();
    let store_env = StoreEnv::from_env();
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            write_stderr(
                &format!("climon ingest: failed to start runtime: {e}\n"),
                true,
            );
            return 1;
        }
    };
    runtime.block_on(async move {
        let stop = Arc::new(Notify::new());
        let stop_signal = stop.clone();
        tokio::spawn(async move {
            #[cfg(unix)]
            {
                let mut sigint =
                    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                    {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                let mut sigterm =
                    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                tokio::select! {
                    _ = sigint.recv() => {}
                    _ = sigterm.recv() => {}
                }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            stop_signal.notify_one();
        });

        let host_gateway = climon_remote::devtunnel::DevtunnelGateway::new();
        let deps = IngestDaemonDeps {
            spawn_uplink: Box::new(spawn_uplink_detached),
            stop_local_server: Box::new(|| {}),
            spawn_host: Box::new(move |id: &str| {
                climon_remote::ingest::spawn_devtunnel_host(&host_gateway, id)
            }),
        };
        match run_ingest_daemon(config_env, store_env, stop, deps).await {
            Ok(IngestExit::AlreadyRunning) => 0,
            Ok(IngestExit::Stopped) => 0,
            Ok(IngestExit::Demoted) => 0,
            Err(e) => {
                write_stderr(&format!("climon ingest: {e}\n"), true);
                1
            }
        }
    })
}

/// Maps a parsed command to its canonical name (matches the TS `parsed.command`
/// strings used for logging).
fn command_name(parsed: &ParsedCommand) -> &'static str {
    match parsed {
        ParsedCommand::Help { .. } => "help",
        ParsedCommand::Version => "version",
        ParsedCommand::Server { .. } => "server",
        ParsedCommand::Shell { .. } => "shell",
        ParsedCommand::Ls => "ls",
        ParsedCommand::Kill { .. } => "kill",
        ParsedCommand::KillAll => "kill-all",
        ParsedCommand::Run { .. } => "run",
        ParsedCommand::Spawn { .. } => "spawn",
        ParsedCommand::Config { .. } => "config",
        ParsedCommand::Cleanup => "cleanup",
        ParsedCommand::Remotes { .. } => "remotes",
        ParsedCommand::Link { .. } => "link",
        ParsedCommand::Uplink => "uplink",
        ParsedCommand::Session { .. } => "session",
        ParsedCommand::Update { .. } => "update",
        ParsedCommand::Setup { .. } => "setup",
        ParsedCommand::UpdateCheck => "update-check",
        ParsedCommand::Ingest => "ingest",
        ParsedCommand::License => "license",
    }
}

/// Returns the final path segment, splitting on both `/` and `\`.
fn basename(s: &str) -> &str {
    match s.rfind(['/', '\\']) {
        Some(i) => &s[i + 1..],
        None => s,
    }
}

/// Strips a trailing `.exe` (case-insensitive).
fn strip_exe(s: &str) -> &str {
    if s.len() >= 4 && s[s.len() - 4..].eq_ignore_ascii_case(".exe") {
        &s[..s.len() - 4]
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::command_name;
    use crate::args::ParsedCommand;
    use climon_logging::cli_io::CLIMON_SUBCOMMANDS;

    /// Every subcommand keyword `command_name` can emit must be covered by the
    /// telemetry allowlist, so `log_cli_command` never trips its debug assert and
    /// only ever records a known keyword — never a user-supplied command.
    #[test]
    fn command_name_outputs_are_allowlisted() {
        let zero_field = [
            command_name(&ParsedCommand::Help { implicit: false }),
            command_name(&ParsedCommand::Version),
            command_name(&ParsedCommand::Ls),
            command_name(&ParsedCommand::KillAll),
            command_name(&ParsedCommand::Uplink),
            command_name(&ParsedCommand::Cleanup),
            command_name(&ParsedCommand::UpdateCheck),
            command_name(&ParsedCommand::Ingest),
            command_name(&ParsedCommand::License),
        ];
        for name in zero_field {
            assert!(
                CLIMON_SUBCOMMANDS.contains(&name),
                "command_name returned {name:?}, not in CLIMON_SUBCOMMANDS"
            );
        }
    }
}
