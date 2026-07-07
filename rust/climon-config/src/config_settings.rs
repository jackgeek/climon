//! Config settings registry + coercion. 1:1 port of `src/config-settings.ts`.

use crate::features::FEATURE_FLAGS;
use climon_proto::session_meta::DEFAULT_PRIORITY;
use serde_json::Value;

/// Schema version for the persisted config format.
pub const CONFIG_VERSION: i64 = 1;
/// Default detach-key prefix byte (`Ctrl-\`).
pub const DEFAULT_DETACH_PREFIX: i64 = 0x1c;

const TERMINAL_HELP_WIDTH: usize = 88;

/// The process roles a setting applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigProcessScope {
    Client,
    Daemon,
    Server,
    Browser,
}

impl ConfigProcessScope {
    pub fn as_str(self) -> &'static str {
        match self {
            ConfigProcessScope::Client => "client",
            ConfigProcessScope::Daemon => "daemon",
            ConfigProcessScope::Server => "server",
            ConfigProcessScope::Browser => "browser",
        }
    }
}

/// The primitive type of a config setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigType {
    Number,
    String,
    Boolean,
}

impl ConfigType {
    pub fn as_str(self) -> &'static str {
        match self {
            ConfigType::Number => "number",
            ConfigType::String => "string",
            ConfigType::Boolean => "boolean",
        }
    }
}

/// A validator: `(path, coerced_value) -> Result<(), message>`.
pub type ValidateFn = fn(&str, &Value) -> Result<(), String>;

/// A single config setting descriptor. Mirrors the TS `ConfigSetting`.
#[derive(Clone)]
pub struct ConfigSetting {
    pub path: String,
    pub kind: ConfigType,
    pub default_value: Option<Value>,
    pub purpose: String,
    pub scope: Vec<ConfigProcessScope>,
    pub sensitive: bool,
    pub global_only: bool,
    pub internal: bool,
    pub accept_input: bool,
    pub validate: Option<ValidateFn>,
}

impl ConfigSetting {
    fn new(path: &str, kind: ConfigType, purpose: &str, scope: Vec<ConfigProcessScope>) -> Self {
        ConfigSetting {
            path: path.to_string(),
            kind,
            default_value: None,
            purpose: purpose.to_string(),
            scope,
            sensitive: false,
            global_only: false,
            internal: false,
            accept_input: false,
            validate: None,
        }
    }
    fn default(mut self, value: Value) -> Self {
        self.default_value = Some(value);
        self
    }
    fn sensitive(mut self) -> Self {
        self.sensitive = true;
        self
    }
    fn global_only(mut self) -> Self {
        self.global_only = true;
        self
    }
    fn internal(mut self) -> Self {
        self.internal = true;
        self
    }
    fn accept_input(mut self) -> Self {
        self.accept_input = true;
        self
    }
    fn with_validate(mut self, f: ValidateFn) -> Self {
        self.validate = Some(f);
        self
    }
}

fn is_int(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

fn v_detach_prefix(_p: &str, v: &Value) -> Result<(), String> {
    match v.as_f64() {
        Some(n) if is_int(n) && (0.0..=255.0).contains(&n) => Ok(()),
        _ => Err("terminal.detachPrefix must be an integer between 0 and 255".into()),
    }
}

fn v_focus_top_session(_p: &str, v: &Value) -> Result<(), String> {
    let s = v
        .as_str()
        .ok_or("hotKeys.focusTopSession must be a string")?;
    if s.is_empty() {
        return Ok(());
    }
    match parse_shortcut_key(s) {
        Some(key) if !key.chars().any(char::is_whitespace) => Ok(()),
        _ => Err(
            "hotKeys.focusTopSession must be empty or a shortcut like \"Alt+T\" or \"Ctrl+Shift+J\""
                .into(),
        ),
    }
}

/// Mirrors the TS `parseShortcut`: returns the lowercased non-modifier key when
/// `input` is a valid `Mod+...+Key` shortcut (exactly one non-modifier token),
/// else `None`.
fn parse_shortcut_key(input: &str) -> Option<String> {
    let tokens: Vec<&str> = input
        .split('+')
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let mut key: Option<String> = None;
    for token in tokens {
        match token.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "alt" | "option" | "shift" | "meta" | "cmd" | "command" => {}
            _ => {
                if key.is_some() {
                    return None; // more than one non-modifier key
                }
                key = Some(token.to_ascii_lowercase());
            }
        }
    }
    key
}

fn v_remote_port(_p: &str, v: &Value) -> Result<(), String> {
    match v.as_f64() {
        Some(n) if is_int(n) && n > 0.0 && n <= 65535.0 => Ok(()),
        _ => Err("remote.port must be a positive integer between 1 and 65535".into()),
    }
}

