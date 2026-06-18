//! Desired tunnel-hosting state (`remote-host.json`). Ports the `RemoteHostState`
//! type and its reader/writer that live in `src/remote/ingest.ts` / `tunnel.ts`,
//! extracted into one module to break the ingest<->ingest-state cycle.

use climon_config::config::{get_remote_host_path, Env as ConfigEnv};
use climon_store::atomic::atomic_write;
use serde::{Deserialize, Serialize};

/// The desired tunnel-hosting state persisted in `~/.climon/remote-host.json`.
/// Mirrors `RemoteHostState`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostState {
    pub tunnel_id: String,
    pub ingest_port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ingest_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_host: Option<bool>,
}

/// Reads the desired tunnel-hosting state, or `None` if absent/malformed.
/// Mirrors `readRemoteHostState`: requires a string `tunnelId` and an integer
/// `ingestPort`.
pub fn read_remote_host_state(config_env: &ConfigEnv) -> Option<RemoteHostState> {
    let raw = std::fs::read_to_string(get_remote_host_path(config_env)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let obj = value.as_object()?;
    let tunnel_id = obj.get("tunnelId")?.as_str()?.to_string();
    let ingest_port_num = obj.get("ingestPort")?.as_f64()?;
    if !ingest_port_num.is_finite() || ingest_port_num.fract() != 0.0 || ingest_port_num <= 0.0 {
        return None;
    }
    let ingest_host = obj
        .get("ingestHost")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let can_host = obj.get("canHost").and_then(|v| v.as_bool());
    Some(RemoteHostState {
        tunnel_id,
        ingest_port: ingest_port_num as u16,
        ingest_host,
        can_host,
    })
}

/// Atomically persists the desired tunnel-hosting state (pretty 2-space JSON +
/// trailing newline), so an `fs.watch` consumer never sees a torn file. Mirrors
/// `writeRemoteHostState` in `tunnel.ts`.
pub fn write_remote_host_state(
    state: &RemoteHostState,
    config_env: &ConfigEnv,
) -> std::io::Result<()> {
    let path = get_remote_host_path(config_env);
    let body = format!("{}\n", serde_json::to_string_pretty(state).unwrap());
    atomic_write(&path, body.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_canhost_and_omits_absent_optionals() {
        let state = RemoteHostState {
            tunnel_id: "abc123".into(),
            ingest_port: 3132,
            ingest_host: None,
            can_host: Some(false),
        };
        let json = serde_json::to_string(&state).unwrap();
        assert_eq!(
            json,
            r#"{"tunnelId":"abc123","ingestPort":3132,"canHost":false}"#
        );
    }
}
