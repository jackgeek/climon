//! `climon config` subcommand. Port of `src/cli/config-cmd.ts`.
//!
//! A thin wrapper over `climon-config`: parses the config argv, then gets/sets/
//! unsets/lists/debugs/purges settings, reusing the crate's settings-help
//! renderer for a byte-exact `config --help`.

use std::io::Write;
use std::path::Path;

use climon_config::config::{
    coerce_config_value, is_known_config_key, known_config_keys, list_config_debug_entries,
    list_existing_config_files, resolve_config_setting, should_warn_global_only_local_write,
    unset_config_setting, write_config_setting, Env, WriteScope,
};
use climon_config::config_settings::{find_config_setting, render_config_settings_help};
use climon_config::features::{
    feature_status, is_feature_locked, parse_feature_config_key, FeatureStatus,
};
use serde_json::Value;

/// A parsed `climon config` action. Mirrors the TS `ConfigAction` union.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigAction {
    Help,
    Debug,
    Purge,
    List {
        scope: WriteScope,
    },
    Get {
        scope: WriteScope,
        key: String,
    },
    Set {
        scope: WriteScope,
        key: String,
        value: String,
    },
    Unset {
        scope: WriteScope,
        key: String,
    },
}

fn validate_key(key: &str) -> Result<(), String> {
    if !is_known_config_key(key) {
        return Err(format!(
            "Unknown config key '{key}'. Known keys: {}.",
            known_config_keys().join(", ")
        ));
    }
    Ok(())
}

/// Returns the full `climon config --help` text, embedding the settings help.
/// Byte-identical to the TS `configHelpText`.
pub fn config_help_text() -> String {
    format!(
        "climon config — inspect and update climon configuration

Usage:
  climon config <key>              Get the value of a config setting
  climon config <key> <value>      Set a config setting
  climon config --unset <key>      Remove a config setting
  climon config --list             List all set configuration values
  climon config --debug            Show config files, keys, and values (redacted) in resolution order
  climon config --purge            Delete config files from cwd ancestry and $CLIMON_HOME
  climon config --help             Show this help

Scope (where the setting is written):
  --local      Write to the nearest .climon/config.jsonc (repository-specific)
  --global     Write to $CLIMON_HOME/config.jsonc (user-wide default)
  (no scope)   Automatically choose --local if a .climon/ directory exists nearby,
               otherwise --global

Configuration files and cascade:
  climon uses config.jsonc as the canonical filename. Legacy config.json files
  are automatically migrated to config.jsonc (with comments) when you run a set
  operation. The original file is backed up as config.json.bak.

  Config resolution checks local .climon/config.jsonc files from the current
  working directory upward, then falls back to the global $CLIMON_HOME/config.jsonc.
  Settings from more specific (local) files override global ones.

  Use climon config --purge to walk the same cascade, prompting before deleting
  each existing config.jsonc or legacy config.json file. Declining a prompt stops
  the purge without checking later files.

Settings:

{}
",
        render_config_settings_help()
    )
}

/// Parses the `climon config` argv. Mirrors `parseConfigArgs`. Returns an error
/// string for invalid combinations (the caller maps it to exit code 2).
pub fn parse_config_args(argv: &[String]) -> Result<ConfigAction, String> {
    let mut scope = WriteScope::Auto;
    let mut debug = false;
    let mut purge = false;
    let mut list = false;
    let mut unset = false;
    let mut help = false;
    let mut positional: Vec<String> = Vec::new();
    for arg in argv {
        match arg.as_str() {
            "--global" => scope = WriteScope::Global,
            "--local" => scope = WriteScope::Local,
            "--debug" => debug = true,
            "--purge" => purge = true,
            "--list" | "-l" => list = true,
            "--unset" => unset = true,
            "--help" | "-h" => help = true,
            other => positional.push(other.to_string()),
        }
    }

    if help {
        if scope != WriteScope::Auto || debug || purge || list || unset || !positional.is_empty() {
            return Err("Use `climon config --help` without other config arguments.".to_string());
        }
        return Ok(ConfigAction::Help);
    }
    if debug {
        if purge || list || unset || !positional.is_empty() {
            return Err("Use `climon config --debug` without other config arguments.".to_string());
        }
        return Ok(ConfigAction::Debug);
    }
    if purge {
        if scope != WriteScope::Auto || list || unset || !positional.is_empty() {
            return Err("Use `climon config --purge` without other config arguments.".to_string());
        }
        return Ok(ConfigAction::Purge);
    }
    if list {
        return Ok(ConfigAction::List { scope });
    }
    if unset {
        let key = positional
            .first()
            .ok_or("Provide a key to unset, e.g. `climon config --unset remote.enabled`.")?;
        validate_key(key)?;
        return Ok(ConfigAction::Unset {
            scope,
            key: key.clone(),
        });
    }

    let key = positional
        .first()
        .ok_or("Provide a key, e.g. `climon config remote.tunnelId`.")?;
    validate_key(key)?;
    match positional.get(1) {
        None => Ok(ConfigAction::Get {
            scope,
            key: key.clone(),
        }),
        Some(value) => {
            // Validate type eagerly so errors surface before any write.
            coerce_config_value(key, value)?;
            Ok(ConfigAction::Set {
                scope,
                key: key.clone(),
                value: value.clone(),
            })
        }
    }
}

