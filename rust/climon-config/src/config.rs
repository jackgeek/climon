//! Config paths, cascade resolution, load/save, sparse writes. 1:1 port of `src/config.ts`.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use climon_proto::session_meta::{parse_color_mode, ColorMode};
use serde_json::{json, Map, Value};

use crate::config_settings::{
    build_default_config_from_settings, coerce_config_value_from_settings, find_config_setting,
};
use crate::jsonc::{parse_jsonc_config, render_jsonc_config};

/// Default detach-key prefix byte (`Ctrl-\`).
pub const DEFAULT_DETACH_PREFIX: i64 = 0x1c;

/// Environment variable signalling we are inside a monitored PTY.
pub const SESSION_ENV_VAR: &str = "CLIMON_SESSION_ID";
/// Environment variable tracking session nesting depth.
pub const NEST_LEVEL_ENV_VAR: &str = "CLIMON_NEST_LEVEL";

const CONFIG_BASENAME: &str = "config.jsonc";
const LEGACY_CONFIG_BASENAME: &str = "config.json";
const LEGACY_CONFIG_BACKUP_BASENAME: &str = "config.json.bak";

/// Abstraction over process environment + home dir, mirroring the TS `env`/`homedir()` inputs.
#[derive(Debug, Clone)]
pub struct Env {
    climon_home: Option<String>,
    home: PathBuf,
}

impl Env {
    /// Builds an `Env` from an explicit `CLIMON_HOME` and home directory (for tests).
    pub fn new(climon_home: Option<&str>, home: impl Into<PathBuf>) -> Self {
        Env {
            climon_home: climon_home.map(|s| s.to_string()),
            home: home.into(),
        }
    }

    /// Builds an `Env` from the real process environment.
    pub fn real() -> Self {
        let home = std::env::var("HOME")
            .ok()
            .or_else(|| std::env::var("USERPROFILE").ok())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        Env {
            climon_home: std::env::var("CLIMON_HOME").ok(),
            home,
        }
    }

    fn home(&self) -> &Path {
        &self.home
    }
}

/// The scope a config write targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteScope {
    Auto,
    Local,
    Global,
}

/// Normalises a path to absolute + lexically-cleaned form (no symlink resolution),
/// matching Node's `path.resolve`.
fn resolve(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(p)
    };
    let mut out = PathBuf::new();
    for comp in abs.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `$CLIMON_HOME` or `<home>/.climon`.
pub fn get_climon_home(env: &Env) -> PathBuf {
    match &env.climon_home {
        Some(h) => PathBuf::from(h),
        None => env.home().join(".climon"),
    }
}

/// Path to the canonical config file (`config.jsonc`) under `$CLIMON_HOME`.
pub fn get_config_path(env: &Env) -> PathBuf {
    get_climon_home(env).join(CONFIG_BASENAME)
}

fn config_path_for_dir(dir: &Path) -> PathBuf {
    dir.join(CONFIG_BASENAME)
}

fn legacy_config_path_for_dir(dir: &Path) -> PathBuf {
    dir.join(LEGACY_CONFIG_BASENAME)
}

fn legacy_backup_path_for_dir(dir: &Path) -> PathBuf {
    dir.join(LEGACY_CONFIG_BACKUP_BASENAME)
}

/// Existing config path for a dir: prefer canonical, fall back to legacy.
fn existing_config_path_for_dir(dir: &Path) -> Option<PathBuf> {
    let canonical = config_path_for_dir(dir);
    if canonical.exists() {
        return Some(canonical);
    }
    let legacy = legacy_config_path_for_dir(dir);
    if legacy.exists() {
        return Some(legacy);
    }
    None
}

/// `$CLIMON_HOME/sessions`.
pub fn get_sessions_dir(env: &Env) -> PathBuf {
    get_climon_home(env).join("sessions")
}

/// `$CLIMON_HOME/logs`.
pub fn get_logs_dir(env: &Env) -> PathBuf {
    get_climon_home(env).join("logs")
}

/// `$CLIMON_HOME/sock`.
pub fn get_socket_dir(env: &Env) -> PathBuf {
    get_climon_home(env).join("sock")
}

/// `$CLIMON_HOME/sessions/<id>.json`.
pub fn get_session_meta_path(id: &str, env: &Env) -> PathBuf {
    get_sessions_dir(env).join(format!("{id}.json"))
}

/// `$CLIMON_HOME/sessions/<id>.scrollback`.
pub fn get_scrollback_path(id: &str, env: &Env) -> PathBuf {
    get_sessions_dir(env).join(format!("{id}.scrollback"))
}

/// Per-platform IPC socket path: Windows named pipe or `$CLIMON_HOME/sock/<id>.sock`.
pub fn get_socket_path(id: &str, env: &Env, platform: &str) -> String {
    if platform == "win32" {
        format!("\\\\.\\pipe\\climon-{id}")
    } else {
        get_socket_dir(env)
            .join(format!("{id}.sock"))
            .to_string_lossy()
            .into_owned()
    }
}

