//! devtunnel CLI detection/management. Port of `src/remote/tunnel.ts`.
//!
//! External-tool invocations (`devtunnel ...`) go through an injectable
//! [`Runner`] so they are unit-testable without the real CLI. Real-CLI paths are
//! `#[ignore]`d.

use std::collections::HashMap;

use climon_config::config::{get_remote_host_path, Env as ConfigEnv};

use crate::devtunnel::gateway::{CreateTunnelArgs, DevtunnelGateway, DevtunnelGatewayDeps};
use crate::devtunnel::{
    classify_failure, DevtunnelFailure, DevtunnelFailureInput, DevtunnelOperation,
};
use crate::remote_host::{read_remote_host_state, write_remote_host_state, RemoteHostState};

pub use crate::devtunnel::gateway::{devtunnel_env, RunResult, Runner};

/// devtunnel service tunnel-id rules.
fn is_tunnel_id(candidate: &str) -> bool {
    let bytes = candidate.as_bytes();
    let len = bytes.len();
    // ^[a-z0-9][a-z0-9-]{1,47}[a-z0-9]$  => total length 3..=49
    if !(3..=49).contains(&len) {
        return false;
    }
    let is_lower_alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let is_mid = |b: u8| is_lower_alnum(b) || b == b'-';
    if !is_lower_alnum(bytes[0]) || !is_lower_alnum(bytes[len - 1]) {
        return false;
    }
    bytes[1..len - 1].iter().all(|&b| is_mid(b))
}

/// Extracts a tunnel id from a bare id or a
/// `https://<id>-<port>.<region>.devtunnels.ms/` URL. Mirrors `parseTunnelInput`.
pub fn parse_tunnel_input(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = parse_url_tunnel_id(trimmed).unwrap_or_else(|| trimmed.to_string());
    if is_tunnel_id(&candidate) {
        Some(candidate)
    } else {
        None
    }
}

/// Matches `^https?://([a-z0-9][a-z0-9-]{1,47}[a-z0-9])-\d+\.[^/]*devtunnels\.ms`
/// case-insensitively and returns the captured id (lower-cased as the regex is
/// case-insensitive but ids are lowercase).
fn parse_url_tunnel_id(input: &str) -> Option<String> {
    let lower = input.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))?;
    // host is up to the first '/'
    let host = rest.split('/').next()?;
    if !host.contains("devtunnels.ms") {
        return None;
    }
    // <id>-<port>.<region>...devtunnels.ms
    let first_dot = host.find('.')?;
    let left = &host[..first_dot]; // <id>-<port>
    let dash = left.rfind('-')?;
    let id = &left[..dash];
    let port = &left[dash + 1..];
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if is_tunnel_id(id) {
        Some(id.to_string())
    } else {
        None
    }
}

/// Result of [`detect_devtunnel`]. Mirrors `DetectResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectResult {
    pub available: bool,
    pub version: Option<String>,
}

/// Confirms the `devtunnel` CLI is present and runnable. Mirrors `detectDevtunnel`.
pub async fn detect_devtunnel(runner: &Runner) -> DetectResult {
    let res = runner("devtunnel".to_string(), vec!["--version".to_string()]).await;
    if res.status != 0 {
        return DetectResult {
            available: false,
            version: None,
        };
    }
    let trimmed = res.stdout.trim();
    DetectResult {
        available: true,
        version: if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        },
    }
}

/// User-supplied tunnel coordinates. Mirrors `ManualTunnelInput`.
pub struct ManualTunnelInput {
    pub tunnel_id: String,
    pub ingest_port: u16,
}

/// Records a user-supplied tunnel as the desired hosting state. Mirrors
/// `useManualTunnel`.
pub fn use_manual_tunnel(
    input: ManualTunnelInput,
    devtunnel_available: bool,
    env: &ConfigEnv,
) -> std::io::Result<RemoteHostState> {
    let state = RemoteHostState {
        tunnel_id: input.tunnel_id,
        ingest_port: input.ingest_port,
        ingest_host: None,
        can_host: Some(devtunnel_available),
    };
    write_remote_host_state(&state, env)?;
    Ok(state)
}

/// Builds a gateway that routes through the provided injectable [`Runner`] while
/// using the process environment for the disable guard and spawner.
fn gateway_from_runner(runner: &Runner) -> DevtunnelGateway {
    DevtunnelGateway::with_deps(DevtunnelGatewayDeps {
        runner: Some(runner.clone()),
        env: Some(std::env::vars().collect::<HashMap<String, String>>()),
        ..Default::default()
    })
}

