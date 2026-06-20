//! Internal `climon __spawn`: the single source of truth for "spawn a session
//! on THIS machine" used by the dashboard server (local) and, in Plan C, the
//! devbox uplink (remote). Headless creates a background session; visible opens
//! a GUI terminal running the normal attached `climon <cmd>`.

use std::path::Path;

use climon_config::config::{resolve_config_setting, Env as ConfigEnv};
use climon_store::Env as StoreEnv;

use crate::args::ColorFlag;
use crate::launcher::{resolve_session_defaults, SessionDefaultFlags};
use crate::spawn::{spawn_headless_session, SessionMetaOptions};
use crate::terminal_launch;

/// A fully-resolved spawn request.
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    pub argv: Vec<String>,
    pub headless: bool,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub name: Option<String>,
    pub color: Option<ColorFlag>,
    pub priority: Option<i64>,
    pub terminal_program: Option<String>,
}

/// The outcome reported to the caller (the server parses this JSON line).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnOutcome {
    pub id: Option<String>,
    pub warning: Option<String>,
}

impl SpawnOutcome {
    pub fn to_json(&self) -> String {
        // Minimal, dependency-free JSON with only the present fields.
        let mut parts: Vec<String> = Vec::new();
        if let Some(id) = &self.id {
            parts.push(format!("\"id\":{}", json_str(id)));
        }
        if let Some(w) = &self.warning {
            parts.push(format!("\"warning\":{}", json_str(w)));
        }
        format!("{{{}}}", parts.join(","))
    }
}

fn json_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Build the inner `climon <flags> <cmd>` string the visible terminal runs.
pub fn build_climon_command(req: &SpawnRequest) -> String {
    let mut parts: Vec<String> = vec!["climon".to_string()];
    if let Some(p) = req.priority {
        parts.push("--priority".into());
        parts.push(p.to_string());
    }
    if let Some(c) = &req.color {
        parts.push("--color".into());
        parts.push(c.wire_name().to_string());
    }
    if let Some(n) = &req.name {
        parts.push("--name".into());
        parts.push(n.clone());
    }
    parts.extend(req.argv.iter().cloned());
    parts.join(" ")
}

/// Pure decision logic with injected effects (testable without real spawns).
pub fn decide_and_run<C, L>(
    req: &SpawnRequest,
    create_headless: C,
    launch_terminal: L,
) -> SpawnOutcome
where
    C: FnOnce(&SpawnRequest) -> Result<String, String>,
    L: FnOnce(&str) -> Result<(), String>,
{
    if req.headless {
        return match create_headless(req) {
            Ok(id) => SpawnOutcome {
                id: Some(id),
                warning: None,
            },
            Err(e) => SpawnOutcome {
                id: None,
                warning: Some(e),
            },
        };
    }
    let cmd = build_climon_command(req);
    match launch_terminal(&cmd) {
        Ok(()) => SpawnOutcome {
            id: None,
            warning: None,
        },
        Err(launch_err) => match create_headless(req) {
            Ok(id) => SpawnOutcome {
                id: Some(id),
                warning: Some(format!("opened headless ({launch_err})")),
            },
            Err(create_err) => SpawnOutcome {
                id: None,
                warning: Some(format!("{launch_err}; {create_err}")),
            },
        },
    }
}

/// Loads `session.terminalProgram` from config, returning `None` when unset or
/// blank.
pub fn resolve_terminal_program() -> Option<String> {
    let config_env = ConfigEnv::real();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    match resolve_config_setting("session.terminalProgram", &config_env, &cwd) {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => Some(s),
        _ => None,
    }
}

/// Entry point dispatched from `main.rs`. Wires the real effects and prints the
/// JSON outcome line. Always exits 0 when the session exists (or is reported);
/// returns a non-zero code only when a headless spawn could not be created.
pub fn run_spawn_command(req: SpawnRequest) -> Result<i32, String> {
    let store_env = StoreEnv::from_env();
    let config_env = ConfigEnv::real();
    let cwd_path = Path::new(&req.cwd).to_path_buf();

    let outcome = decide_and_run(
        &req,
        |r| {
            let defaults = resolve_session_defaults(
                &SessionDefaultFlags {
                    color: r.color,
                    priority: r.priority,
                },
                &store_env,
                &config_env,
                &cwd_path,
            )?;
            spawn_headless_session(
                &r.argv,
                &r.cwd,
                r.cols,
                r.rows,
                SessionMetaOptions {
                    name: r.name.clone(),
                    priority: Some(defaults.priority),
                    color: defaults.color,
                },
                &store_env,
                &config_env,
                &cwd_path,
            )
        },
        |cmd| terminal_launch::launch(&cwd_path, cmd, req.terminal_program.as_deref()),
    );

    println!("{}", outcome.to_json());
    if outcome.id.is_none() && outcome.warning.is_some() && req.headless {
        return Ok(1);
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn req(headless: bool) -> SpawnRequest {
        SpawnRequest {
            argv: vec!["bash".into()],
            headless,
            cwd: "/w".into(),
            cols: 80,
            rows: 24,
            name: Some("n".into()),
            color: None,
            priority: Some(500),
            terminal_program: None,
        }
    }

    #[test]
    fn headless_creates_and_reports_id() {
        let out = decide_and_run(
            &req(true),
            |_r| Ok("sess-1".to_string()),
            |_cmd| panic!("must not launch a terminal in headless mode"),
        );
        assert_eq!(
            out,
            SpawnOutcome {
                id: Some("sess-1".into()),
                warning: None
            }
        );
    }

    #[test]
    fn visible_launches_terminal_and_reports_no_id() {
        let launched = RefCell::new(None);
        let out = decide_and_run(
            &req(false),
            |_r| panic!("must not create headless when the terminal launches"),
            |cmd| {
                *launched.borrow_mut() = Some(cmd.to_string());
                Ok(())
            },
        );
        assert_eq!(
            out,
            SpawnOutcome {
                id: None,
                warning: None
            }
        );
        let cmd = launched.borrow().clone().unwrap();
        assert!(cmd.contains("bash"));
        assert!(cmd.contains("--name"));
    }

    #[test]
    fn visible_falls_back_to_headless_when_no_terminal() {
        let out = decide_and_run(
            &req(false),
            |_r| Ok("sess-2".to_string()),
            |_cmd| Err("no terminal emulator found on this machine".to_string()),
        );
        assert_eq!(out.id.as_deref(), Some("sess-2"));
        assert!(out.warning.unwrap().contains("no terminal"));
    }

    #[test]
    fn outcome_serializes_minimally() {
        assert_eq!(
            SpawnOutcome {
                id: None,
                warning: None
            }
            .to_json(),
            "{}"
        );
        assert_eq!(
            SpawnOutcome {
                id: Some("x".into()),
                warning: None
            }
            .to_json(),
            r#"{"id":"x"}"#
        );
    }
}