/// Creates `$CLIMON_HOME`, the sessions dir, and (non-Windows) the socket dir.
pub fn ensure_climon_home(env: &Env) -> Result<PathBuf, String> {
    let dir = get_climon_home(env);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    set_dir_mode(&dir, 0o700);
    fs::create_dir_all(get_sessions_dir(env)).map_err(|e| e.to_string())?;
    if !cfg!(target_os = "windows") {
        fs::create_dir_all(get_socket_dir(env)).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// The registry-derived default config object.
pub fn default_config() -> Value {
    build_default_config_from_settings()
}

/// Ordered candidate `.climon` dirs: cwd, ancestors up to (not past) `$HOME`, then global.
pub fn candidate_config_dirs(env: &Env, cwd: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let home_boundary = resolve(env.home());
    let start = resolve(cwd);
    if start.starts_with(&home_boundary) {
        let mut dir = start;
        loop {
            if dir == home_boundary {
                break;
            }
            dirs.push(dir.join(".climon"));
            match dir.parent() {
                Some(parent) if parent != dir => dir = parent.to_path_buf(),
                _ => break,
            }
        }
    } else {
        dirs.push(start.join(".climon"));
    }
    let home = get_climon_home(env);
    if !dirs.contains(&home) {
        dirs.push(home);
    }
    dirs
}

/// Lists canonical + legacy config files across the cascade, deduping by realpath.
pub fn list_existing_config_files(env: &Env, cwd: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for dir in candidate_config_dirs(env, cwd) {
        if !dir.exists() {
            continue;
        }
        let dir_key = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        if seen.contains(&dir_key) {
            continue;
        }
        seen.insert(dir_key);

        let canonical = config_path_for_dir(&dir);
        if canonical.exists() {
            files.push(canonical);
        }
        let legacy = legacy_config_path_for_dir(&dir);
        if legacy.exists() {
            files.push(legacy);
        }
    }
    files
}

fn read_sparse_config(dir: &Path) -> Map<String, Value> {
    let path = match existing_config_path_for_dir(dir) {
        Some(p) => p,
        None => return Map::new(),
    };
    let raw = match fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return Map::new(),
    };
    match parse_jsonc_config(&raw, &path.to_string_lossy()) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// Reads a dotted key (only the first two segments, matching the TS quirk).
fn read_dotted_key<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    let mut it = key.split('.');
    let section = it.next()?;
    let field = it.next()?;
    obj.get(section)?.as_object()?.get(field)
}

/// Resolves a dotted config key across the cascade; first dir defining it wins.
pub fn resolve_config_setting(key: &str, env: &Env, cwd: &Path) -> Option<Value> {
    if find_config_setting(key)
        .map(|setting| setting.global_only)
        .unwrap_or(false)
    {
        return read_global_config_setting(key, env);
    }
    for dir in candidate_config_dirs(env, cwd) {
        let sparse = read_sparse_config(&dir);
        if let Some(v) = read_dotted_key(&sparse, key) {
            return Some(v.clone());
        }
    }
    None
}

/// Reads a dotted key from ONLY the global `$CLIMON_HOME` config.
pub fn read_global_config_setting(key: &str, env: &Env) -> Option<Value> {
    let sparse = read_sparse_config(&get_climon_home(env));
    read_dotted_key(&sparse, key).cloned()
}

/// Chooses the write target dir for a scope.
pub fn resolve_write_dir(scope: WriteScope, env: &Env, cwd: &Path) -> PathBuf {
    match scope {
        WriteScope::Local => resolve(cwd).join(".climon"),
        WriteScope::Global => get_climon_home(env),
        WriteScope::Auto => {
            for dir in candidate_config_dirs(env, cwd) {
                if existing_config_path_for_dir(&dir).is_some() {
                    return dir;
                }
            }
            get_climon_home(env)
        }
    }
}

fn resolve_write_dir_for_key(key: &str, scope: WriteScope, env: &Env, cwd: &Path) -> PathBuf {
    if scope == WriteScope::Auto
        && find_config_setting(key)
            .map(|setting| setting.global_only)
            .unwrap_or(false)
    {
        return get_climon_home(env);
    }
    resolve_write_dir(scope, env, cwd)
}

/// Whether a config write is an explicit local write of a key that is only read
/// from the global config.
pub fn should_warn_global_only_local_write(key: &str, scope: WriteScope) -> bool {
    scope == WriteScope::Local
        && find_config_setting(key)
            .map(|setting| setting.global_only)
            .unwrap_or(false)
}

/// Whether `key` is a registry key users may set.
pub fn is_known_config_key(key: &str) -> bool {
    crate::config_settings::accepted_config_keys()
        .iter()
        .any(|k| k == key)
}

/// All registry keys users may set.
pub fn known_config_keys() -> Vec<String> {
    crate::config_settings::accepted_config_keys()
}

/// Coerces a string CLI value to the typed value for a known key.
pub fn coerce_config_value(key: &str, value: &str) -> Result<Value, String> {
    coerce_config_value_from_settings(key, value)
}

fn split_two(key: &str) -> (String, String) {
    let mut it = key.split('.');
    let section = it.next().unwrap_or("").to_string();
    let field = it.next().unwrap_or("").to_string();
    (section, field)
}

fn write_sparse_config(dir: &Path, record: &Value) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    set_dir_mode(dir, 0o700);
    let canonical = config_path_for_dir(dir);
    let legacy = legacy_config_path_for_dir(dir);
    let backup = legacy_backup_path_for_dir(dir);

    let has_legacy = legacy.exists();
    let has_canonical = canonical.exists();

    let rendered = render_jsonc_config(record);
    fs::write(&canonical, rendered).map_err(|e| e.to_string())?;
    set_file_mode(&canonical, 0o600);

    if has_legacy && !has_canonical {
        fs::rename(&legacy, &backup).map_err(|e| {
            format!(
                "Wrote {} but failed to back up legacy {} to {}: {}",
                canonical.display(),
                legacy.display(),
                backup.display(),
                e
            )
        })?;
    }
    Ok(())
}

