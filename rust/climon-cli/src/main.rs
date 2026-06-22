//! `climon` client entrypoint. Port of `src/index.ts` command dispatch.
//!
//! All commands are now wired: `setup` to climon-install (Phase 11);
//! `update`/`__update-check` plus the launch-time update banner + background
//! check to climon-update (Phase 10); and `__uplink`/`__ingest`/`link`/`cleanup`
//! plus the launcher auto-uplink/auto-link hooks to climon-remote (Phase 9).

use std::io::{BufRead, Write};

use climon_cli::args::{help_text, parse_args, ParsedCommand};
use climon_cli::config_cmd::{run_config_command, ConfigCommandIo};
use climon_cli::detect_shell::{build_shell_argv, detect_parent_shell};
use climon_cli::launcher::{
    default_alive, default_kill, kill_all_sessions, kill_session, list_sessions_command,
    start_monitored_command, StartOptions,
};
use climon_cli::server_exec::delegate_to_server;
use climon_cli::version::VERSION;
use climon_cli::THIRD_PARTY_LICENSES;
use climon_config::config::Env as ConfigEnv;
use climon_logging::cli_io::{log_cli_command, write_stderr, write_stdout};
use climon_logging::logger::{init_logger, LoggerInitOptions};
use climon_logging::sinks::LogRole;
use climon_proto::meta::SessionMeta;
use climon_session::host::{run_session_host, SessionHostOptions};
use climon_store::meta::read_session_meta;
use climon_store::Env as StoreEnv;
use climon_update::check::run_background_check_default;
use climon_update::launch_hooks::{maybe_show_update_banner, maybe_spawn_background_check};
use climon_update::update_cli::run_update_cli;

fn main() {
    let code = match run() {
        Ok(code) => code,
        Err(message) => {
            write_stderr(&format!("climon: {message}\n"), true);
            1
        }
    };
    std::process::exit(code);
}

fn run() -> Result<i32, String> {
    // If a `climon-alpha` sentinel is present next to the executable, run the
    // native self-install and return — this runs FIRST, before arg parsing,
    // matching `src/index.ts` main() order (tryRunInstaller). The Bun client
    // loaded a JS installer bundle here; the Rust client installs natively.
    if let Some(code) = try_run_installer() {
        return Ok(code);
    }

    let argv: Vec<String> = std::env::args().skip(1).collect();
    let parsed = parse_args(&argv)?;

    // Update banner + background check on the interactive launch paths, mirroring
    // src/index.ts (lines 71-74). The swap is non-destructive, so this never
    // interrupts running sessions.
    if matches!(
        parsed,
        ParsedCommand::Shell { .. } | ParsedCommand::Run { .. }
    ) {
        let cfg_env = ConfigEnv::real();
        maybe_show_update_banner(&cfg_env);
        let exec_path = std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "climon".to_string());
        maybe_spawn_background_check(&exec_path, &cfg_env);
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
        ParsedCommand::Help => {
            write_stdout(&help_text(), false);
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
            Ok(delegate_to_server(&argv, &env, &exec_path))
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
            let req = climon_cli::spawn_command::SpawnRequest {
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
                terminal_program: climon_cli::spawn_command::resolve_terminal_program(),
            };
            climon_cli::spawn_command::run_spawn_command(req)
        }
        ParsedCommand::Cleanup => Ok(run_cleanup()),
        ParsedCommand::Link { argv } => Ok(run_link(&argv)),
        ParsedCommand::Uplink => Ok(run_uplink_entry()),
        ParsedCommand::Ingest => Ok(run_ingest_entry()),
        ParsedCommand::Session { id } => {
            let store_env = StoreEnv::from_env();
            let meta: Option<SessionMeta> =
                read_session_meta(&store_env, &id).map_err(|e| e.to_string())?;
            let meta = meta.ok_or_else(|| format!("No session found with id '{id}'."))?;
            run_session_host(&id, meta, SessionHostOptions { headless: true })
                .map_err(|e| e.to_string())
        }
        ParsedCommand::Licenses => {
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

/// Checks for the `climon-alpha` self-install sentinel next to the executable.
/// When present, hands off to the native installer and returns its exit code;
/// otherwise returns `None` so normal dispatch proceeds. Port of
/// `tryRunInstaller` in `src/index.ts`.
fn try_run_installer() -> Option<i32> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    if !climon_cli::installer::installer_marker_present(exe_dir) {
        return None;
    }
    Some(climon_install::run_installer(VERSION))
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

/// Runs `climon setup`, re-running onboarding (EULA gate, telemetry/auto-update
/// opt-ins, install id) against the real config environment. Mirrors the TS
/// `index.ts` `setup` case delegating to `runSetupCommand`.
fn run_setup(argv: &[String]) -> Result<i32, String> {
    let env = ConfigEnv::real();
    climon_install::run_setup_command(argv, &env)
}

/// `climon cleanup`: tear down this OS's dashboard stack and remove beacons.
fn run_cleanup() -> i32 {
    use climon_cli::cleanup_cmd::{cleanup_deps, run_cleanup_command, CleanupCommandIo};
    use climon_cli::process_kill::{is_process_alive, kill_process};
    let env = ConfigEnv::real();
    let deps = cleanup_deps(Box::new(is_process_alive), Box::new(kill_process), 3000);
    let mut io = CleanupCommandIo {
        stdout: &mut |t: &str| write_stdout(t, true),
        stderr: &mut |t: &str| write_stderr(t, true),
    };
    run_cleanup_command(&env, deps, &mut io)
}

/// `climon link [--peer-home <path>]`: wire WSL<->Windows dashboard discovery.
fn run_link(argv: &[String]) -> i32 {
    use climon_cli::link_cmd::run_link_command;
    let env = ConfigEnv::real();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    run_link_command(argv, &env, &cwd, &mut |t: &str| write_stdout(t, true))
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
    use climon_cli::uplink_spawn::spawn_uplink_detached;
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

        let deps = IngestDaemonDeps {
            spawn_uplink: Box::new(spawn_uplink_detached),
            stop_local_server: Box::new(|| {}),
            spawn_host: IngestDaemonDeps::default().spawn_host,
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
        ParsedCommand::Help => "help",
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
        ParsedCommand::Link { .. } => "link",
        ParsedCommand::Uplink => "uplink",
        ParsedCommand::Session { .. } => "session",
        ParsedCommand::Update { .. } => "update",
        ParsedCommand::Setup { .. } => "setup",
        ParsedCommand::UpdateCheck => "update-check",
        ParsedCommand::Ingest => "ingest",
        ParsedCommand::Licenses => "licenses",
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
