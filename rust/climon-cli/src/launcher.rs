//! Session launcher: command start, listing, and kill flows. Port of
//! `src/launcher.ts`.
//!
//! Remote uplink/auto-link are Phase 9; they are no-op stubs here so run/shell
//! work end-to-end today.

use std::collections::HashMap;
use std::path::Path;

use climon_config::config::{
    ensure_climon_home, load_config, resolve_config_setting, Env as ConfigEnv,
};
use climon_logging::cli_io::{write_stderr, write_stdout};
use climon_logging::logger::{resume_terminal, suspend_terminal};
use climon_proto::meta::SessionMetaPatch;
use climon_proto::meta::{AnsiColor, Origin, PriorityReason, SessionMeta, SessionStatus};
use climon_proto::priority::sort_sessions_by_priority;
use climon_session::host::{run_session_host, SessionHostOptions};
use climon_session::socket::format_session_socket_ref;
use climon_store::meta::{
    list_sessions, read_session_meta, remove_session_meta, write_session_meta,
};
use climon_store::patch::patch_session_meta;
use climon_store::paths::now_iso;
use climon_store::session_id::generate_session_id;
use climon_store::Env as StoreEnv;

use crate::args::ColorFlag;
use crate::pathenv::which;
use crate::process_kill::{is_process_alive, kill_process};
use crate::spawn::{resolve_client_id, spawn_headless_session, SessionMetaOptions};
use crate::uplink_spawn::spawn_uplink_detached;
use crate::version::VERSION;
use climon_remote::devtunnel::DevtunnelGateway;
use climon_remote::discovery::{discover_dashboard, DashboardLocation, DiscoveryDeps};
use climon_remote::link::{maybe_auto_link as remote_maybe_auto_link, LinkDeps};

/// Environment variable carrying the nesting depth. Mirrors `NEST_LEVEL_ENV_VAR`.
const NEST_LEVEL_ENV_VAR: &str = "CLIMON_NEST_LEVEL";

/// Built-in default sort priority. Mirrors `DEFAULT_PRIORITY`.
pub const DEFAULT_PRIORITY: u16 = 500;

/// Auto color assignment preference order. Mirrors `AUTO_COLOR_ORDER`.
const AUTO_COLOR_ORDER: [AnsiColor; 8] = [
    AnsiColor::White,
    AnsiColor::Cyan,
    AnsiColor::Magenta,
    AnsiColor::Blue,
    AnsiColor::Yellow,
    AnsiColor::Green,
    AnsiColor::Red,
    AnsiColor::Black,
];

/// Reads the local terminal size from the controlling tty, falling back to
/// 80x24. Mirrors `terminalSize`.
fn terminal_size() -> (u16, u16) {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let fd = std::io::stdout().as_raw_fd();
        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) };
        if rc == 0 && ws.ws_col > 0 && ws.ws_row > 0 {
            return (ws.ws_col, ws.ws_row);
        }
    }
    (80, 24)
}

/// Resolves the launch size for headless/detached sessions from `CLIMON_COLS` /
/// `CLIMON_ROWS`, defaulting to 80x24. Mirrors `resolveLaunchSize`.
pub fn resolve_launch_size(env: &HashMap<String, String>) -> (u16, u16) {
    let cols = parse_int10(env.get("CLIMON_COLS").map(String::as_str).unwrap_or(""));
    let rows = parse_int10(env.get("CLIMON_ROWS").map(String::as_str).unwrap_or(""));
    let cols = match cols {
        Some(n) if n > 0 => n.min(u16::MAX as i64) as u16,
        _ => 80,
    };
    let rows = match rows {
        Some(n) if n > 0 => n.min(u16::MAX as i64) as u16,
        _ => 24,
    };
    (cols, rows)
}

/// Mirrors JavaScript's `Number.parseInt(value, 10)`: parses an optional sign
/// and a run of leading decimal digits, ignoring trailing garbage.
fn parse_int10(value: &str) -> Option<i64> {
    let bytes = value.trim_start().as_bytes();
    let mut idx = 0;
    let mut sign: i64 = 1;
    if idx < bytes.len() && (bytes[idx] == b'+' || bytes[idx] == b'-') {
        if bytes[idx] == b'-' {
            sign = -1;
        }
        idx += 1;
    }
    let start = idx;
    let mut acc: i64 = 0;
    while idx < bytes.len() && bytes[idx].is_ascii_digit() {
        acc = acc
            .saturating_mul(10)
            .saturating_add((bytes[idx] - b'0') as i64);
        idx += 1;
    }
    if idx == start {
        return None;
    }
    Some(sign * acc)
}