/// Sets a dotted key (coerced), writing a sparse file; returns the dir written.
pub fn write_config_setting(
    key: &str,
    value: &str,
    scope: WriteScope,
    env: &Env,
    cwd: &Path,
) -> Result<PathBuf, String> {
    let dir = resolve_write_dir_for_key(key, scope, env, cwd);
    let mut current = Value::Object(read_sparse_config(&dir));
    let (section, field) = split_two(key);
    let coerced = coerce_config_value(key, value)?;
    let obj = current.as_object_mut().unwrap();
    let entry = obj.entry(section).or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
    }
    entry.as_object_mut().unwrap().insert(field, coerced);
    write_sparse_config(&dir, &current)?;
    Ok(dir)
}

/// Removes a dotted key from a scope's sparse file (no-op if absent).
pub fn unset_config_setting(
    key: &str,
    scope: WriteScope,
    env: &Env,
    cwd: &Path,
) -> Result<(), String> {
    let dir = resolve_write_dir_for_key(key, scope, env, cwd);
    if existing_config_path_for_dir(&dir).is_none() {
        return Ok(());
    }
    let mut current = Value::Object(read_sparse_config(&dir));
    let (section, field) = split_two(key);
    let obj = current.as_object_mut().unwrap();
    if let Some(sub) = obj.get_mut(&section).and_then(|v| v.as_object_mut()) {
        sub.remove(&field);
        if sub.is_empty() {
            obj.remove(&section);
        }
    }
    write_sparse_config(&dir, &current)
}

fn shallow_merge(base: &Map<String, Value>, over: &Map<String, Value>) -> Map<String, Value> {
    let mut merged = base.clone();
    for (k, v) in over {
        merged.insert(k.clone(), v.clone());
    }
    merged
}

fn object_or_empty(parent: &Value, key: &str) -> Map<String, Value> {
    parent
        .get(key)
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

fn normalize_detach_prefix(v: Option<&Value>) -> Value {
    if let Some(n) = v.and_then(|x| x.as_f64()) {
        if n.fract() == 0.0 && (0.0..=255.0).contains(&n) {
            return Value::from(n as i64);
        }
    }
    Value::from(DEFAULT_DETACH_PREFIX)
}

fn color_mode_to_string(mode: ColorMode) -> String {
    match mode {
        ColorMode::Auto => "auto".to_string(),
        ColorMode::None => "none".to_string(),
        ColorMode::Color(c) => c.name().to_string(),
    }
}

enum ConfigError {
    NotFound,
    Other(String),
}

/// Loads, cascades, and backfills the full config; writes defaults if none exists.
pub fn load_config(env: &Env) -> Result<Value, String> {
    ensure_climon_home(env)?;
    let home = get_climon_home(env);
    let canonical = config_path_for_dir(&home);
    let legacy = legacy_config_path_for_dir(&home);
    let config_path = if canonical.exists() {
        Some(canonical)
    } else if legacy.exists() {
        Some(legacy)
    } else {
        None
    };

    let attempt = || -> Result<Value, ConfigError> {
        let path = config_path.ok_or(ConfigError::NotFound)?;
        let raw = fs::read_to_string(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ConfigError::NotFound
            } else {
                ConfigError::Other(e.to_string())
            }
        })?;
        let parsed =
            parse_jsonc_config(&raw, &path.to_string_lossy()).map_err(ConfigError::Other)?;
        let version = parsed.get("version");
        if !parsed.is_object() || (version.is_some() && version != Some(&Value::from(1))) {
            return Err(ConfigError::Other(format!(
                "Unsupported climon config format in {}",
                path.display()
            )));
        }

        let defaults = default_config();
        let parsed_server = object_or_empty(&parsed, "server");
        let parsed_terminal = object_or_empty(&parsed, "terminal");
        let parsed_attention = object_or_empty(&parsed, "attention");
        let parsed_session = object_or_empty(&parsed, "session");
        let parsed_feature = object_or_empty(&parsed, "feature");
        let parsed_hotkeys = object_or_empty(&parsed, "hotKeys");

        let mut session = object_or_empty(&defaults, "session");
        if let Some(p) = parsed_session.get("priority") {
            if p.is_number() {
                session.insert("priority".to_string(), p.clone());
            }
        }
        if let Some(c) = parsed_session.get("color") {
            if c.is_string() {
                session.insert("color".to_string(), c.clone());
            }
        }

        let mut out = Map::new();
        out.insert("version".to_string(), Value::from(1));
        out.insert(
            "server".to_string(),
            Value::Object(shallow_merge(
                &object_or_empty(&defaults, "server"),
                &parsed_server,
            )),
        );
        out.insert(
            "terminal".to_string(),
            Value::Object(shallow_merge(
                &object_or_empty(&defaults, "terminal"),
                &parsed_terminal,
            )),
        );
        out.insert(
            "attention".to_string(),
            Value::Object(shallow_merge(
                &object_or_empty(&defaults, "attention"),
                &parsed_attention,
            )),
        );
        if let Some(remote) = parsed.get("remote") {
            if remote.is_object() {
                out.insert("remote".to_string(), remote.clone());
            }
        }
        out.insert("session".to_string(), Value::Object(session));
        out.insert(
            "feature".to_string(),
            Value::Object(shallow_merge(
                &object_or_empty(&defaults, "feature"),
                &parsed_feature,
            )),
        );
        out.insert(
            "hotKeys".to_string(),
            Value::Object(shallow_merge(
                &object_or_empty(&defaults, "hotKeys"),
                &parsed_hotkeys,
            )),
        );

        // Backfills.
        {
            let terminal = out.get_mut("terminal").unwrap().as_object_mut().unwrap();
            if !terminal
                .get("clampBrowserToHost")
                .map(|v| v.is_boolean())
                .unwrap_or(false)
            {
                terminal.insert("clampBrowserToHost".to_string(), Value::from(false));
            }
            let normalized = normalize_detach_prefix(terminal.get("detachPrefix"));
            terminal.insert("detachPrefix".to_string(), normalized);
            if !terminal
                .get("setTitle")
                .map(|v| v.is_boolean())
                .unwrap_or(false)
            {
                terminal.insert("setTitle".to_string(), Value::from(true));
            }
        }
        {
            let attention = out.get_mut("attention").unwrap().as_object_mut().unwrap();
            if !attention
                .get("idleSeconds")
                .map(|v| v.is_number())
                .unwrap_or(false)
            {
                attention.insert("idleSeconds".to_string(), Value::from(10));
            }
        }
        {
            let session = out.get_mut("session").unwrap().as_object_mut().unwrap();
            let color = match session.get("color").and_then(|v| v.as_str()) {
                Some(s) => parse_color_mode(s)
                    .map(color_mode_to_string)
                    .unwrap_or_else(|_| "auto".to_string()),
                None => "auto".to_string(),
            };
            session.insert("color".to_string(), Value::from(color));
        }
        {
            let hotkeys = out.get_mut("hotKeys").unwrap().as_object_mut().unwrap();
            if !hotkeys
                .get("focusTopSession")
                .map(|v| v.is_string())
                .unwrap_or(false)
            {
                hotkeys.insert("focusTopSession".to_string(), Value::from("Alt+J"));
            }
        }

        Ok(Value::Object(out))
    };

    match attempt() {
        Ok(config) => Ok(config),
        Err(ConfigError::NotFound) => {
            let config = default_config();
            save_config(&config, env)?;
            Ok(config)
        }
        Err(ConfigError::Other(msg)) => Err(msg),
    }
}