fn v_ingest_retries(_p: &str, v: &Value) -> Result<(), String> {
    match v.as_f64() {
        Some(n) if is_int(n) && n >= 1.0 => Ok(()),
        _ => Err("remote.ingestPortRetryAttempts must be a positive integer (>= 1)".into()),
    }
}

fn v_remote_keepalive(_p: &str, v: &Value) -> Result<(), String> {
    match v.as_f64() {
        Some(n) if is_int(n) && n >= 0.0 => Ok(()),
        _ => Err("remote.keepAlive must be a non-negative integer (seconds)".into()),
    }
}

fn v_client_id(_p: &str, v: &Value) -> Result<(), String> {
    let ok = matches!(v.as_str(), Some(s)
        if (1..=64).contains(&s.chars().count())
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'));
    if ok {
        Ok(())
    } else {
        Err("remote.clientId must be 1–64 characters using only letters, digits, dots, hyphens, or underscores.".into())
    }
}

fn v_session_color(_p: &str, v: &Value) -> Result<(), String> {
    let s = match v.as_str() {
        Some(s) => s,
        None => return Err("session.color must be a string".into()),
    };
    let valid = [
        "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "none", "auto",
    ];
    if valid.contains(&s) {
        Ok(())
    } else {
        Err(format!(
            "session.color must be one of: {}",
            valid.join(", ")
        ))
    }
}

fn v_session_priority(_p: &str, v: &Value) -> Result<(), String> {
    match v.as_f64() {
        Some(n) if is_int(n) && (0.0..=1000.0).contains(&n) => Ok(()),
        _ => Err("session.priority must be an integer between 0 and 1000".into()),
    }
}

fn v_tunnel_keepalive(_p: &str, v: &Value) -> Result<(), String> {
    match v.as_f64() {
        Some(n) if n.is_finite() && n >= 0.0 => Ok(()),
        _ => Err("tunnelLink.keepAlive must be a non-negative number".into()),
    }
}

fn v_logging_level(_p: &str, v: &Value) -> Result<(), String> {
    let levels = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
    match v.as_str() {
        Some(s) if levels.contains(&s) => Ok(()),
        _ => Err(format!(
            "logging.level must be one of: {}",
            levels.join(", ")
        )),
    }
}

fn v_feature(path: &str, v: &Value) -> Result<(), String> {
    match v.as_str() {
        Some("enabled") | Some("disabled") => Ok(()),
        _ => Err(format!("{path} must be \"enabled\" or \"disabled\"")),
    }
}

fn feature_config_settings() -> Vec<ConfigSetting> {
    use ConfigProcessScope::*;
    FEATURE_FLAGS
        .iter()
        .map(|flag| {
            let override_note = match flag.override_value {
                Some(o) => format!(" Overridden to \"{o}\" by this build; config has no effect."),
                None => String::new(),
            };
            let purpose = format!(
                "{} Set to \"enabled\" or \"disabled\". [status: {}]{}",
                flag.description,
                flag.status.as_str(),
                override_note
            );
            ConfigSetting::new(
                &format!("feature.{}", flag.name),
                ConfigType::String,
                &purpose,
                vec![Client, Daemon, Server, Browser],
            )
            .default(Value::String(flag.default.to_string()))
            .accept_input()
            .with_validate(v_feature)
        })
        .collect()
}

/// Builds the full, ordered config settings registry. Mirrors `CONFIG_SETTINGS`.
pub fn config_settings() -> Vec<ConfigSetting> {
    use ConfigProcessScope::*;
    use ConfigType::*;
    let mut s: Vec<ConfigSetting> = vec![
        ConfigSetting::new(
            "version",
            Number,
            "Schema version for the persisted config file format. Always 1 for the current release.",
            vec![Client, Daemon, Server],
        )
        .default(Value::from(CONFIG_VERSION))
        .internal(),
        ConfigSetting::new(
            "server.host",
            String,
            "IP address the dashboard server binds to. Defaults to loopback for local-only access.",
            vec![Server],
        )
        .default(Value::from("127.0.0.1")),
        ConfigSetting::new(
            "server.port",
            Number,
            "TCP port the dashboard server listens on. Change if 3131 conflicts with another service.",
            vec![Server],
        )
        .default(Value::from(3131)),
        ConfigSetting::new(
            "terminal.clampBrowserToHost",
            Boolean,
            "When false (default), a browser viewer may grow the shared PTY beyond the host terminal's dimensions. Set true to clamp viewer size to the host terminal to prevent content mangling.",
            vec![Daemon],
        )
        .default(Value::from(false)),
        ConfigSetting::new(
            "terminal.detachPrefix",
            Number,
            "Byte value of the detach key prefix (default 0x1c = Ctrl-\\). Press prefix then 'd' to detach without stopping the command. Must be an integer in [0, 255].",
            vec![Client],
        )
        .default(Value::from(DEFAULT_DETACH_PREFIX))
        .with_validate(v_detach_prefix),
        ConfigSetting::new(
            "hotKeys.focusTopSession",
            String,
            "Web dashboard shortcut that selects the top session in the list and focuses its terminal. Format is \"Mod+...+Key\" (e.g. \"Alt+T\", \"Ctrl+Shift+J\"). Set to an empty string to disable.",
            vec![Server, Browser],
        )
        .default(Value::from("Alt+J"))
        .accept_input()
        .with_validate(v_focus_top_session),
        ConfigSetting::new(
            "dashboard.theme",
            String,
            "Default web dashboard terminal colour theme (by display name, e.g. \"Dracula\"). Sessions without their own theme inherit this. Choose from the dashboard \"Default theme\" picker; defaults to \"Default\".",
            vec![Server, Browser],
        )
        .default(Value::from("Default"))
        .accept_input(),
        ConfigSetting::new(
            "dashboard.keyBarPinned",
            Boolean,
            "Whether the web dashboard key bar is pinned open.",
            vec![Server, Browser],
        )
        .default(Value::from(true))
        .accept_input(),
        ConfigSetting::new(
            "dashboard.stateIconNoMotion",
            Boolean,
            "When true, the web dashboard freezes the animated terminal-progress indicator (OSC 9;4 indeterminate spinner) into a static icon, honouring reduced-motion preferences. Defaults to false (animated).",
            vec![Server, Browser],
        )
        .default(Value::from(false))
        .accept_input(),
        ConfigSetting::new(
            "attention.idleSeconds",
            Number,
            "Number of seconds the rendered terminal grid must remain unchanged before the session is flagged as needing attention. Set to 0 or negative to disable static-screen detection.",
            vec![Daemon],
        )
        .default(Value::from(10)),
        ConfigSetting::new(
            "remote.enabled",
            Boolean,
            "Enables remote uplink so the local devbox forwards session metadata and I/O to a remote dashboard over a dev tunnel or direct connection.",
            vec![Client],
        )
        .accept_input()
        .global_only(),
        ConfigSetting::new(
            "remote.host",
            String,
            "Direct remote uplink host for same-machine or LAN setups. Takes precedence over dev tunnel forwarding when set.",
            vec![Client],
        )
        .accept_input()
        .global_only(),
        ConfigSetting::new(
            "remote.ingestHost",
            String,
            "Host address where the dashboard-side ingest daemon should listen for incoming remote session connections.",
            vec![Client],
        )
        .accept_input()
        .global_only(),
        ConfigSetting::new(
            "remote.tunnelId",
            String,
            "Dev tunnel id (e.g. \"happy-tree-abc123\") used by `devtunnel connect` to forward local climon traffic to a remote dashboard.",
            vec![Client],
        )
        .accept_input()
        .global_only(),
        ConfigSetting::new(
            "remote.discover",
            Boolean,
            "When true (default), an enabled devbox (remote.enabled) auto-discovers live climon dashboard hosts by scanning your dev tunnels for the climon-ingest label and uplinks to all of them, in addition to any explicit remote.tunnelId/remote.host. Set false to disable discovery and only use explicitly configured targets.",
            vec![Client],
        )
        .default(Value::from(true))
        .accept_input()
        .global_only(),
        ConfigSetting::new(
            "remote.dashboardTunnelId",
            String,
            "Server-owned persisted dashboard tunnel id used to reuse tunnel identity for tunnel link sessions.",
            vec![Server],
        )
        .internal()
        .global_only(),
        ConfigSetting::new(
            "remote.dashboardTunnelCluster",
            String,
            "Server-owned persisted dashboard tunnel cluster used to reuse tunnel identity for tunnel link sessions.",
            vec![Server],
        )
        .internal()
        .global_only(),
        ConfigSetting::new(
            "remote.dashboardTunnelEnabled",
            Boolean,
            "Server-owned flag recording whether the Tunnel Link is enabled, so the server re-establishes the dashboard tunnel automatically on startup.",
            vec![Server],
        )
        .internal()
        .global_only(),
        ConfigSetting::new(
            "remote.port",
            Number,
            "Local port the devbox forwards and the ingest daemon listens on. Defaults to server.port if not explicitly set.",
            vec![Client],
        )
        .accept_input()
        .global_only()
        .with_validate(v_remote_port),
        ConfigSetting::new(
            "remote.ingestPortRetryAttempts",
            Number,
            "How many consecutive ports the ingest daemon will try, starting at its preferred port, before giving up. Raise it if many ports near the default are already in use.",
            vec![Server],
        )
        .default(Value::from(100))
        .global_only()
        .with_validate(v_ingest_retries),
        ConfigSetting::new(
            "remote.clientId",
            String,
            "Stable, non-secret client namespace identifying this machine's sessions. Defaults to the machine hostname when unset; set it to a value that is unique per host to avoid session ID collisions across machines.",
            vec![Client],
        )
        .accept_input()
        .global_only()
        .with_validate(v_client_id),
        ConfigSetting::new(
            "remote.spawnSecret",
            String,
            "Shared HMAC secret authenticating dashboard→devbox spawn commands. Generated automatically on the dashboard host when feature.remoteSpawn is enabled, and planted on the devbox by the remotes-screen setup script. Keep it secret.",
            vec![Client, Server],
        )
        .accept_input()
        .sensitive()
        .global_only(),
        ConfigSetting::new(
            "remote.keepAlive",
            Number,
            "Interval in seconds between mux keepalive pings sent over the remote uplink/ingest connection. Prevents dev tunnel idle timeouts from dropping the connection. Set to 0 to disable.",
            vec![Client],
        )
        .default(Value::from(60))
        .accept_input()
        .global_only()
        .with_validate(v_remote_keepalive),
        ConfigSetting::new(
            "remote.peerHome",
            String,
            "Path to the peer OS's CLIMON_HOME for same-machine WSL<->Windows discovery (e.g. /mnt/c/Users/<you>/.climon from WSL, or \\\\wsl.localhost\\<distro>\\home\\<you>\\.climon from Windows). When feature.wslBridge is enabled, climon reads the peer's beacons and wires sessions to it. Usually set automatically by `climon link`.",
            vec![Client, Server],
        )
        .accept_input()
        .global_only(),
        ConfigSetting::new(
            "remote.peerHost",
            String,
            "Optional host override used to reach the peer dashboard/ingest. Leave unset to auto-detect (localhost, or the WSL gateway IP under NAT networking).",
            vec![Client, Server],
        )
        .accept_input()
        .global_only(),
        ConfigSetting::new(
            "remote.autoLink",
            Boolean,
            "When true (default), the first `climon` run inside WSL attempts to auto-link to a Windows-side climon by detecting its CLIMON_HOME and setting remote.peerHome on both sides. Auto-link configures discovery only; it never enables feature.wslBridge. Set false to disable auto-linking.",
            vec![Client],
        )
        .default(Value::from(true))
        .accept_input()
        .global_only(),
        ConfigSetting::new(
            "session.color",
            String,
            "Specifies the default accent color for new sessions. Accepts ANSI color names (red, green, etc.), 'none', or 'auto' for automatic assignment.",
            vec![Client, Daemon, Server],
        )
        .default(Value::from("auto"))
        .accept_input()
        .with_validate(v_session_color),
        ConfigSetting::new(
            "session.priority",
            Number,
            "Default sort priority (0-1000) for new sessions. Lower numbers sort first within each status group.",
            vec![Client, Daemon, Server],
        )
        .default(Value::from(DEFAULT_PRIORITY))
        .accept_input()
        .with_validate(v_session_priority),
        ConfigSetting::new(
            "session.terminalProgram",
            String,
            "Command template used to open a terminal window for a non-headless (visible) session spawned from the dashboard. Use the {cmd} placeholder for the climon command to run. When unset, climon auto-detects a terminal per OS (Terminal.app, Windows Terminal, or x-terminal-emulator/gnome-terminal/konsole/xterm).",
            vec![Client],
        )
        .accept_input()
        .global_only(),
        ConfigSetting::new(
            "tunnelLink.keepAlive",
            Number,
            "Interval in seconds between keep-alive pings sent through the Tunnel Link dev tunnel relay to prevent idle disconnection. Set to 0 to disable keep-alive pings.",
            vec![Server],
        )
        .default(Value::from(60))
        .accept_input()
        .with_validate(v_tunnel_keepalive),
        ConfigSetting::new(
            "logging.level",
            String,
            "Minimum log level emitted by climon processes. One of: trace, debug, info, warn, error, fatal, silent. Defaults to trace (everything). Set to silent to disable logging. Overridden per-invocation by the CLIMON_LOG_LEVEL environment variable.",
            vec![Client, Daemon, Server],
        )
        .default(Value::from("trace"))
        .accept_input()
        .with_validate(v_logging_level),
    ];
    s.extend(feature_config_settings());
    s.extend(vec![
        ConfigSetting::new(
            "telemetry.enabled",
            Boolean,
            "When true, climon sends anonymous, opt-in usage telemetry keyed only by a random install id (no PII, session output, commands, paths, or hostnames). Off by default.",
            vec![Client, Server],
        )
        .default(Value::from(false))
        .accept_input(),
        ConfigSetting::new(
            "update.auto",
            Boolean,
            "When true, climon downloads and applies signed updates automatically in the background. When false (default), it only prints a one-line banner suggesting `climon --update`.",
            vec![Client],
        )
        .default(Value::from(false))
        .accept_input()
        .global_only(),
        ConfigSetting::new(
            "update.lastCheck",
            String,
            "ISO-8601 timestamp of the last background update check. Used to throttle checks.",
            vec![Client],
        )
        .internal()
        .global_only(),
        ConfigSetting::new(
            "update.availableVersion",
            String,
            "Latest version discovered by the background update check, if newer than the installed version. Cleared after a successful update.",
            vec![Client],
        )
        .internal()
        .global_only(),
        ConfigSetting::new(
            "license.noticeShown",
            Boolean,
            "Whether the one-time MIT license-change notice has been shown. Set automatically the first time an install that upgraded from a pre-open-source (EULA-gated) build launches; never shown on fresh installs.",
            vec![Client],
        )
        .internal()
        .global_only(),
        ConfigSetting::new(
            "install.id",
            String,
            "Anonymous, randomly generated install identifier used only when telemetry is enabled. Contains no personal information.",
            vec![Client, Server],
        )
        .internal(),
    ]);
    s
}

/// Keys users can set via `climon config set` (accept_input only).
pub fn accepted_config_keys() -> Vec<String> {
    config_settings()
        .into_iter()
        .filter(|s| s.accept_input)
        .map(|s| s.path)
        .collect()
}

/// All config keys including internal and default-only keys.
pub fn all_config_keys() -> Vec<String> {
    config_settings().into_iter().map(|s| s.path).collect()
}

/// Finds the registry entry for a given config path.
pub fn find_config_setting(path: &str) -> Option<ConfigSetting> {
    config_settings().into_iter().find(|s| s.path == path)
}

/// Builds the default config object from registry defaults.
pub fn build_default_config_from_settings() -> Value {
    let mut config = serde_json::Map::new();
    for setting in config_settings() {
        let default = match setting.default_value {
            Some(v) => v,
            None => continue,
        };
        let parts: Vec<&str> = setting.path.split('.').collect();
        let mut current = &mut config;
        for key in &parts[..parts.len() - 1] {
            current = current
                .entry((*key).to_string())
                .or_insert_with(|| Value::Object(serde_json::Map::new()))
                .as_object_mut()
                .expect("intermediate config node is an object");
        }
        current.insert(parts[parts.len() - 1].to_string(), default);
    }
    Value::Object(config)
}

/// Parses a string like JS `Number()` for the subset climon config relies on:
/// trim, empty -> 0, decimal/scientific, hex/octal/binary literals, Infinity.
/// (Matches `climon-proto::parse_priority`'s simplification.)
fn js_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    match t {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    let (sign, body) = match t.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, t.strip_prefix('+').unwrap_or(t)),
    };
    for (prefix, radix) in [
        ("0x", 16u32),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = body.strip_prefix(prefix) {
            return i64::from_str_radix(digits, radix)
                .ok()
                .map(|n| sign * n as f64);
        }
    }
    t.parse::<f64>().ok()
}