/// The launch banner emitted to the session log. Mirrors `launchBanner`.
pub fn launch_banner(version: &str, id: &str) -> String {
    format!("climon v{version} monitoring session {id}\r\n")
}

/// Builds a user-friendly display command from raw argv. Mirrors
/// `buildDisplayCommand`.
pub fn build_display_command(command: &[String]) -> String {
    if command.is_empty() {
        return String::new();
    }
    let first = &command[0];
    let is_absolute = first.starts_with('/') || is_windows_drive(first);
    if !is_absolute {
        return command.join(" ");
    }
    let short = strip_exe(basename(first));
    let mut parts = vec![short.to_string()];
    parts.extend(command[1..].iter().cloned());
    parts.join(" ")
}

/// Matches `^[A-Za-z]:[/\\]` (a Windows drive-rooted path).
fn is_windows_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')
}

/// Returns the final path segment, splitting on both `/` and `\`.
fn basename(s: &str) -> &str {
    let cut = s.rfind(['/', '\\']);
    match cut {
        Some(i) => &s[i + 1..],
        None => s,
    }
}

/// Strips a trailing `.exe` (case-insensitive). Mirrors `replace(/\.exe$/i, "")`.
fn strip_exe(s: &str) -> &str {
    if s.len() >= 4 && s[s.len() - 4..].eq_ignore_ascii_case(".exe") {
        &s[..s.len() - 4]
    } else {
        s
    }
}

/// CLI-supplied session default overrides. Mirrors `SessionDefaultFlags`.
#[derive(Debug, Clone, Default)]
pub struct SessionDefaultFlags {
    /// `None` means "consult config"; `Some(ColorFlag::None)` clears the color.
    pub color: Option<ColorFlag>,
    pub priority: Option<i64>,
}

/// Resolved per-session color + priority. Mirrors `ResolvedSessionDefaults`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSessionDefaults {
    pub color: Option<AnsiColor>,
    pub priority: u16,
}

/// Chooses the least-used concrete color, breaking ties by `AUTO_COLOR_ORDER`.
/// Mirrors `chooseAutoSessionColor`.
pub fn choose_auto_session_color(store_env: &StoreEnv) -> Result<AnsiColor, String> {
    let sessions = list_sessions(store_env).map_err(|e| e.to_string())?;
    let mut counts = [0u32; AUTO_COLOR_ORDER.len()];
    for session in &sessions {
        if let Some(Some(color)) = session.color {
            if let Some(idx) = AUTO_COLOR_ORDER.iter().position(|c| *c == color) {
                counts[idx] += 1;
            }
        }
    }
    let mut selected = 0usize;
    for idx in 1..AUTO_COLOR_ORDER.len() {
        if counts[idx] < counts[selected] {
            selected = idx;
        }
    }
    Ok(AUTO_COLOR_ORDER[selected])
}

/// Resolves a session's color + priority from CLI flags, then config, then
/// built-in defaults. Mirrors `resolveSessionDefaults`.
pub fn resolve_session_defaults(
    flags: &SessionDefaultFlags,
    store_env: &StoreEnv,
    config_env: &ConfigEnv,
    cwd: &Path,
) -> Result<ResolvedSessionDefaults, String> {
    let color = match flags.color {
        Some(ColorFlag::Auto) => Some(choose_auto_session_color(store_env)?),
        Some(ColorFlag::None) => None,
        Some(ColorFlag::Color(c)) => Some(c),
        None => {
            let raw = resolve_config_setting("session.color", config_env, cwd);
            let mode = match raw {
                Some(serde_json::Value::String(s)) => {
                    crate::args::parse_color_mode(&s).unwrap_or(ColorFlag::Auto)
                }
                _ => ColorFlag::Auto,
            };
            match mode {
                ColorFlag::Auto => Some(choose_auto_session_color(store_env)?),
                ColorFlag::None => None,
                ColorFlag::Color(c) => Some(c),
            }
        }
    };

    let priority = match flags.priority {
        Some(p) => p.clamp(0, 1000) as u16,
        None => {
            let raw = resolve_config_setting("session.priority", config_env, cwd);
            let n = match raw {
                Some(serde_json::Value::Number(num)) => num.as_f64(),
                Some(serde_json::Value::String(s)) => s.trim().parse::<f64>().ok(),
                _ => None,
            };
            match n {
                Some(x) if x.is_finite() && x.fract() == 0.0 && (0.0..=1000.0).contains(&x) => {
                    x as u16
                }
                _ => DEFAULT_PRIORITY,
            }
        }
    };

    Ok(ResolvedSessionDefaults { color, priority })
}