/// Writes the full config as canonical `config.jsonc`, migrating legacy `config.json`.
pub fn save_config(config: &Value, env: &Env) -> Result<(), String> {
    ensure_climon_home(env)?;
    let home = get_climon_home(env);
    let canonical = config_path_for_dir(&home);
    let legacy = legacy_config_path_for_dir(&home);
    let backup = legacy_backup_path_for_dir(&home);

    let has_legacy = legacy.exists();
    let has_canonical = canonical.exists();

    let rendered = render_jsonc_config(config);
    fs::write(&canonical, rendered).map_err(|e| e.to_string())?;
    set_file_mode(&canonical, 0o600);

    if has_legacy && !has_canonical {
        fs::rename(&legacy, &backup).map_err(|e| {
            format!(
                "Wrote {} but failed to back up legacy {} to {}: {}",
                canonical.display(),
                legacy.display(),
                backup.display(),
                e
            )
        })?;
    }
    Ok(())
}

/// A single redacted dotted key/value for `climon config --debug`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigDebugKey {
    pub key: String,
    pub value: String,
}

/// One candidate config file's debug summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigDebugEntry {
    pub path: PathBuf,
    pub exists: bool,
    pub keys: Vec<ConfigDebugKey>,
    pub error: Option<String>,
}

fn format_debug_value(key: &str, value: &Value) -> String {
    match find_config_setting(key) {
        Some(setting) if !setting.sensitive => match value {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        },
        _ => "<redacted>".to_string(),
    }
}

fn collect_dotted_entries(value: &Value, prefix: &str) -> Vec<ConfigDebugKey> {
    match value {
        Value::Object(map) => {
            let mut entries = Vec::new();
            for (key, child) in map {
                let dotted = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                entries.extend(collect_dotted_entries(child, &dotted));
            }
            entries
        }
        _ => {
            if prefix.is_empty() {
                Vec::new()
            } else {
                vec![ConfigDebugKey {
                    key: prefix.to_string(),
                    value: format_debug_value(prefix, value),
                }]
            }
        }
    }
}

/// Builds the `climon config --debug` report across the cascade.
pub fn list_config_debug_entries(env: &Env, cwd: &Path) -> Vec<ConfigDebugEntry> {
    candidate_config_dirs(env, cwd)
        .into_iter()
        .map(|dir| {
            let config_path = existing_config_path_for_dir(&dir);
            let reported_path = config_path_for_dir(&dir);
            match config_path {
                None => ConfigDebugEntry {
                    path: reported_path,
                    exists: false,
                    keys: Vec::new(),
                    error: None,
                },
                Some(path) => {
                    let raw = match fs::read_to_string(&path) {
                        Ok(r) => r,
                        Err(e) => {
                            return ConfigDebugEntry {
                                path: reported_path,
                                exists: true,
                                keys: Vec::new(),
                                error: Some(e.to_string()),
                            }
                        }
                    };
                    match parse_jsonc_config(&raw, &path.to_string_lossy()) {
                        Ok(parsed) => {
                            let mut keys = collect_dotted_entries(&parsed, "");
                            keys.sort_by(|a, b| a.key.cmp(&b.key));
                            ConfigDebugEntry {
                                path: reported_path,
                                exists: true,
                                keys,
                                error: None,
                            }
                        }
                        Err(e) => ConfigDebugEntry {
                            path: reported_path,
                            exists: true,
                            keys: Vec::new(),
                            error: Some(e),
                        },
                    }
                }
            }
        })
        .collect()
}