/// JS `String(value)` coercion for printing config values.
fn js_string_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// Renders a config value for `list`/`get`, redacting sensitive or unknown keys
/// to the documented `[REDACTED]` token.
fn display_config_value(key: &str, value: &Value) -> String {
    match find_config_setting(key) {
        Some(setting) if !setting.sensitive => js_string_value(value),
        _ => "[REDACTED]".to_string(),
    }
}

/// IO sinks for [`run_config_command`], allowing tests to capture output and
/// drive the purge confirmation.
pub struct ConfigCommandIo<'a> {
    pub stdout: &'a mut dyn Write,
    pub stderr: &'a mut dyn Write,
    pub confirm: &'a mut dyn FnMut(&str) -> bool,
}

/// Runs the `climon config` command. Mirrors `runConfigCommand`. Exit codes:
/// parse error → 2, get-miss → 1, runtime error → 2.
pub fn run_config_command(
    argv: &[String],
    env: &Env,
    cwd: &Path,
    io: &mut ConfigCommandIo<'_>,
) -> i32 {
    let action = match parse_config_args(argv) {
        Ok(a) => a,
        Err(msg) => {
            let _ = writeln!(io.stderr, "climon config: {msg}");
            return 2;
        }
    };

    match run_action(action, env, cwd, io) {
        Ok(code) => code,
        Err(msg) => {
            let _ = writeln!(io.stderr, "climon config: {msg}");
            2
        }
    }
}