/// Builds a `DevtunnelFailure` for a local (non-CLI) error such as failing to
/// persist `remote-host.json`, so the typed error surface stays uniform.
fn local_failure(operation: DevtunnelOperation, message: String) -> DevtunnelFailure {
    classify_failure(
        &DevtunnelFailureInput {
            operation,
            status: 1,
            stdout: String::new(),
            stderr: message,
            spawn_error: None,
            parse_failed: None,
        },
        &climon_store::paths::now_iso(),
    )
}

/// Auto-creates a tunnel and a port mapping, then records it as the desired
/// hosting state. Mirrors `createTunnel`.
#[allow(clippy::result_large_err)]
pub async fn create_tunnel(
    ingest_port: u16,
    env: &ConfigEnv,
    runner: &Runner,
) -> Result<RemoteHostState, DevtunnelFailure> {
    let gateway = gateway_from_runner(runner);
    let create = gateway.create_tunnel(&CreateTunnelArgs::default()).await?;
    let tunnel_id = parse_tunnel_id(&create.stdout).ok_or_else(|| {
        classify_failure(
            &DevtunnelFailureInput {
                operation: DevtunnelOperation::CreateTunnel,
                status: create.status,
                stdout: create.stdout.clone(),
                stderr: create.stderr.clone(),
                spawn_error: None,
                parse_failed: Some(true),
            },
            &climon_store::paths::now_iso(),
        )
    })?;

    gateway.create_port(&tunnel_id, ingest_port, None).await?;

    let state = RemoteHostState {
        tunnel_id,
        ingest_port,
        ingest_host: None,
        can_host: Some(true),
    };
    write_remote_host_state(&state, env)
        .map_err(|e| local_failure(DevtunnelOperation::CreateTunnel, e.to_string()))?;
    Ok(state)
}