/// Remote uplink start config resolved from the cascade. Mirrors
/// `UplinkStartConfig`.
pub struct UplinkStartConfig {
    pub enabled: bool,
    pub host: Option<String>,
    pub tunnel_id: Option<String>,
    pub port: Option<u16>,
}

/// The decision of [`plan_uplink_start`]. Mirrors `UplinkStartPlan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UplinkStartPlan {
    pub should_spawn: bool,
    pub warning: Option<String>,
}

/// Launch-time Dev Tunnels probe result: whether the CLI is runnable and, if so,
/// whether the user is signed in, plus whether the probe timed out before it
/// could answer. Lets `plan_uplink_start` tell "CLI missing" apart from "CLI
/// present but logged out" apart from "devtunnel stalled / didn't respond".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevtunnelProbe {
    pub available: bool,
    pub authenticated: bool,
    pub timed_out: bool,
}

/// Decides whether to spawn the detached uplink. Mirrors `planUplinkStart`.
pub fn plan_uplink_start(config: &UplinkStartConfig, probe: &DevtunnelProbe) -> UplinkStartPlan {
    if !config.enabled {
        return UplinkStartPlan {
            should_spawn: false,
            warning: None,
        };
    }
    if config.host.is_some() && config.port.is_some() {
        return UplinkStartPlan {
            should_spawn: true,
            warning: None,
        };
    }
    if config.tunnel_id.is_none() {
        return UplinkStartPlan {
            should_spawn: false,
            warning: None,
        };
    }
    if !probe.available {
        return UplinkStartPlan {
            should_spawn: false,
            warning: Some(
                "climon: remote monitoring is configured, but the devtunnel CLI is not installed or not runnable on this machine. Install devtunnel for sessions to appear on the remote dashboard.\n"
                    .to_string(),
            ),
        };
    }
    if !probe.authenticated {
        return UplinkStartPlan {
            should_spawn: false,
            warning: Some(
                "climon: remote monitoring is configured, but Dev Tunnels is not signed in. Run `devtunnel user login`, then retry the session.\n"
                    .to_string(),
            ),
        };
    }
    UplinkStartPlan {
        should_spawn: true,
        warning: None,
    }
}

fn config_string(env: &ConfigEnv, cwd: &Path, key: &str) -> Option<String> {
    match resolve_config_setting(key, env, cwd) {
        Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

fn config_u16(env: &ConfigEnv, cwd: &Path, key: &str) -> Option<u16> {
    match resolve_config_setting(key, env, cwd) {
        Some(serde_json::Value::Number(n)) => n
            .as_f64()
            .filter(|f| f.fract() == 0.0 && (0.0..=65535.0).contains(f))
            .map(|f| f as u16),
        _ => None,
    }
}

/// Best-effort synchronous Dev Tunnels probe over the shared gateway. Reports
/// CLI availability and sign-in state so launch planning can distinguish
/// missing-CLI from logged-out. Mirrors `detectDevtunnel` + `showUser`.
fn probe_devtunnel_sync() -> DevtunnelProbe {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(_) => {
            return DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: false,
            }
        }
    };
    runtime.block_on(async {
        let gateway = DevtunnelGateway::new();
        let detected = gateway.detect().await;
        if !detected.available {
            return DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: false,
            };
        }
        let user = gateway.show_user().await;
        DevtunnelProbe {
            available: true,
            authenticated: user.authenticated,
            timed_out: false,
        }
    })
}

/// Auto-links WSL<->Windows dashboard discovery when appropriate. Mirrors
/// `maybeAutoLink`.
fn maybe_auto_link() {
    let env = ConfigEnv::real();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let mut out = |text: &str| write_stderr(text, false);
    remote_maybe_auto_link(&env, &cwd, &mut out, &LinkDeps::default());
}

/// Whether the same-machine peer uplink should be spawned. Pure decision split
/// out of `ensure_uplink` for testing gate #1.
pub fn should_spawn_peer_uplink(
    peer_home_set: bool,
    wsl_bridge_enabled: bool,
    peer_dashboard_found: bool,
) -> bool {
    peer_home_set && wsl_bridge_enabled && peer_dashboard_found
}

