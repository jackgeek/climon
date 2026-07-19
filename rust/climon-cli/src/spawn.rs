//! Detached daemon + headless session spawning. Port of `src/spawn-daemon.ts`
//! and `src/client/spawn-session.ts`.

use std::fs::OpenOptions;
use std::path::Path;
use std::process::{Command, Stdio};

use climon_config::config::{resolve_config_setting, Env as ConfigEnv};
use climon_proto::meta::{AnsiColor, PriorityReason, SessionMeta, SessionStatus};
use climon_session::socket::format_session_socket_ref;
use climon_store::meta::write_session_meta;
use climon_store::paths::{hostname, now_iso};
use climon_store::session_id::generate_session_id;
use climon_store::Env as StoreEnv;

use crate::self_spawn::self_spawn_args;
use crate::version::VERSION;

/// Coerces an arbitrary string into a valid clientId. Mirrors `sanitizeClientId`
/// (minus the random fallback's exact bytes; a non-empty sanitized hostname
/// always wins in practice).
pub fn sanitize_client_id(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    let sliced: String = trimmed.chars().take(64).collect();
    if sliced.is_empty() {
        format!("dev-{:010x}", std::process::id())
    } else {
        sliced
    }
}

/// Resolves this machine's clientId: configured `remote.clientId` or the
/// sanitised hostname. Mirrors `resolveClientId`.
pub fn resolve_client_id(config_env: &ConfigEnv, cwd: &Path) -> String {
    if let Some(serde_json::Value::String(s)) =
        resolve_config_setting("remote.clientId", config_env, cwd)
    {
        if !s.is_empty() {
            return s;
        }
    }
    sanitize_client_id(&hostname())
}

/// Spawns a detached per-session daemon (`climon __session <id>`) that owns the
/// PTY and survives the launcher. Its raw stdio is redirected to
/// `<sessionsDir>/<id>.log` (append). Mirrors `spawnDaemon`.
pub fn spawn_daemon(id: &str, store_env: &StoreEnv) -> std::io::Result<()> {
    let log_path = store_env.sessions_dir().join(format!("{id}.log"));
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let log_err = log.try_clone()?;

    let exe = std::env::current_exe()?;
    let args = self_spawn_args(&["__session".to_string(), id.to_string()], None);

    let mut cmd = Command::new(exe);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                // Detach from the launcher's process group / controlling tty so
                // the daemon survives the launcher exiting.
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
    }

    // Prevent the child from inheriting the parent's stdout/stderr pipe
    // handles, which would keep the pipe open and block EOF on the read end.
    let _guard = climon_update::win_inherit_guard::StdInheritGuard::new()?;
    cmd.spawn()?;
    Ok(())
}

/// Options for a new monitored session. Mirrors `SessionMetaOptions`.
#[derive(Debug, Clone, Default)]
pub struct SessionMetaOptions {
    pub name: Option<String>,
    pub priority: Option<u16>,
    pub color: Option<AnsiColor>,
    pub theme: Option<String>,
}

/// Creates a new monitored session that runs without a local terminal attached:
/// writes its metadata and spawns a detached daemon. Returns the new session id.
/// Mirrors `spawnHeadlessSession`.
#[allow(clippy::too_many_arguments)]
pub fn spawn_headless_session(
    command: &[String],
    cwd: &str,
    cols: u16,
    rows: u16,
    options: SessionMetaOptions,
    store_env: &StoreEnv,
    config_env: &ConfigEnv,
    config_cwd: &Path,
) -> Result<String, String> {
    if command.is_empty() {
        return Err("Provide a command to monitor, e.g. `climon copilot`.".to_string());
    }
    let id = generate_session_id(store_env).map_err(|e| e.to_string())?;
    let now = now_iso();
    let meta = SessionMeta {
        id: id.clone(),
        command: command.to_vec(),
        display_command: command.join(" "),
        cwd: cwd.to_string(),
        status: SessionStatus::Running,
        priority_reason: PriorityReason::Running,
        daemon_pid: None,
        cols: cols.max(1),
        rows: rows.max(1),
        headless: Some(true),
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
        client_label: Some(resolve_client_id(config_env, config_cwd)),
        name: options.name,
        priority: options.priority,
        color: options.color.map(Some),
        theme: options.theme,
        user_paused: None,
        terminal_title: None,
        attention_snippet: None,
        progress: None,
    };
    write_session_meta(store_env, &meta).map_err(|e| e.to_string())?;
    spawn_daemon(&id, store_env).map_err(|e| e.to_string())?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_client_id_cleans_and_trims() {
        assert_eq!(sanitize_client_id("my host!"), "my-host");
        assert_eq!(sanitize_client_id("--keep.me_1--"), "keep.me_1");
        assert!(sanitize_client_id("***").starts_with("dev-"));
    }
}