fn run_action(
    action: ConfigAction,
    env: &Env,
    cwd: &Path,
    io: &mut ConfigCommandIo<'_>,
) -> Result<i32, String> {
    match action {
        ConfigAction::Help => {
            let _ = io.stdout.write_all(config_help_text().as_bytes());
            Ok(0)
        }
        ConfigAction::Debug => {
            let mut lines: Vec<String> = Vec::new();
            for entry in list_config_debug_entries(env, cwd) {
                lines.push(entry.path.to_string_lossy().into_owned());
                if !entry.exists {
                    lines.push("  (missing)".to_string());
                } else if let Some(err) = &entry.error {
                    lines.push(format!("  (error: {err})"));
                } else if entry.keys.is_empty() {
                    lines.push("  (no keys)".to_string());
                } else {
                    for k in &entry.keys {
                        lines.push(format!("  {} = {}", k.key, k.value));
                    }
                }
            }
            let _ = writeln!(io.stdout, "{}", lines.join("\n"));
            Ok(0)
        }
        ConfigAction::Purge => {
            let files = list_existing_config_files(env, cwd);
            if files.is_empty() {
                let _ = io.stdout.write_all(b"No climon config files found.\n");
                return Ok(0);
            }
            for file in files {
                let path = file.to_string_lossy().into_owned();
                let _ = write!(io.stdout, "Delete {path}? [y/N] ");
                if !(io.confirm)(&path) {
                    let _ = io.stdout.write_all(b"\n");
                    let _ = io.stdout.write_all(b"Purge cancelled.\n");
                    return Ok(0);
                }
                let _ = io.stdout.write_all(b"\n");
                std::fs::remove_file(&file).map_err(|e| e.to_string())?;
                let _ = writeln!(io.stdout, "Deleted {path}");
            }
            Ok(0)
        }
        ConfigAction::List { .. } => {
            let mut lines: Vec<String> = Vec::new();
            for key in known_config_keys() {
                if let Some(value) = resolve_config_setting(&key, env, cwd) {
                    lines.push(format!("{key}={}", display_config_value(&key, &value)));
                }
            }
            if !lines.is_empty() {
                let _ = writeln!(io.stdout, "{}", lines.join("\n"));
            }
            Ok(0)
        }
        ConfigAction::Get { key, .. } => match resolve_config_setting(&key, env, cwd) {
            None => Ok(1),
            Some(value) => {
                let _ = writeln!(io.stdout, "{}", display_config_value(&key, &value));
                Ok(0)
            }
        },
        ConfigAction::Set { scope, key, value } => {
            if should_warn_global_only_local_write(&key, scope) {
                let _ = writeln!(
                    io.stderr,
                    "climon config: {key} is global-only; the local value will not be read. Use --global to set the effective value."
                );
            }
            write_config_setting(&key, &value, scope, env, cwd)?;
            if let Some(flag) = parse_feature_config_key(&key) {
                if is_feature_locked(flag) {
                    let _ = writeln!(
                        io.stderr,
                        "climon config: {key} is overridden by this build and locked; your value has no effect until the override is removed."
                    );
                }
                if value == "enabled" {
                    if let Ok(status) = feature_status(flag) {
                        if status != FeatureStatus::Ready {
                            let _ = writeln!(
                                io.stderr,
                                "climon config: {key} is marked \"{}\" and may be unstable or incomplete; enabling it is not recommended for normal use.",
                                status.as_str()
                            );
                        }
                    }
                }
            }
            Ok(0)
        }
        ConfigAction::Unset { scope, key } => {
            unset_config_setting(&key, scope, env, cwd)?;
            Ok(0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(prefix: &str) -> Self {
            let mut base = std::env::current_dir().unwrap();
            base.push(".copilot-tmp");
            fs::create_dir_all(&base).unwrap();
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = base.join(format!("{prefix}-{nonce}"));
            fs::create_dir_all(&path).unwrap();
            TestDir { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn test_root(name: &str) -> PathBuf {
        let rust_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("climon-cli lives under rust/")
            .to_path_buf();
        let unique = format!(
            "{}-{}-{}-{}",
            name,
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time after epoch")
                .as_nanos()
        );
        rust_dir
            .join("target")
            .join("config-cmd-tests")
            .join(unique)
    }

    fn write_global_config(root: &Path, jsonc: &str) -> (Env, PathBuf) {
        let home = root.join("home");
        let climon_home = root.join("climon-home");
        let cwd = home.join("cwd");
        fs::create_dir_all(&home).expect("create home");
        fs::create_dir_all(&climon_home).expect("create climon home");
        fs::create_dir_all(&cwd).expect("create cwd");
        fs::write(climon_home.join("config.jsonc"), jsonc).expect("write global config");
        let env = Env::new(Some(climon_home.to_str().expect("utf-8 climon home")), home);
        (env, cwd)
    }

    fn run_config_capture(argv: &[&str], env: &Env, cwd: &Path) -> (i32, String, String) {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        fn no_confirm(_: &str) -> bool {
            false
        }
        let mut confirm = no_confirm;
        let mut io = ConfigCommandIo {
            stdout: &mut stdout,
            stderr: &mut stderr,
            confirm: &mut confirm,
        };
        let code = run_config_command(&v(argv), env, cwd, &mut io);
        (
            code,
            String::from_utf8(stdout).expect("stdout is utf-8"),
            String::from_utf8(stderr).expect("stderr is utf-8"),
        )
    }
    }

    #[test]
    fn parses_help() {
        assert_eq!(parse_config_args(&v(&["--help"])), Ok(ConfigAction::Help));
        assert_eq!(parse_config_args(&v(&["-h"])), Ok(ConfigAction::Help));
    }

    #[test]
    fn help_with_other_args_errors() {
        assert!(parse_config_args(&v(&["--help", "--debug"])).is_err());
    }

    #[test]
    fn parses_debug_and_purge() {
        assert_eq!(parse_config_args(&v(&["--debug"])), Ok(ConfigAction::Debug));
        assert_eq!(parse_config_args(&v(&["--purge"])), Ok(ConfigAction::Purge));
    }

    #[test]
    fn parses_list_with_scope() {
        assert_eq!(
            parse_config_args(&v(&["--list", "--global"])),
            Ok(ConfigAction::List {
                scope: WriteScope::Global
            })
        );
    }

    #[test]
    fn parses_get_and_set() {
        assert_eq!(
            parse_config_args(&v(&["remote.host"])),
            Ok(ConfigAction::Get {
                scope: WriteScope::Auto,
                key: "remote.host".to_string()
            })
        );
        assert_eq!(
            parse_config_args(&v(&["--global", "remote.host", "h"])),
            Ok(ConfigAction::Set {
                scope: WriteScope::Global,
                key: "remote.host".to_string(),
                value: "h".to_string()
            })
        );
    }

    #[test]
    fn parses_unset() {
        assert_eq!(
            parse_config_args(&v(&["--unset", "remote.enabled"])),
            Ok(ConfigAction::Unset {
                scope: WriteScope::Auto,
                key: "remote.enabled".to_string()
            })
        );
    }

    #[test]
    fn unknown_key_errors() {
        assert!(parse_config_args(&v(&["not.a.key"])).is_err());
        assert!(parse_config_args(&v(&["not.a.key", "x"])).is_err());
    }

    #[test]
    fn list_redacts_sensitive_values() {
        let root = test_root("list-redacts-sensitive-values");
        let (env, cwd) = write_global_config(
            &root,
            r#"{"remote":{"enabled":true,"spawnSecret":"S3CR3T-do-not-leak"}}"#,
        );

        let (code, out, err) = run_config_capture(&["--list"], &env, &cwd);

        assert_eq!(code, 0);
        assert_eq!(err, "");
        assert!(!out.contains("S3CR3T-do-not-leak"));
        assert!(out.contains("remote.enabled=true"));
        assert!(out.contains("remote.spawnSecret=[REDACTED]"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn get_redacts_sensitive_value() {
        let root = test_root("get-redacts-sensitive-value");
        let (env, cwd) =
            write_global_config(&root, r#"{"remote":{"spawnSecret":"S3CR3T-do-not-leak"}}"#);

        let (code, out, err) = run_config_capture(&["remote.spawnSecret"], &env, &cwd);

        assert_eq!(code, 0);
        assert_eq!(err, "");
        assert_eq!(out, "[REDACTED]\n");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn get_prints_non_sensitive_value() {
        let root = test_root("get-prints-non-sensitive-value");
        let (env, cwd) = write_global_config(&root, r#"{"session":{"priority":250}}"#);

        let (code, out, err) = run_config_capture(&["session.priority"], &env, &cwd);

        assert_eq!(code, 0);
        assert_eq!(err, "");
        assert_eq!(out, "250\n");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn display_config_value_redacts_unknown_keys() {
        assert_eq!(
            display_config_value("not.a.real.key", &Value::String("secret".to_string())),
            "[REDACTED]"
        );
    }

    #[test]
    fn missing_key_errors() {
        assert!(parse_config_args(&v(&[])).is_err());
        assert!(parse_config_args(&v(&["--unset"])).is_err());
    }

    #[test]
    fn config_help_text_embeds_settings() {
        let text = config_help_text();
        assert!(text.starts_with("climon config — inspect and update climon configuration"));
        assert!(text.contains("Settings:\n\n"));
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn set_warns_when_explicit_local_targets_global_only_key() {
        let t = TestDir::new("cfgcmd-global-only-local");
        let home = t.path().join("home").join(".climon");
        let repo = t.path().join("repo");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(repo.join(".climon")).unwrap();
        fs::write(
            home.join("config.jsonc"),
            r#"{"session":{"terminalProgram":"safe {cmd}"}}"#,
        )
        .unwrap();
        fs::write(repo.join(".climon").join("config.jsonc"), "{}").unwrap();

        let env = Env::new(Some(home.to_str().unwrap()), t.path().join("home"));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut confirm = |_path: &str| false;
        let mut io = ConfigCommandIo {
            stdout: &mut stdout,
            stderr: &mut stderr,
            confirm: &mut confirm,
        };

        let code = run_config_command(
            &v(&["--local", "session.terminalProgram", "dead-local {cmd}"]),
            &env,
            &repo,
            &mut io,
        );

        assert_eq!(code, 0);
        let warning = String::from_utf8(stderr).unwrap();
        assert!(warning.contains(
            "climon config: session.terminalProgram is global-only; the local value will not be read. Use --global to set the effective value."
        ));
        assert!(
            fs::read_to_string(repo.join(".climon").join("config.jsonc"))
                .unwrap()
                .contains("dead-local {cmd}")
        );
        assert_eq!(
            resolve_config_setting("session.terminalProgram", &env, &repo),
            Some(Value::String("safe {cmd}".to_string()))
        );
    }
}