/// Spawns a detached uplink if the local session should appear on a remote (or
/// peer) dashboard. Mirrors `ensureUplink`.
fn ensure_uplink() {
    let env = ConfigEnv::real();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));

    let enabled =
        resolve_config_setting("remote.enabled", &env, &cwd) == Some(serde_json::Value::Bool(true));
    let host = config_string(&env, &cwd, "remote.host");
    let tunnel_id = config_string(&env, &cwd, "remote.tunnelId");
    let port = config_u16(&env, &cwd, "remote.port");
    let peer_home = config_string(&env, &cwd, "remote.peerHome");
    let wsl_bridge_enabled = load_config(&env)
        .map(|cfg| climon_config::features::is_feature_enabled(&cfg, "wslBridge"))
        .unwrap_or(false);

    let mut should_spawn = false;

    if peer_home.is_some() && wsl_bridge_enabled {
        if let Some(target) = discover_dashboard(&env, &cwd, &DiscoveryDeps::default()) {
            if target.location == DashboardLocation::Peer {
                should_spawn = should_spawn_peer_uplink(true, wsl_bridge_enabled, true);
                write_stdout(
                    &format!(
                        "climon: dashboard detected on the peer OS; this session will appear at {}\r\n",
                        target.url
                    ),
                    true,
                );
            }
        }
    }

    if !should_spawn {
        let needs_tunnel = enabled && host.is_none() && tunnel_id.is_some();
        let probe = if needs_tunnel {
            probe_devtunnel_sync()
        } else {
            DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: false,
            }
        };
        let plan = plan_uplink_start(
            &UplinkStartConfig {
                enabled,
                host,
                tunnel_id,
                port,
            },
            &probe,
        );
        if let Some(warning) = &plan.warning {
            write_stderr(warning, true);
        }
        should_spawn = plan.should_spawn;
    }

    if !should_spawn {
        return;
    }
    spawn_uplink_detached();
}

/// Options for [`start_monitored_command`]. Mirrors the TS options bag plus
/// `SessionDefaultFlags`.
#[derive(Debug, Clone, Default)]
pub struct StartOptions {
    pub headless: bool,
    pub name: Option<String>,
    pub color: Option<ColorFlag>,
    pub priority: Option<i64>,
    pub theme: Option<String>,
}

/// Starts a monitored session for `command`. Mirrors `startMonitoredCommand`.
pub fn start_monitored_command(command: &[String], options: StartOptions) -> Result<i32, String> {
    let env: HashMap<String, String> = std::env::vars().collect();
    let nest_level = parse_int10(
        env.get(NEST_LEVEL_ENV_VAR)
            .map(String::as_str)
            .unwrap_or(""),
    )
    .filter(|n| *n != 0)
    .unwrap_or(0);
    if nest_level > 0 {
        write_stderr(
            &format!(
                "\x1b[33mclimon: nested session (depth {})\x1b[0m\n",
                nest_level + 1
            ),
            true,
        );
    }

    if command.is_empty() {
        return Err("Provide a command to monitor, e.g. `climon copilot`.".to_string());
    }
    if !command[0].contains('/') && !command[0].contains('\\') && which(&command[0]).is_none() {
        return Err(format!("{}: command not found", command[0]));
    }

    let store_env = StoreEnv::from_env();
    let config_env = ConfigEnv::real();
    ensure_climon_home(&config_env)?;
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;

    let defaults = resolve_session_defaults(
        &SessionDefaultFlags {
            color: options.color,
            priority: options.priority,
        },
        &store_env,
        &config_env,
        &cwd,
    )?;

    let cwd_str = cwd.to_string_lossy().to_string();
    let theme = options.theme.clone();

    if options.headless {
        let (cols, rows) = resolve_launch_size(&env);
        let id = spawn_headless_session(
            command,
            &cwd_str,
            cols,
            rows,
            SessionMetaOptions {
                name: options.name,
                priority: Some(defaults.priority),
                color: defaults.color,
                theme,
            },
            &store_env,
            &config_env,
            &cwd,
        )?;
        maybe_auto_link();
        ensure_uplink();
        write_stdout(&format!("{id}\n"), true);
        return Ok(0);
    }

    let name = options.name;

    let id = generate_session_id(&store_env).map_err(|e| e.to_string())?;
    let (cols, rows) = terminal_size();
    let now = now_iso();
    let meta = SessionMeta {
        id: id.clone(),
        command: command.to_vec(),
        display_command: build_display_command(command),
        cwd: cwd_str,
        status: SessionStatus::Running,
        priority_reason: PriorityReason::Running,
        daemon_pid: None,
        cols,
        rows,
        headless: Some(false),
        socket_path: format_session_socket_ref("127.0.0.1", 0),
        client_version: Some(VERSION.to_string()),
        created_at: now.clone(),
        updated_at: now.clone(),
        last_activity_at: now,
        attention_matched_at: None,
        attention_reason: None,
        completed_at: None,
        exit_code: None,
        error: None,
        origin: None,
        client_label: Some(resolve_client_id(&config_env, &cwd)),
        name,
        priority: Some(defaults.priority),
        color: defaults.color.map(Some),
        theme,
        user_paused: None,
        terminal_title: None,
        attention_snippet: None,
        progress: None,
    };
    write_session_meta(&store_env, &meta).map_err(|e| e.to_string())?;

    maybe_auto_link();
    ensure_uplink();

    suspend_terminal();
    let result = run_session_host(&id, meta, SessionHostOptions { headless: false });
    resume_terminal();
    let exit_code = result.map_err(|e| e.to_string())?;

    if nest_level > 0 {
        write_stderr(
            &format!("\x1b[33mclimon: returning to session (depth {nest_level})\x1b[0m\n"),
            true,
        );
    }
    Ok(exit_code)
}