/// Tears down the recorded tunnel and removes the desired-state file. Mirrors
/// `deleteTunnel`.
pub async fn delete_tunnel(env: &ConfigEnv, runner: &Runner) -> std::io::Result<()> {
    let state = read_remote_host_state(env);
    if let Some(state) = &state {
        if state.can_host == Some(true) {
            let gateway = gateway_from_runner(runner);
            let _ = gateway.delete_tunnel(&state.tunnel_id, false).await;
        }
    }
    let path = get_remote_host_path(env);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Result of [`reconcile_tunnel_port`]. Mirrors `ReconcileResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileResult {
    pub changed: bool,
    pub port: u16,
    pub recreated: bool,
}

/// Ensures the tunnel's port mapping matches the ingest's actual bound port.
/// Mirrors `reconcileTunnelPort`. Only a `TunnelNotFound` failure permits
/// recreating the tunnel; any other classified failure is propagated and no
/// success-shaped state is persisted.
#[allow(clippy::result_large_err)]
pub async fn reconcile_tunnel_port(
    actual_port: u16,
    env: &ConfigEnv,
    runner: &Runner,
) -> Result<ReconcileResult, DevtunnelFailure> {
    let state = match read_remote_host_state(env) {
        Some(state) => state,
        None => {
            return Ok(ReconcileResult {
                changed: false,
                port: actual_port,
                recreated: false,
            })
        }
    };
    if state.ingest_port == actual_port {
        return Ok(ReconcileResult {
            changed: false,
            port: actual_port,
            recreated: false,
        });
    }

    if state.can_host == Some(true) {
        let gateway = gateway_from_runner(runner);
        let _ = gateway
            .delete_port(&state.tunnel_id, state.ingest_port)
            .await;
        if let Err(failure) = gateway
            .create_port(&state.tunnel_id, actual_port, None)
            .await
        {
            if failure.code == crate::devtunnel::DevtunnelErrorCode::TunnelNotFound {
                let fresh = create_tunnel(actual_port, env, runner).await?;
                return Ok(ReconcileResult {
                    changed: true,
                    port: fresh.ingest_port,
                    recreated: true,
                });
            }
            return Err(failure);
        }
    }

    let updated = RemoteHostState {
        ingest_port: actual_port,
        ..state
    };
    write_remote_host_state(&updated, env)
        .map_err(|e| local_failure(DevtunnelOperation::CreatePort, e.to_string()))?;
    Ok(ReconcileResult {
        changed: true,
        port: actual_port,
        recreated: false,
    })
}

fn parse_tunnel_id(stdout: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout) {
        if let Some(id) = value.get("tunnelId").and_then(|v| v.as_str()) {
            return Some(id.to_string());
        }
        if let Some(id) = value
            .get("tunnel")
            .and_then(|t| t.get("tunnelId"))
            .and_then(|v| v.as_str())
        {
            return Some(id.to_string());
        }
        return None;
    }
    // Fallback: first run of 6+ alphanumerics.
    let bytes = stdout.as_bytes();
    let mut start = None;
    for (i, &b) in bytes.iter().enumerate() {
        if b.is_ascii_alphanumeric() {
            if start.is_none() {
                start = Some(i);
            }
        } else if let Some(s) = start.take() {
            if i - s >= 6 {
                return Some(stdout[s..i].to_string());
            }
        }
    }
    if let Some(s) = start {
        if bytes.len() - s >= 6 {
            return Some(stdout[s..].to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn ok_runner() -> Runner {
        Arc::new(|_cmd, _args| {
            Box::pin(async {
                RunResult {
                    status: 0,
                    stdout: String::new(),
                    stderr: String::new(),
                    spawn_error: None,
                }
            })
        })
    }

    #[test]
    fn parse_extracts_id_from_a_devtunnels_url() {
        assert_eq!(
            parse_tunnel_input("https://abc123-6666.usw2.devtunnels.ms/"),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn parse_passes_a_bare_id_through() {
        assert_eq!(parse_tunnel_input("abc123"), Some("abc123".to_string()));
    }

    #[test]
    fn parse_matches_service_tunnel_id_rules() {
        assert_eq!(
            parse_tunnel_input("climon-tunnel"),
            Some("climon-tunnel".to_string())
        );
        assert_eq!(
            parse_tunnel_input("https://climon-tunnel-8080.usw2.devtunnels.ms/"),
            Some("climon-tunnel".to_string())
        );
        assert_eq!(parse_tunnel_input("CLIMON_TUNNEL"), None);
        assert_eq!(parse_tunnel_input("UpperCase"), None);
        assert_eq!(parse_tunnel_input("-starts-with-hyphen"), None);
        assert_eq!(parse_tunnel_input("ends-with-hyphen-"), None);
    }

    #[test]
    fn parse_rejects_junk() {
        assert_eq!(parse_tunnel_input(""), None);
        assert_eq!(parse_tunnel_input("has spaces"), None);
    }

    #[tokio::test]
    async fn use_manual_tunnel_persists_remote_host_json() {
        let dir = std::env::temp_dir().join(format!(
            "climon-tunnel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let env = ConfigEnv::new(Some(dir.to_str().unwrap()), &dir);
        use_manual_tunnel(
            ManualTunnelInput {
                tunnel_id: "abc123".to_string(),
                ingest_port: 3132,
            },
            false,
            &env,
        )
        .unwrap();
        let raw = std::fs::read_to_string(get_remote_host_path(&env)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value.get("tunnelId").unwrap(), "abc123");
        assert_eq!(value.get("ingestPort").unwrap(), 3132);
        assert_eq!(value.get("canHost").unwrap(), false);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn delete_tunnel_removes_remote_host_json() {
        let dir = std::env::temp_dir().join(format!(
            "climon-tunnel-del-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let env = ConfigEnv::new(Some(dir.to_str().unwrap()), &dir);
        use_manual_tunnel(
            ManualTunnelInput {
                tunnel_id: "abc123".to_string(),
                ingest_port: 3132,
            },
            true,
            &env,
        )
        .unwrap();
        delete_tunnel(&env, &ok_runner()).await.unwrap();
        assert!(!get_remote_host_path(&env).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn detect_devtunnel_reports_version() {
        let runner: Runner = Arc::new(|_cmd, _args| {
            Box::pin(async {
                RunResult {
                    status: 0,
                    stdout: "1.0.1234\n".to_string(),
                    stderr: String::new(),
                    spawn_error: None,
                }
            })
        });
        let res = detect_devtunnel(&runner).await;
        assert!(res.available);
        assert_eq!(res.version, Some("1.0.1234".to_string()));
    }

    #[tokio::test]
    async fn detect_devtunnel_reports_unavailable() {
        let runner: Runner = Arc::new(|_cmd, _args| {
            Box::pin(async {
                RunResult {
                    status: 127,
                    stdout: String::new(),
                    stderr: "spawn failed".to_string(),
                    spawn_error: None,
                }
            })
        });
        let res = detect_devtunnel(&runner).await;
        assert!(!res.available);
        assert_eq!(res.version, None);
    }

    #[test]
    fn parse_tunnel_id_reads_json_and_fallback() {
        assert_eq!(
            parse_tunnel_id(r#"{"tunnelId":"abc123def"}"#),
            Some("abc123def".to_string())
        );
        assert_eq!(
            parse_tunnel_id(r#"{"tunnel":{"tunnelId":"nested12"}}"#),
            Some("nested12".to_string())
        );
        assert_eq!(
            parse_tunnel_id("id: abcdef123 ok"),
            Some("abcdef123".to_string())
        );
    }
}