fn number_value(n: f64) -> Value {
    if is_int(n) && n >= i64::MIN as f64 && n <= i64::MAX as f64 {
        Value::from(n as i64)
    } else {
        Value::from(n)
    }
}

/// Coerces a string input value and validates it per the registry entry.
pub fn coerce_config_value_from_settings(path: &str, value: &str) -> Result<Value, String> {
    let setting = find_config_setting(path).ok_or_else(|| format!("Unknown config key: {path}"))?;
    let coerced = match setting.kind {
        ConfigType::Boolean => match value {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            _ => return Err(format!("Value for '{path}' must be 'true' or 'false'.")),
        },
        ConfigType::Number => match js_number(value) {
            Some(n) => number_value(n),
            None => return Err(format!("{path} must be a valid number")),
        },
        ConfigType::String => Value::String(value.to_string()),
    };
    if let Some(validate) = setting.validate {
        validate(path, &coerced)?;
    }
    Ok(coerced)
}

fn display_default(v: &Value) -> String {
    match v {
        Value::Bool(b) => b.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Renders a Markdown table of all config settings. Mirrors `renderConfigSettingsTable`.
pub fn render_config_settings_table() -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push("| Path | Type | Default | Scope | Description |".to_string());
    lines.push("|------|------|---------|-------|-------------|".to_string());
    for setting in config_settings() {
        let path = format!("`{}`", setting.path);
        let type_str = setting.kind.as_str();
        let default_val = match &setting.default_value {
            Some(v) => format!("`{}`", display_default(v)),
            None => "unset".to_string(),
        };
        let scope = setting
            .scope
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let mut purpose = setting.purpose.clone();
        let mut markers: Vec<&str> = Vec::new();
        if setting.sensitive {
            markers.push("**sensitive**");
        }
        if setting.internal {
            markers.push("**internal**");
        }
        if !markers.is_empty() {
            purpose = format!("{purpose} ({})", markers.join(", "));
        }
        lines.push(format!(
            "| {path} | {type_str} | {default_val} | {scope} | {purpose} |"
        ));
    }
    lines.join("\n")
}

fn format_default_value(setting: &ConfigSetting) -> String {
    match &setting.default_value {
        Some(v) => display_default(v),
        None => "unset".to_string(),
    }
}

fn wrap_text(text: &str, indent: &str, max_width: usize) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut lines: Vec<String> = Vec::new();
    let mut line = indent.to_string();
    let indent_len = indent.chars().count();
    let content_width = max_width - indent_len;
    let len = |s: &str| s.chars().count();
    for word in words {
        if len(word) > content_width {
            if line != indent {
                lines.push(line.clone());
                line = indent.to_string();
            }
            let chars: Vec<char> = word.chars().collect();
            let mut idx = 0;
            while idx < chars.len() {
                let end = (idx + content_width).min(chars.len());
                lines.push(format!(
                    "{indent}{}",
                    chars[idx..end].iter().collect::<String>()
                ));
                idx += content_width;
            }
            continue;
        }
        let separator = if line == indent { "" } else { " " };
        if len(&line) + separator.len() + len(word) > max_width && line != indent {
            lines.push(line.clone());
            line = format!("{indent}{word}");
        } else {
            line = format!("{line}{separator}{word}");
        }
    }
    if line != indent {
        lines.push(line);
    }
    lines
}