/// Lists monitored sessions to stdout. Mirrors `listSessionsCommand`.
pub fn list_sessions_command() -> Result<i32, String> {
    let store_env = StoreEnv::from_env();
    let sessions = sort_sessions_by_priority(list_sessions(&store_env).map_err(|e| e.to_string())?);
    if sessions.is_empty() {
        write_stdout("No climon sessions found.\n", true);
        return Ok(0);
    }
    for session in &sessions {
        let flag = if session.status == SessionStatus::NeedsAttention {
            "!"
        } else {
            " "
        };
        let label = match &session.name {
            Some(name) => format!("{name} ({})", session.display_command),
            None => session.display_command.clone(),
        };
        write_stdout(
            &format!(
                "{flag} {:<16} {:<16} {label}\n",
                session.id,
                status_str(session.status)
            ),
            true,
        );
    }
    Ok(0)
}

/// Returns the wire string for a status (matches the kebab-case serde form).
fn status_str(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::Running => "running",
        SessionStatus::Acknowledged => "acknowledged",
        SessionStatus::NeedsAttention => "needs-attention",
        SessionStatus::Completed => "completed",
        SessionStatus::Paused => "paused",
        SessionStatus::Failed => "failed",
        SessionStatus::Disconnected => "disconnected",
    }
}

/// Kill/alive function aliases. Mirror the injectable TS parameters.
type KillFn = fn(u32, bool) -> bool;
type AliveFn = fn(u32) -> bool;

/// Terminates a session's daemon (if any) and removes its metadata. Returns
/// whether the session was cleaned up. Mirrors `killSessionMeta`.
fn kill_session_meta(
    meta: &SessionMeta,
    store_env: &StoreEnv,
    kill: KillFn,
    is_alive: AliveFn,
) -> bool {
    let id = &meta.id;
    match meta.daemon_pid {
        None => {
            if meta.origin != Some(Origin::Remote) {
                write_stdout(
                    &format!(
                        "climon: could not terminate session {id}; daemon pid is not available yet.\n"
                    ),
                    true,
                );
                return false;
            }
        }
        Some(pid) => {
            if !kill(pid, false) && is_alive(pid) {
                kill(pid, true);
                if is_alive(pid) {
                    write_stdout(
                        &format!(
                            "climon: could not terminate session {id}; it may still be running.\n"
                        ),
                        true,
                    );
                    return false;
                }
            }
        }
    }
    let patch = SessionMetaPatch {
        status: Some(SessionStatus::Failed),
        priority_reason: Some(PriorityReason::Failed),
        ..Default::default()
    };
    let _ = patch_session_meta(store_env, id, patch);
    let _ = remove_session_meta(store_env, id);
    true
}

/// Kills a single session by id. Mirrors `killSession`.
pub fn kill_session(id: &str, kill: KillFn, is_alive: AliveFn) -> Result<i32, String> {
    let store_env = StoreEnv::from_env();
    kill_session_with_env(id, &store_env, kill, is_alive)
}

/// Variant with an explicit store env (for tests).
pub fn kill_session_with_env(
    id: &str,
    store_env: &StoreEnv,
    kill: KillFn,
    is_alive: AliveFn,
) -> Result<i32, String> {
    let meta = read_session_meta(store_env, id).map_err(|e| e.to_string())?;
    let meta = match meta {
        Some(m) => m,
        None => return Err(format!("No session found with id '{id}'.")),
    };
    if !kill_session_meta(&meta, store_env, kill, is_alive) {
        return Ok(1);
    }
    write_stdout(&format!("Killed session {id}.\n"), true);
    Ok(0)
}

/// Kills all active sessions. Mirrors `killAllSessions`.
pub fn kill_all_sessions(kill: KillFn, is_alive: AliveFn) -> Result<i32, String> {
    let store_env = StoreEnv::from_env();
    kill_all_sessions_with_env(&store_env, kill, is_alive)
}

