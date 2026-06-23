//! Durable ingest status beacon (`ingest-status.json`). Written by the ingest on
//! every connect/disconnect + heartbeat; read by `climon remotes` and the
//! dashboard server's `GET /api/remotes`. Carries `pid` + `updatedAt` for reader
//! staleness; each connection carries friendly identity + counters.

use std::path::Path;

use climon_config::config::{get_climon_home, Env as ConfigEnv};
use climon_store::atomic::atomic_write;
use serde::{Deserialize, Serialize};

use crate::process::is_process_alive;

pub const INGEST_STATUS_BASENAME: &str = "ingest-status.json";

/// ~2× the heartbeat interval; a status older than this is shown stale.
pub const INGEST_STALE_AFTER_MS: u64 = 30_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestConnectionStatus {
    pub client_id: String,
    pub hostname: String,
    pub os: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    pub connected_at: u64,
    #[serde(default)]
    pub session_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_ping_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestStatus {
    pub pid: u32,
    pub updated_at: u64,
    #[serde(default)]
    pub connections: Vec<IngestConnectionStatus>,
}

pub fn get_ingest_status_path(config_env: &ConfigEnv) -> std::path::PathBuf {
    get_climon_home(config_env).join(INGEST_STATUS_BASENAME)
}

pub fn serialize_ingest_status(status: &IngestStatus) -> String {
    format!("{}\n", serde_json::to_string(status).unwrap())
}

pub fn parse_ingest_status(raw: &str) -> Option<IngestStatus> {
    serde_json::from_str(raw).ok()
}

pub fn write_ingest_status(status: &IngestStatus, config_env: &ConfigEnv) -> std::io::Result<()> {
    let path = get_ingest_status_path(config_env);
    atomic_write(&path, serialize_ingest_status(status).as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn read_ingest_status_from_dir(home_dir: &Path) -> Option<IngestStatus> {
    let raw = std::fs::read_to_string(home_dir.join(INGEST_STATUS_BASENAME)).ok()?;
    parse_ingest_status(&raw)
}

pub fn read_ingest_status(config_env: &ConfigEnv) -> Option<IngestStatus> {
    read_ingest_status_from_dir(&get_climon_home(config_env))
}

/// A status is stale when its writer pid is not alive, or `updated_at` is older
/// than `INGEST_STALE_AFTER_MS` relative to `now_ms`.
pub fn is_ingest_status_stale(
    status: &IngestStatus,
    now_ms: u64,
    is_alive: &dyn Fn(u32) -> bool,
) -> bool {
    if !is_alive(status.pid) {
        return true;
    }
    now_ms.saturating_sub(status.updated_at) > INGEST_STALE_AFTER_MS
}

pub fn is_ingest_status_stale_now(status: &IngestStatus, now_ms: u64) -> bool {
    is_ingest_status_stale(status, now_ms, &is_process_alive)
}

/// A single connection is stale when its `last_ping_at` is older than
/// `INGEST_STALE_AFTER_MS` (or it has never pinged and connected long ago).
pub fn is_connection_stale(conn: &IngestConnectionStatus, now_ms: u64) -> bool {
    let reference = conn.last_ping_at.unwrap_or(conn.connected_at);
    now_ms.saturating_sub(reference) > INGEST_STALE_AFTER_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_for(home: &Path) -> ConfigEnv {
        ConfigEnv::new(Some(home.to_str().unwrap()), home.to_path_buf())
    }

    fn tmp_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "climon-ingest-status-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample() -> IngestStatus {
        IngestStatus {
            pid: std::process::id(),
            updated_at: 1_000_000,
            connections: vec![IngestConnectionStatus {
                client_id: "jacks-devbox".into(),
                hostname: "jacks-devbox".into(),
                os: "linux".into(),
                address: Some("10.0.0.7:51812".into()),
                connected_at: 990_000,
                session_count: 3,
                last_ping_at: Some(999_000),
            }],
        }
    }

    #[test]
    fn write_then_read_roundtrips() {
        let home = tmp_home("rt");
        let env = env_for(&home);
        let status = sample();
        write_ingest_status(&status, &env).unwrap();
        assert_eq!(read_ingest_status(&env), Some(status));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn serializes_with_camel_case_keys() {
        let json = serialize_ingest_status(&sample());
        assert!(json.contains("\"clientId\""));
        assert!(json.contains("\"lastPingAt\""));
        assert!(json.contains("\"sessionCount\""));
    }

    #[test]
    fn malformed_reads_as_absent() {
        assert_eq!(parse_ingest_status("not json"), None);
    }

    #[test]
    fn status_stale_when_pid_dead() {
        let s = sample();
        assert!(is_ingest_status_stale(&s, s.updated_at, &|_| false));
    }

    #[test]
    fn connection_stale_when_no_recent_ping() {
        let s = sample();
        let conn = &s.connections[0];
        let now = conn.last_ping_at.unwrap() + INGEST_STALE_AFTER_MS + 1;
        assert!(is_connection_stale(conn, now));
        assert!(!is_connection_stale(conn, conn.last_ping_at.unwrap() + 1));
    }
}