/// Absolute path to the home machine's tunnel-hosting desired-state file.
pub fn get_remote_host_path(env: &Env) -> PathBuf {
    get_climon_home(env).join("remote-host.json")
}

#[cfg(unix)]
fn set_dir_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_dir_mode(_path: &Path, _mode: u32) {}

#[cfg(unix)]
fn set_file_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_file_mode(_path: &Path, _mode: u32) {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::current_dir()
                .unwrap()
                .join(".copilot-tmp")
                .join(format!(
                    "climon-cfg-{label}-{}-{nanos}-{n}",
                    std::process::id()
                ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_json(dir: &Path, obj: Value) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("config.json"),
            serde_json::to_string(&obj).unwrap(),
        )
        .unwrap();
    }

    // Env whose home is `root` and CLIMON_HOME is `root/.climon`.
    fn cascade_env(root: &Path) -> (Env, PathBuf) {
        let home = root.to_path_buf();
        fs::create_dir_all(&home).unwrap();
        let climon_home = home.join(".climon");
        let env = Env::new(Some(climon_home.to_str().unwrap()), home.clone());
        (env, home)
    }

    #[test]
    fn path_helpers() {
        let t = TempDir::new("paths");
        let ch = t.path().join("ch");
        let env = Env::new(Some(ch.to_str().unwrap()), t.path());
        assert_eq!(get_sessions_dir(&env), ch.join("sessions"));
        assert_eq!(
            get_session_meta_path("abc", &env),
            ch.join("sessions").join("abc.json")
        );
        assert_eq!(
            get_scrollback_path("abc", &env),
            ch.join("sessions").join("abc.scrollback")
        );
        assert_eq!(
            get_socket_path("abc", &env, "linux"),
            ch.join("sock").join("abc.sock").to_string_lossy()
        );
        assert_eq!(
            get_socket_path("abc", &env, "win32"),
            "\\\\.\\pipe\\climon-abc"
        );
        assert_eq!(get_config_path(&env), ch.join("config.jsonc"));
    }

    #[test]
    fn default_config_shape() {
        let cfg = default_config();
        assert_eq!(cfg["server"]["host"], json!("127.0.0.1"));
        assert_eq!(cfg["server"]["port"], json!(3131));
        assert_eq!(cfg["terminal"]["clampBrowserToHost"], json!(false));
        assert_eq!(cfg["terminal"]["setTitle"], json!(true));
        assert_eq!(cfg["terminal"]["detachPrefix"], json!(0x1c));
        assert_eq!(cfg["hotKeys"]["focusTopSession"], json!("Alt+J"));
        assert_eq!(cfg["session"]["color"], json!("auto"));
    }

    #[test]
    fn cascade_override_and_fallback() {
        let t = TempDir::new("cascade");
        let (env, home) = cascade_env(t.path());
        let repo = t.path().join("work").join("repo");
        fs::create_dir_all(&repo).unwrap();
        write_json(
            &repo.join(".climon"),
            json!({ "session": { "color": "green", "priority": 20 } }),
        );
        write_json(
            &home.join(".climon"),
            json!({ "session": { "color": "red", "priority": 500 } }),
        );
        assert_eq!(
            resolve_config_setting("session.color", &env, &repo),
            Some(json!("green"))
        );
        assert_eq!(
            resolve_config_setting("session.priority", &env, &repo),
            Some(json!(20))
        );

        let t2 = TempDir::new("cascade2");
        let (env2, home2) = cascade_env(t2.path());
        let repo2 = t2.path().join("work").join("repo");
        fs::create_dir_all(&repo2).unwrap();
        write_json(
            &repo2.join(".climon"),
            json!({ "session": { "color": "green" } }),
        );
        write_json(
            &home2.join(".climon"),
            json!({ "session": { "priority": 500 } }),
        );
        assert_eq!(
            resolve_config_setting("session.color", &env2, &repo2),
            Some(json!("green"))
        );
        assert_eq!(
            resolve_config_setting("session.priority", &env2, &repo2),
            Some(json!(500))
        );
    }

    #[test]
    fn global_only_settings_ignore_project_local_config() {
        let t = TempDir::new("globalonly");
        let (env, home) = cascade_env(t.path());
        let repo = t.path().join("repo");
        fs::create_dir_all(home.join(".climon")).unwrap();
        fs::create_dir_all(repo.join(".climon")).unwrap();
        fs::write(
            home.join(".climon").join("config.jsonc"),
            r#"{"session":{"terminalProgram":"safe-term {cmd}"},"remote":{"port":3131},"update":{"password":"safe-password"}}"#,
        )
        .unwrap();
        fs::write(
            repo.join(".climon").join("config.jsonc"),
            r#"{"session":{"terminalProgram":"./evil.sh {cmd}"},"remote":{"port":4444},"update":{"password":"evil-password"}}"#,
        )
        .unwrap();

        assert_eq!(
            resolve_config_setting("session.terminalProgram", &env, &repo),
            Some(json!("safe-term {cmd}"))
        );
        assert_eq!(
            resolve_config_setting("remote.port", &env, &repo),
            Some(json!(3131))
        );
        assert_eq!(
            resolve_config_setting("update.password", &env, &repo),
            Some(json!("safe-password"))
        );
    }

    #[test]
    fn non_global_only_settings_still_honor_project_local_config() {
        let t = TempDir::new("localok");
        let (env, _) = cascade_env(t.path());
        let repo = t.path().join("repo");
        fs::create_dir_all(repo.join(".climon")).unwrap();
        fs::write(
            repo.join(".climon").join("config.jsonc"),
            r#"{"session":{"color":"blue"}}"#,
        )
        .unwrap();

        assert_eq!(
            resolve_config_setting("session.color", &env, &repo),
            Some(json!("blue"))
        );
    }

    #[test]
    fn cascade_walks_ancestors_and_returns_none() {
        let t = TempDir::new("walk");
        let (env, _) = cascade_env(t.path());
        let deep = t.path().join("a").join("b").join("c");
        fs::create_dir_all(&deep).unwrap();
        write_json(
            &t.path().join("a").join(".climon"),
            json!({ "session": { "priority": 123 } }),
        );
        assert_eq!(
            resolve_config_setting("session.priority", &env, &deep),
            Some(json!(123))
        );
        assert_eq!(resolve_config_setting("session.color", &env, &deep), None);
    }

    #[test]
    fn candidate_dirs_order_and_home_boundary() {
        let t = TempDir::new("dirs");
        let (env, home) = cascade_env(t.path());
        let deep = t.path().join("a").join("b");
        fs::create_dir_all(&deep).unwrap();
        let dirs = candidate_config_dirs(&env, &deep);
        assert_eq!(dirs[0], deep.join(".climon"));
        assert_eq!(dirs[dirs.len() - 1], home.join(".climon"));
    }

    #[test]
    fn does_not_climb_above_home() {
        let t = TempDir::new("noclimb");
        let home_root = t.path().join("home");
        let global = t.path().join("global").join(".climon");
        fs::create_dir_all(&home_root).unwrap();
        let env = Env::new(Some(global.to_str().unwrap()), home_root.clone());
        let nested = home_root.join("proj").join("nested").join("work");
        let dirs = candidate_config_dirs(&env, &nested);
        assert!(!dirs.contains(&home_root.join(".climon")));
        assert_eq!(dirs[dirs.len() - 1], global);
    }

    #[test]
    fn cascade_does_not_walk_ancestors_outside_home() {
        let t = TempDir::new("outsidehome");
        let home_root = t.path().join("home");
        let global = home_root.join(".climon");
        let cwd = t.path().join("outside").join("work").join("project");
        let env = Env::new(Some(global.to_str().unwrap()), home_root);

        let dirs = candidate_config_dirs(&env, &cwd);

        assert!(dirs.contains(&cwd.join(".climon")));
        assert!(!dirs.contains(&t.path().join("outside").join("work").join(".climon")));
        assert!(!dirs.contains(&t.path().join("outside").join(".climon")));
        assert_eq!(dirs[dirs.len() - 1], global);
    }

    #[test]
    fn write_to_nearest_existing_and_creates_home() {
        let t = TempDir::new("write");
        let (env, home) = cascade_env(t.path());
        let repo = t.path().join("work").join("repo");
        let sub = repo.join("src");
        fs::create_dir_all(&sub).unwrap();
        write_json(&repo.join(".climon"), json!({}));
        write_config_setting("session.color", "blue", WriteScope::Auto, &env, &sub).unwrap();
        assert_eq!(
            resolve_config_setting("session.color", &env, &sub),
            Some(json!("blue"))
        );

        let t2 = TempDir::new("write2");
        let (env2, home2) = cascade_env(t2.path());
        let repo2 = t2.path().join("work").join("repo");
        fs::create_dir_all(&repo2).unwrap();
        write_config_setting("session.priority", "42", WriteScope::Auto, &env2, &repo2).unwrap();
        assert_eq!(
            resolve_config_setting("session.priority", &env2, &repo2),
            Some(json!(42))
        );
        assert_eq!(
            resolve_config_setting("session.priority", &env2, &home2),
            Some(json!(42))
        );
        let _ = home;
    }

    #[test]
    fn auto_write_of_global_only_setting_targets_global_config() {
        let t = TempDir::new("writeglobalonly");
        let (env, home) = cascade_env(t.path());
        let repo = t.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        write_json(
            &repo.join(".climon"),
            json!({ "session": { "color": "red" } }),
        );

        write_config_setting(
            "session.terminalProgram",
            "safe-term {cmd}",
            WriteScope::Auto,
            &env,
            &repo,
        )
        .unwrap();

        assert_eq!(
            resolve_config_setting("session.terminalProgram", &env, &repo),
            Some(json!("safe-term {cmd}"))
        );
        assert_eq!(
            read_dotted_key(
                &read_sparse_config(&repo.join(".climon")),
                "session.terminalProgram"
            ),
            None
        );
        assert_eq!(
            read_dotted_key(
                &read_sparse_config(&home.join(".climon")),
                "session.terminalProgram"
            ),
            Some(&json!("safe-term {cmd}"))
        );
    }

    #[test]
    fn local_write_is_sparse() {
        let t = TempDir::new("local");
        let (env, _) = cascade_env(t.path());
        let repo = t.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        write_config_setting("remote.enabled", "true", WriteScope::Local, &env, &repo).unwrap();
        let raw = fs::read_to_string(repo.join(".climon").join("config.jsonc")).unwrap();
        let parsed = parse_jsonc_config(&raw, "x").unwrap();
        assert_eq!(parsed, json!({ "remote": { "enabled": true } }));
    }

    #[test]
    fn sparse_writes_preserve_siblings_and_drop_empty_sections() {
        let t = TempDir::new("preserve");
        let (env, _) = cascade_env(t.path());
        let repo = t.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        write_json(
            &repo.join(".climon"),
            json!({ "session": { "color": "red" } }),
        );
        write_config_setting("session.priority", "42", WriteScope::Local, &env, &repo).unwrap();
        assert_eq!(
            resolve_config_setting("session.color", &env, &repo),
            Some(json!("red"))
        );
        assert_eq!(
            resolve_config_setting("session.priority", &env, &repo),
            Some(json!(42))
        );

        unset_config_setting("session.color", WriteScope::Local, &env, &repo).unwrap();
        assert_eq!(resolve_config_setting("session.color", &env, &repo), None);
        assert_eq!(
            resolve_config_setting("session.priority", &env, &repo),
            Some(json!(42))
        );
        unset_config_setting("session.priority", WriteScope::Local, &env, &repo).unwrap();
        let raw = fs::read_to_string(repo.join(".climon").join("config.jsonc")).unwrap();
        assert_eq!(parse_jsonc_config(&raw, "x").unwrap(), json!({}));
    }

    #[test]
    fn unset_missing_is_noop() {
        let t = TempDir::new("unsetnoop");
        let (env, _) = cascade_env(t.path());
        let repo = t.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        assert!(unset_config_setting("session.color", WriteScope::Local, &env, &repo).is_ok());
    }

    #[test]
    fn list_existing_config_files_order() {
        let t = TempDir::new("listfiles");
        let (env, home) = cascade_env(t.path());
        let repo = t.path().join("work").join("repo");
        let nested = repo.join("src").join("app");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(repo.join(".climon")).unwrap();
        fs::create_dir_all(t.path().join("work").join(".climon")).unwrap();
        fs::create_dir_all(home.join(".climon")).unwrap();
        fs::write(repo.join(".climon").join("config.jsonc"), "{}").unwrap();
        fs::write(repo.join(".climon").join("config.json"), "{}").unwrap();
        fs::write(
            t.path().join("work").join(".climon").join("config.json"),
            "{}",
        )
        .unwrap();
        fs::write(home.join(".climon").join("config.jsonc"), "{}").unwrap();
        assert_eq!(
            list_existing_config_files(&env, &nested),
            vec![
                repo.join(".climon").join("config.jsonc"),
                repo.join(".climon").join("config.json"),
                t.path().join("work").join(".climon").join("config.json"),
                home.join(".climon").join("config.jsonc"),
            ]
        );
    }

    #[test]
    fn global_read_ignores_local() {
        let t = TempDir::new("global");
        let home = t.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let env = Env::new(Some(home.join(".climon").to_str().unwrap()), home.clone());
        assert_eq!(read_global_config_setting("telemetry.enabled", &env), None);
        write_config_setting("telemetry.enabled", "true", WriteScope::Global, &env, &home).unwrap();
        assert_eq!(
            read_global_config_setting("telemetry.enabled", &env),
            Some(json!(true))
        );

        let cwd = t.path().join("cwd");
        fs::create_dir_all(&cwd).unwrap();
        let env2_home = t.path().join("home2");
        fs::create_dir_all(&env2_home).unwrap();
        let env2 = Env::new(Some(env2_home.join(".climon").to_str().unwrap()), env2_home);
        write_config_setting("telemetry.enabled", "true", WriteScope::Local, &env2, &cwd).unwrap();
        assert_eq!(read_global_config_setting("telemetry.enabled", &env2), None);
    }

    #[test]
    fn load_config_creates_with_comments() {
        let t = TempDir::new("create");
        let env = Env::new(Some(t.path().join("ch").to_str().unwrap()), t.path());
        let cfg = load_config(&env).unwrap();
        assert_eq!(cfg["session"]["color"], json!("auto"));
        assert_eq!(cfg["session"]["priority"], json!(500));
        let raw = fs::read_to_string(t.path().join("ch").join("config.jsonc")).unwrap();
        assert!(raw.contains("// Schema version for the persisted config.json format"));
        assert!(raw.contains("\"version\": 1"));
        assert!(raw.contains("\"color\": \"auto\""));
    }

    #[test]
    fn load_config_reads_jsonc_and_legacy() {
        let t = TempDir::new("read");
        let ch = t.path().join("ch");
        fs::create_dir_all(&ch).unwrap();
        let env = Env::new(Some(ch.to_str().unwrap()), t.path());
        fs::write(
            ch.join("config.jsonc"),
            "{\n  // Custom server port\n  \"server\": { \"host\": \"127.0.0.1\", \"port\": 9999 },\n  /* prefs */\n  \"session\": { \"color\": \"blue\" }\n}",
        )
        .unwrap();
        let cfg = load_config(&env).unwrap();
        assert_eq!(cfg["server"]["port"], json!(9999));
        assert_eq!(cfg["session"]["color"], json!("blue"));

        let t2 = TempDir::new("legacy");
        let ch2 = t2.path().join("ch");
        fs::create_dir_all(&ch2).unwrap();
        let env2 = Env::new(Some(ch2.to_str().unwrap()), t2.path());
        write_json(
            &ch2,
            json!({ "version": 1, "server": { "host": "127.0.0.1", "port": 7777 }, "session": { "color": "green" } }),
        );
        let cfg2 = load_config(&env2).unwrap();
        assert_eq!(cfg2["server"]["port"], json!(7777));
        assert_eq!(cfg2["session"]["color"], json!("green"));
        assert!(ch2.join("config.json").exists());
    }

    #[test]
    fn load_config_backfills() {
        let t = TempDir::new("backfill");
        let ch = t.path().join("ch");
        fs::create_dir_all(&ch).unwrap();
        let env = Env::new(Some(ch.to_str().unwrap()), t.path());
        write_json(
            &ch,
            json!({ "version": 1, "server": { "host": "127.0.0.1", "port": 3131, "lan": false, "token": "tok" }, "terminal": { "clampBrowserToHost": true, "detachPrefix": 999 } }),
        );
        let cfg = load_config(&env).unwrap();
        assert_eq!(cfg["attention"]["idleSeconds"], json!(10));
        assert_eq!(cfg["terminal"]["setTitle"], json!(true));
        assert_eq!(cfg["terminal"]["detachPrefix"], json!(0x1c));
        assert_eq!(cfg["session"]["color"], json!("auto"));
    }

    #[test]
    fn load_config_merges_and_backfills_hotkeys() {
        let t = TempDir::new("hotkeys");
        let ch = t.path().join("ch");
        fs::create_dir_all(&ch).unwrap();
        let env = Env::new(Some(ch.to_str().unwrap()), t.path());
        write_json(
            &ch,
            json!({ "version": 1, "server": { "host": "127.0.0.1", "port": 3131 } }),
        );
        let cfg = load_config(&env).unwrap();
        assert_eq!(cfg["hotKeys"]["focusTopSession"], json!("Alt+J"));

        let t2 = TempDir::new("customhotkeys");
        let ch2 = t2.path().join("ch");
        fs::create_dir_all(&ch2).unwrap();
        let env2 = Env::new(Some(ch2.to_str().unwrap()), t2.path());
        write_json(
            &ch2,
            json!({ "version": 1, "hotKeys": { "focusTopSession": "Ctrl+Shift+J" } }),
        );
        let cfg2 = load_config(&env2).unwrap();
        assert_eq!(cfg2["hotKeys"]["focusTopSession"], json!("Ctrl+Shift+J"));
    }

    #[test]
    fn load_config_backfills_invalid_color_and_sparse_global() {
        let t = TempDir::new("color");
        let ch = t.path().join("ch");
        fs::create_dir_all(&ch).unwrap();
        let env = Env::new(Some(ch.to_str().unwrap()), t.path());
        write_json(
            &ch,
            json!({ "version": 1, "session": { "color": "orange" } }),
        );
        let cfg = load_config(&env).unwrap();
        assert_eq!(cfg["session"]["color"], json!("auto"));

        let t2 = TempDir::new("sparseglobal");
        let ch2 = t2.path().join("ch");
        fs::create_dir_all(&ch2).unwrap();
        let env2 = Env::new(Some(ch2.to_str().unwrap()), t2.path());
        write_json(
            &ch2,
            json!({ "remote": { "enabled": true, "tunnelId": "abc123", "port": 3132 } }),
        );
        let cfg2 = load_config(&env2).unwrap();
        assert_eq!(cfg2["version"], json!(1));
        assert_eq!(cfg2["server"]["host"], json!("127.0.0.1"));
        assert_eq!(cfg2["remote"]["enabled"], json!(true));
    }

    #[test]
    fn save_config_migrates_legacy() {
        let t = TempDir::new("migrate");
        let ch = t.path().join("ch");
        fs::create_dir_all(&ch).unwrap();
        let env = Env::new(Some(ch.to_str().unwrap()), t.path());
        write_json(
            &ch,
            json!({ "version": 1, "server": { "host": "127.0.0.1", "port": 3131 }, "session": { "color": "auto" } }),
        );
        save_config(&default_config(), &env).unwrap();
        assert!(ch.join("config.jsonc").exists());
        assert!(ch.join("config.json.bak").exists());
        assert!(!ch.join("config.json").exists());
        let raw = fs::read_to_string(ch.join("config.jsonc")).unwrap();
        assert!(!raw.contains("undefined"));
    }

    #[test]
    fn debug_entries_redact_and_order() {
        let t = TempDir::new("debug");
        let (env, home) = cascade_env(t.path());
        let repo = t.path().join("repo");
        let nested = repo.join("src").join("app");
        fs::create_dir_all(repo.join(".climon")).unwrap();
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(home.join(".climon")).unwrap();
        fs::write(
            repo.join(".climon").join("config.jsonc"),
            serde_json::to_string(&json!({ "session": { "color": "green" } })).unwrap(),
        )
        .unwrap();
        fs::write(
            home.join(".climon").join("config.jsonc"),
            serde_json::to_string(&json!({ "remote": { "enabled": true, "port": 3132 }, "mystery": { "apiKey": "leak-me" } })).unwrap(),
        )
        .unwrap();
        let entries = list_config_debug_entries(&env, &nested);
        // nested has no file -> exists false
        assert_eq!(entries[0].path, nested.join(".climon").join("config.jsonc"));
        assert!(!entries[0].exists);
        // find the home entry and assert redaction
        let home_entry = entries
            .iter()
            .find(|e| e.path == home.join(".climon").join("config.jsonc"))
            .unwrap();
        let api = home_entry
            .keys
            .iter()
            .find(|k| k.key == "mystery.apiKey")
            .unwrap();
        assert_eq!(api.value, "<redacted>");
        let enabled = home_entry
            .keys
            .iter()
            .find(|k| k.key == "remote.enabled")
            .unwrap();
        assert_eq!(enabled.value, "true");
        let port = home_entry
            .keys
            .iter()
            .find(|k| k.key == "remote.port")
            .unwrap();
        assert_eq!(port.value, "3132");
    }
}