/// Variant with an explicit store env (for tests).
pub fn kill_all_sessions_with_env(
    store_env: &StoreEnv,
    kill: KillFn,
    is_alive: AliveFn,
) -> Result<i32, String> {
    let mut active: Vec<SessionMeta> = list_sessions(store_env)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|s| {
            matches!(
                s.status,
                SessionStatus::Running
                    | SessionStatus::Acknowledged
                    | SessionStatus::NeedsAttention
                    | SessionStatus::Paused
            )
        })
        .collect();
    active.sort_by(|a, b| a.id.cmp(&b.id));
    if active.is_empty() {
        write_stdout("No active climon sessions found.\n", true);
        return Ok(0);
    }

    let mut killed = 0;
    let mut removed = 0;
    let mut failed = 0;
    for session in &active {
        if kill_session_meta(session, store_env, kill, is_alive) {
            if session.daemon_pid.is_none() {
                removed += 1;
            } else {
                killed += 1;
            }
        } else {
            failed += 1;
        }
    }

    if killed > 0 {
        write_stdout(
            &format!(
                "Killed {killed} climon session{}.\n",
                if killed == 1 { "" } else { "s" }
            ),
            true,
        );
    }
    if removed > 0 {
        write_stdout(
            &format!(
                "Removed {removed} daemon-less climon session{}.\n",
                if removed == 1 { "" } else { "s" }
            ),
            true,
        );
    }
    Ok(if failed == 0 { 0 } else { 1 })
}

/// Default kill/alive functions for production callers.
pub fn default_kill() -> KillFn {
    kill_process
}

/// Default alive check for production callers.
pub fn default_alive() -> AliveFn {
    is_process_alive
}

#[cfg(test)]
mod ensure_uplink_gate_tests {
    use super::should_spawn_peer_uplink;

    #[test]
    fn peer_uplink_requires_wsl_bridge_enabled() {
        assert!(should_spawn_peer_uplink(true, true, true));
        assert!(!should_spawn_peer_uplink(true, false, true)); // remotes on, wslBridge off -> no peer uplink
        assert!(!should_spawn_peer_uplink(true, true, false)); // no peer dashboard
        assert!(!should_spawn_peer_uplink(false, true, true)); // no peerHome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::{Mutex, MutexGuard};

    #[test]
    fn plan_uplink_warns_when_devtunnel_unavailable() {
        let plan = plan_uplink_start(
            &UplinkStartConfig {
                enabled: true,
                host: None,
                tunnel_id: Some("spiffy-chair-c2lj709.eun1".to_string()),
                port: None,
            },
            &DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: false,
            },
        );
        assert!(!plan.should_spawn);
        assert_eq!(
            plan.warning.as_deref(),
            Some(
                "climon: remote monitoring is configured, but the devtunnel CLI is not installed or not runnable on this machine. Install devtunnel for sessions to appear on the remote dashboard.\n"
            )
        );
    }

    #[test]
    fn plan_uplink_warns_when_devtunnel_logged_out() {
        let plan = plan_uplink_start(
            &UplinkStartConfig {
                enabled: true,
                host: None,
                tunnel_id: Some("spiffy-chair-c2lj709.eun1".to_string()),
                port: None,
            },
            &DevtunnelProbe {
                available: true,
                authenticated: false,
                timed_out: false,
            },
        );
        assert!(!plan.should_spawn);
        assert_eq!(
            plan.warning.as_deref(),
            Some(
                "climon: remote monitoring is configured, but Dev Tunnels is not signed in. Run `devtunnel user login`, then retry the session.\n"
            )
        );
    }

    #[test]
    fn plan_uplink_spawns_with_tunnel_and_devtunnel() {
        let plan = plan_uplink_start(
            &UplinkStartConfig {
                enabled: true,
                host: None,
                tunnel_id: Some("spiffy-chair-c2lj709.eun1".to_string()),
                port: None,
            },
            &DevtunnelProbe {
                available: true,
                authenticated: true,
                timed_out: false,
            },
        );
        assert_eq!(
            plan,
            UplinkStartPlan {
                should_spawn: true,
                warning: None
            }
        );
    }