/// Renders config settings for terminal help output. Mirrors `renderConfigSettingsHelp`.
pub fn render_config_settings_help() -> String {
    let mut lines: Vec<String> = Vec::new();
    for setting in config_settings() {
        let mut metadata = vec![
            format!("Type: {}", setting.kind.as_str()),
            format!("Default: {}", format_default_value(&setting)),
            format!(
                "Scope: {}",
                setting
                    .scope
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ];
        if setting.sensitive {
            metadata.push("sensitive".to_string());
        }
        if setting.internal {
            metadata.push("internal".to_string());
        }
        lines.push(format!("  {}", setting.path));
        lines.push(format!("    {}", metadata.join("; ")));
        lines.extend(wrap_text(&setting.purpose, "    ", TERMINAL_HELP_WIDTH));
        lines.push(String::new());
    }
    lines.join("\n").trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn declares_every_path_in_order() {
        let paths: Vec<String> = config_settings().into_iter().map(|s| s.path).collect();
        assert_eq!(
            paths,
            vec![
                "version",
                "server.host",
                "server.port",
                "terminal.clampBrowserToHost",
                "terminal.detachPrefix",
                "hotKeys.focusTopSession",
                "dashboard.theme",
                "dashboard.keyBarPinned",
                "dashboard.stateIconNoMotion",
                "attention.idleSeconds",
                "remote.enabled",
                "remote.host",
                "remote.ingestHost",
                "remote.tunnelId",
                "remote.discover",
                "remote.dashboardTunnelId",
                "remote.dashboardTunnelCluster",
                "remote.dashboardTunnelEnabled",
                "remote.port",
                "remote.ingestPortRetryAttempts",
                "remote.clientId",
                "remote.spawnSecret",
                "remote.keepAlive",
                "remote.peerHome",
                "remote.peerHost",
                "remote.autoLink",
                "session.color",
                "session.priority",
                "session.terminalProgram",
                "tunnelLink.keepAlive",
                "logging.level",
                "feature.sessionSpawning",
                "feature.remoteSpawn",
                "feature.wslBridge",
                "feature.remotes",
                "feature.smartNotifications",
                "telemetry.enabled",
                "update.auto",
                "update.lastCheck",
                "update.availableVersion",
                "license.noticeShown",
                "install.id",
            ]
        );
        for s in config_settings() {
            assert!(s.purpose.len() > 20);
            assert!(!s.scope.is_empty());
        }
        assert_eq!(all_config_keys().len(), 42);
    }

    #[test]
    fn session_color_scope() {
        let scope = find_config_setting("session.color").unwrap().scope;
        assert_eq!(
            scope,
            vec![
                ConfigProcessScope::Client,
                ConfigProcessScope::Daemon,
                ConfigProcessScope::Server
            ]
        );
    }

    #[test]
    fn builds_default_config() {
        assert_eq!(
            build_default_config_from_settings(),
            json!({
                "version": 1,
                "server": { "host": "127.0.0.1", "port": 3131 },
                "terminal": { "clampBrowserToHost": false, "detachPrefix": 28 },
                "hotKeys": { "focusTopSession": "Alt+J" },
                "dashboard": { "theme": "Default", "keyBarPinned": true, "stateIconNoMotion": false },
                "attention": { "idleSeconds": 10 },
                "remote": { "discover": true, "ingestPortRetryAttempts": 100, "keepAlive": 60, "autoLink": true },
                "session": { "color": "auto", "priority": 500 },
                "tunnelLink": { "keepAlive": 60 },
                "logging": { "level": "trace" },
                "feature": {
                    "sessionSpawning": "disabled",
                    "remoteSpawn": "disabled",
                    "wslBridge": "disabled",
                    "remotes": "disabled",
                    "smartNotifications": "disabled"
                },
                "telemetry": { "enabled": false },
                "update": { "auto": false }
            })
        );
    }

    #[test]
    fn internal_and_input_flags() {
        assert!(find_config_setting("version").unwrap().internal);
        let client = find_config_setting("remote.clientId").unwrap();
        assert!(!client.internal);
        assert!(client.accept_input);
        let tid = find_config_setting("remote.dashboardTunnelId").unwrap();
        assert!(tid.internal);
        assert!(!tid.accept_input);
        assert_eq!(tid.kind, ConfigType::String);
    }

    #[test]
    fn remote_spawn_secret_is_sensitive_string_client_and_server() {
        let s = find_config_setting("remote.spawnSecret").expect("setting exists");
        assert_eq!(s.kind, ConfigType::String);
        assert!(s.sensitive);
        assert!(s.accept_input);
        assert!(s.scope.contains(&ConfigProcessScope::Client));
        assert!(s.scope.contains(&ConfigProcessScope::Server));
    }

    #[test]
    fn remote_discover_is_boolean_client_setting() {
        let s = find_config_setting("remote.discover").expect("setting exists");
        assert_eq!(s.kind, ConfigType::Boolean);
        assert_eq!(s.default_value, Some(Value::from(true)));
        assert!(s.accept_input);
        assert!(s.global_only);
        assert_eq!(s.scope, vec![ConfigProcessScope::Client]);
    }

    #[test]
    fn accepted_keys_exclude_internal_and_default_only() {
        assert_eq!(
            accepted_config_keys(),
            vec![
                "hotKeys.focusTopSession",
                "dashboard.theme",
                "dashboard.keyBarPinned",
                "dashboard.stateIconNoMotion",
                "remote.enabled",
                "remote.host",
                "remote.ingestHost",
                "remote.tunnelId",
                "remote.discover",
                "remote.port",
                "remote.clientId",
                "remote.spawnSecret",
                "remote.keepAlive",
                "remote.peerHome",
                "remote.peerHost",
                "remote.autoLink",
                "session.color",
                "session.priority",
                "session.terminalProgram",
                "tunnelLink.keepAlive",
                "logging.level",
                "feature.sessionSpawning",
                "feature.remoteSpawn",
                "feature.wslBridge",
                "feature.remotes",
                "feature.smartNotifications",
                "telemetry.enabled",
                "update.auto",
            ]
        );
    }

    #[test]
    fn coerces_through_validators() {
        assert_eq!(
            coerce_config_value_from_settings("remote.enabled", "true").unwrap(),
            json!(true)
        );
        assert_eq!(
            coerce_config_value_from_settings("remote.enabled", "false").unwrap(),
            json!(false)
        );
        assert_eq!(
            coerce_config_value_from_settings("remote.port", "3132").unwrap(),
            json!(3132)
        );
        assert_eq!(
            coerce_config_value_from_settings("session.color", "green").unwrap(),
            json!("green")
        );
        assert_eq!(
            coerce_config_value_from_settings("hotKeys.focusTopSession", "Ctrl+Shift+J").unwrap(),
            json!("Ctrl+Shift+J")
        );
        assert_eq!(
            coerce_config_value_from_settings("hotKeys.focusTopSession", "").unwrap(),
            json!("")
        );
        assert!(
            coerce_config_value_from_settings("hotKeys.focusTopSession", "Ctrl+J+K")
                .unwrap_err()
                .contains("must be empty or a shortcut")
        );
        assert!(
            coerce_config_value_from_settings("session.priority", "1001")
                .unwrap_err()
                .contains("between 0 and 1000")
        );
        assert!(coerce_config_value_from_settings("remote.port", "0")
            .unwrap_err()
            .contains("positive integer"));
    }

    #[test]
    fn focus_top_session_validation() {
        let setting = find_config_setting("hotKeys.focusTopSession").unwrap();
        let validate = setting.validate.expect("validator present");
        assert!(validate("hotKeys.focusTopSession", &Value::from("")).is_ok());
        assert!(validate("hotKeys.focusTopSession", &Value::from("Alt+T")).is_ok());
        assert!(validate("hotKeys.focusTopSession", &Value::from("Ctrl+Shift+J")).is_ok());
        // No non-modifier key.
        assert!(validate("hotKeys.focusTopSession", &Value::from("Alt+Ctrl")).is_err());
        // Key token contains internal whitespace (matches Bun's /\s/ rejection).
        assert!(validate("hotKeys.focusTopSession", &Value::from("Hyper Nonsense")).is_err());
        assert!(validate("hotKeys.focusTopSession", &Value::from("Alt+Page Down")).is_err());
        // Non-string.
        assert!(validate("hotKeys.focusTopSession", &Value::from(42)).is_err());
    }

    #[test]
    fn boolean_coercion_rejects_others() {
        for bad in ["1", "0", "yes"] {
            assert!(coerce_config_value_from_settings("remote.enabled", bad)
                .unwrap_err()
                .contains("must be 'true' or 'false'"));
        }
    }

    #[test]
    fn detach_prefix_range() {
        assert_eq!(
            coerce_config_value_from_settings("terminal.detachPrefix", "28").unwrap(),
            json!(28)
        );
        assert!(
            coerce_config_value_from_settings("terminal.detachPrefix", "256")
                .unwrap_err()
                .contains("between 0 and 255")
        );
        assert!(
            coerce_config_value_from_settings("terminal.detachPrefix", "-1")
                .unwrap_err()
                .contains("between 0 and 255")
        );
    }

    #[test]
    fn rejects_unknown_keys_and_non_integers() {
        assert!(coerce_config_value_from_settings("unknown.key", "value")
            .unwrap_err()
            .contains("Unknown config key"));
        assert!(coerce_config_value_from_settings("remote.port", "12.5").is_err());
        assert!(
            coerce_config_value_from_settings("remote.ingestPortRetryAttempts", "1.5").is_err()
        );
        assert_eq!(
            coerce_config_value_from_settings("remote.ingestPortRetryAttempts", "100").unwrap(),
            json!(100)
        );
    }

    #[test]
    fn logging_level_validation() {
        assert_eq!(
            coerce_config_value_from_settings("logging.level", "debug").unwrap(),
            json!("debug")
        );
        assert_eq!(
            coerce_config_value_from_settings("logging.level", "silent").unwrap(),
            json!("silent")
        );
        assert!(coerce_config_value_from_settings("logging.level", "loud").is_err());
    }

    #[test]
    fn ingest_retries_defaults_and_scope() {
        let s = find_config_setting("remote.ingestPortRetryAttempts").unwrap();
        assert_eq!(s.kind, ConfigType::Number);
        assert_eq!(s.default_value, Some(json!(100)));
        assert_eq!(s.scope, vec![ConfigProcessScope::Server]);
    }

    #[test]
    fn renders_table_and_help() {
        let table = render_config_settings_table();
        assert!(table.contains("| `session.color` | string | `auto` | client, daemon, server | Specifies the default accent color"));
        assert!(table.contains("internal"));
    }

    #[test]
    fn help_wraps_long_tokens() {
        // Build a registry-like help with an overlong token and assert no 'x' line exceeds 88.
        let long = format!("Prefix {} suffix", "x".repeat(120));
        let wrapped = wrap_text(&long, "    ", TERMINAL_HELP_WIDTH);
        let overwide: Vec<&String> = wrapped
            .iter()
            .filter(|l| l.trim_start().starts_with('x'))
            .filter(|l| l.chars().count() > 88)
            .collect();
        assert!(overwide.is_empty());
    }

    #[test]
    fn installer_settings() {
        assert_eq!(
            find_config_setting("telemetry.enabled")
                .unwrap()
                .default_value,
            Some(json!(false))
        );
        assert!(accepted_config_keys().contains(&"telemetry.enabled".to_string()));
        assert_eq!(
            find_config_setting("update.auto").unwrap().default_value,
            Some(json!(false))
        );
        assert!(find_config_setting("update.lastCheck").unwrap().internal);
        assert!(
            find_config_setting("update.availableVersion")
                .unwrap()
                .internal
        );
        assert!(find_config_setting("install.id").unwrap().internal);
    }

    #[test]
    fn logging_appinsights_connection_string_is_not_a_setting() {
        // The App Insights connection string is a secret and must not live in
        // climon config; it comes from the APPLICATIONINSIGHTS_CONNECTION_STRING
        // environment variable or the build-time embedded constant instead.
        assert!(find_config_setting("logging.appInsights.connectionString").is_none());
        let cfg = build_default_config_from_settings();
        assert_eq!(cfg["logging"]["level"], json!("trace"));
    }
}