    #[test]
    fn plan_uplink_spawns_for_direct_host_without_devtunnel() {
        let plan = plan_uplink_start(
            &UplinkStartConfig {
                enabled: true,
                host: Some("172.30.192.1".to_string()),
                tunnel_id: None,
                port: Some(3132),
            },
            &DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: false,
            },
        );
        assert_eq!(
            plan,
            UplinkStartPlan {
                should_spawn: true,
                warning: None
            }
        );
    }

    #[test]
    fn plan_uplink_noop_when_config_incomplete() {
        let plan = plan_uplink_start(
            &UplinkStartConfig {
                enabled: false,
                host: None,
                tunnel_id: None,
                port: None,
            },
            &DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: false,
            },
        );
        assert_eq!(
            plan,
            UplinkStartPlan {
                should_spawn: false,
                warning: None
            }
        );
    }

    #[test]
    fn plan_uplink_noop_when_only_enabled() {
        let plan = plan_uplink_start(
            &UplinkStartConfig {
                enabled: true,
                host: None,
                tunnel_id: None,
                port: None,
            },
            &DevtunnelProbe {
                available: true,
                authenticated: true,
                timed_out: false,
            },
        );
        assert_eq!(
            plan,
            UplinkStartPlan {
                should_spawn: false,
                warning: None
            }
        );
    }

    // Serialize tests that mutate process-global state (cwd / CLIMON_HOME via
    // StoreEnv::from_env is avoided by using explicit envs, but keep a lock for
    // any env-touching helpers).
    static LOCK: Mutex<()> = Mutex::new(());
    fn guard() -> MutexGuard<'static, ()> {
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn tmp_home() -> std::path::PathBuf {
        let base = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("launcher-tests");
        fs::create_dir_all(&base).unwrap();
        let unique = format!(
            "h-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let home = base.join(unique);
        fs::create_dir_all(&home).unwrap();
        home
    }

    fn store_env_for(home: &Path) -> StoreEnv {
        StoreEnv::with_home(home.join(".climon"))
    }

    fn config_env_for(home: &Path) -> ConfigEnv {
        let climon_home = home.join(".climon");
        ConfigEnv::new(Some(climon_home.to_str().unwrap()), home.to_path_buf())
    }

    fn write_session(home: &Path, id: &str, color: Option<&str>) {
        let sessions = home.join(".climon").join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let now = now_iso();
        let color_field = match color {
            Some(c) => format!(",\"color\":\"{c}\""),
            None => String::new(),
        };
        // Forward slashes keep the path valid inside the hand-built JSON string;
        // a raw Windows path (`C:\...`) would inject invalid JSON escapes and the
        // metadata would fail to parse. The cwd value is irrelevant to color
        // selection, so normalizing the separators is safe here.
        let cwd_json = home.to_string_lossy().replace('\\', "/");
        let meta = format!(
            "{{\"id\":\"{id}\",\"command\":[\"bash\"],\"displayCommand\":\"bash\",\"cwd\":\"{cwd_json}\",\"status\":\"running\",\"priorityReason\":\"running\",\"socketPath\":\"tcp://127.0.0.1:0\",\"cols\":80,\"rows\":24,\"createdAt\":\"{now}\",\"updatedAt\":\"{now}\",\"lastActivityAt\":\"{now}\"{color_field}}}"
        );
        fs::write(sessions.join(format!("{id}.json")), meta).unwrap();
    }

    #[test]
    fn resolve_launch_size_reads_cols_rows() {
        let mut env = HashMap::new();
        env.insert("CLIMON_COLS".to_string(), "120".to_string());
        env.insert("CLIMON_ROWS".to_string(), "40".to_string());
        assert_eq!(resolve_launch_size(&env), (120, 40));
    }

    #[test]
    fn resolve_launch_size_defaults_when_unset() {
        assert_eq!(resolve_launch_size(&HashMap::new()), (80, 24));
    }

    #[test]
    fn resolve_launch_size_defaults_when_invalid() {
        let mut env = HashMap::new();
        env.insert("CLIMON_COLS".to_string(), "abc".to_string());
        env.insert("CLIMON_ROWS".to_string(), "0".to_string());
        assert_eq!(resolve_launch_size(&env), (80, 24));
    }

    #[test]
    fn launch_banner_omits_dashboard_url() {
        let banner = launch_banner("0.1.16", "session-1");
        assert!(banner.contains("climon v0.1.16 monitoring session session-1"));
        assert!(!banner.contains("dashboard"));
        assert!(!banner.contains("http://"));
    }

    #[test]
    fn choose_auto_color_white_when_empty() {
        let _g = guard();
        let home = tmp_home();
        let store = store_env_for(&home);
        fs::create_dir_all(home.join(".climon").join("sessions")).unwrap();
        assert_eq!(choose_auto_session_color(&store).unwrap(), AnsiColor::White);
    }

    #[test]
    fn choose_auto_color_first_missing_in_order() {
        let _g = guard();
        let home = tmp_home();
        for (id, c) in [
            ("s-white", "white"),
            ("s-cyan", "cyan"),
            ("s-magenta", "magenta"),
            ("s-blue", "blue"),
            ("s-green", "green"),
            ("s-red", "red"),
            ("s-black", "black"),
        ] {
            write_session(&home, id, Some(c));
        }
        let store = store_env_for(&home);
        assert_eq!(
            choose_auto_session_color(&store).unwrap(),
            AnsiColor::Yellow
        );
    }

    #[test]
    fn choose_auto_color_least_used_tie_by_order() {
        let _g = guard();
        let home = tmp_home();
        for c in ["white", "cyan", "magenta", "blue", "yellow", "red", "black"] {
            write_session(&home, &format!("a-{c}"), Some(c));
            write_session(&home, &format!("b-{c}"), Some(c));
        }
        write_session(&home, "one-green", Some("green"));
        let store = store_env_for(&home);
        assert_eq!(choose_auto_session_color(&store).unwrap(), AnsiColor::Green);
    }

    #[test]
    fn defaults_cli_color_wins_over_config() {
        let _g = guard();
        let home = tmp_home();
        fs::create_dir_all(home.join(".climon")).unwrap();
        fs::write(
            home.join(".climon").join("config.json"),
            r#"{"session":{"color":"red","priority":500}}"#,
        )
        .unwrap();
        let store = store_env_for(&home);
        let cfg = config_env_for(&home);
        let out = resolve_session_defaults(
            &SessionDefaultFlags {
                color: Some(ColorFlag::Color(AnsiColor::Green)),
                priority: Some(20),
            },
            &store,
            &cfg,
            &home,
        )
        .unwrap();
        assert_eq!(out.color, Some(AnsiColor::Green));
        assert_eq!(out.priority, 20);
    }

    #[test]
    fn defaults_config_color_wins_over_auto() {
        let _g = guard();
        let home = tmp_home();
        fs::create_dir_all(home.join(".climon")).unwrap();
        fs::write(
            home.join(".climon").join("config.json"),
            r#"{"session":{"color":"red","priority":500}}"#,
        )
        .unwrap();
        let store = store_env_for(&home);
        let cfg = config_env_for(&home);
        let out =
            resolve_session_defaults(&SessionDefaultFlags::default(), &store, &cfg, &home).unwrap();
        assert_eq!(out.color, Some(AnsiColor::Red));
        assert_eq!(out.priority, 500);
    }

    #[test]
    fn defaults_auto_config_color_resolves_concrete() {
        let _g = guard();
        let home = tmp_home();
        fs::create_dir_all(home.join(".climon").join("sessions")).unwrap();
        fs::write(
            home.join(".climon").join("config.json"),
            r#"{"session":{"color":"auto"}}"#,
        )
        .unwrap();
        let store = store_env_for(&home);
        let cfg = config_env_for(&home);
        let out =
            resolve_session_defaults(&SessionDefaultFlags::default(), &store, &cfg, &home).unwrap();
        assert_eq!(out.color, Some(AnsiColor::White));
    }

    #[test]
    fn defaults_none_config_color_resolves_null() {
        let _g = guard();
        let home = tmp_home();
        fs::create_dir_all(home.join(".climon")).unwrap();
        fs::write(
            home.join(".climon").join("config.json"),
            r#"{"session":{"color":"none"}}"#,
        )
        .unwrap();
        let store = store_env_for(&home);
        let cfg = config_env_for(&home);
        let out =
            resolve_session_defaults(&SessionDefaultFlags::default(), &store, &cfg, &home).unwrap();
        assert_eq!(out.color, None);
    }

    #[test]
    fn defaults_explicit_null_color_flag_respected() {
        let _g = guard();
        let home = tmp_home();
        fs::create_dir_all(home.join(".climon")).unwrap();
        fs::write(
            home.join(".climon").join("config.json"),
            r#"{"session":{"color":"red"}}"#,
        )
        .unwrap();
        let store = store_env_for(&home);
        let cfg = config_env_for(&home);
        let out = resolve_session_defaults(
            &SessionDefaultFlags {
                color: Some(ColorFlag::None),
                priority: None,
            },
            &store,
            &cfg,
            &home,
        )
        .unwrap();
        assert_eq!(out.color, None);
    }

    #[test]
    fn build_display_command_variants() {
        assert_eq!(build_display_command(&[]), "");
        assert_eq!(
            build_display_command(&["bash".to_string(), "-l".to_string()]),
            "bash -l"
        );
        assert_eq!(
            build_display_command(&["/usr/bin/bash".to_string(), "-l".to_string()]),
            "bash -l"
        );
        assert_eq!(
            build_display_command(&[r"C:\Windows\System32\powershell.exe".to_string()]),
            "powershell"
        );
    }
}
