//! Durable uplink status beacon (`uplink-status.json`). Written by the uplink
//! supervisor on state change + heartbeat; read by `climon remotes`. Carries
//! `pid` + `updatedAt` so readers derive staleness (pid dead or stale ts).

use std::path::Path;

use climon_config::config::{get_climon_home, Env as ConfigEnv};
use climon_store::atomic::atomic_write;
use serde::{Deserialize, Serialize};

use crate::process::is_process_alive;

pub const UPLINK_STATUS_BASENAME: &str = "uplink-status.json";

/// ~2× the heartbeat interval; a status older than this is shown stale.
pub const UPLINK_STALE_AFTER_MS: u64 = 30_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UplinkTarget {
    pub kind: String, // "peer" | "tunnel" | "direct"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UplinkStatus {
    pub pid: u32,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<UplinkTarget>,
    pub state: String, // "connecting" | "connected" | "reconnecting" | "disconnected"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected_at: Option<u64>,
    #[serde(default)]
    pub session_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

pub fn get_uplink_status_path(config_env: &ConfigEnv) -> std::path::PathBuf {
    get_climon_home(config_env).join(UPLINK_STATUS_BASENAME)
}

pub fn serialize_uplink_status(status: &UplinkStatus) -> String {
    format!("{}\n", serde_json::to_string(status).unwrap())
}

pub fn parse_uplink_status(raw: &str) -> Option<UplinkStatus> {
    serde_json::from_str(raw).ok()
}

pub fn write_uplink_status(status: &UplinkStatus, config_env: &ConfigEnv) -> std::io::Result<()> {
    atomic_write(
        &get_uplink_status_path(config_env),
        serialize_uplink_status(status).as_bytes(),
    )
}

pub fn read_uplink_status_from_dir(home_dir: &Path) -> Option<UplinkStatus> {
    let raw = std::fs::read_to_string(home_dir.join(UPLINK_STATUS_BASENAME)).ok()?;
    parse_uplink_status(&raw)
}

pub fn read_uplink_status(config_env: &ConfigEnv) -> Option<UplinkStatus> {
    read_uplink_status_from_dir(&get_climon_home(config_env))
}

/// A status is stale when its writer pid is not alive, or `updated_at` is older
/// than `UPLINK_STALE_AFTER_MS` relative to `now_ms`. `is_alive` is injectable.
pub fn is_uplink_status_stale(
    status: &UplinkStatus,
    now_ms: u64,
    is_alive: &dyn Fn(u32) -> bool,
) -> bool {
    if !is_alive(status.pid) {
        return true;
    }
    now_ms.saturating_sub(status.updated_at) > UPLINK_STALE_AFTER_MS
}

/// Convenience wrapper using the real liveness check.
pub fn is_uplink_status_stale_now(status: &UplinkStatus, now_ms: u64) -> bool {
    is_uplink_status_stale(status, now_ms, &is_process_alive)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_for(home: &Path) -> ConfigEnv {
        ConfigEnv::new(Some(home.to_str().unwrap()), home.to_path_buf())
    }

    fn tmp_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "climon-uplink-status-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample() -> UplinkStatus {
        UplinkStatus {
            pid: std::process::id(),
            updated_at: 1_000_000,
            target: Some(UplinkTarget {
                kind: "tunnel".into(),
                host: Some("127.0.0.1".into()),
                port: Some(3132),
                tunnel_id: Some("abc".into()),
                url: Some("http://abc.devtunnels.ms".into()),
            }),
            state: "connected".into(),
            connected_at: Some(900_000),
            session_count: 3,
            last_error: None,
        }
    }

    #[test]
    fn write_then_read_roundtrips() {
        let home = tmp_home("rt");
        let env = env_for(&home);
        let status = sample();
        write_uplink_status(&status, &env).unwrap();
        assert_eq!(read_uplink_status(&env), Some(status));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn serializes_with_camel_case_keys() {
        let json = serialize_uplink_status(&sample());
        assert!(json.contains("\"updatedAt\""));
        assert!(json.contains("\"sessionCount\""));
        assert!(json.contains("\"tunnelId\""));
    }

    #[test]
    fn malformed_reads_as_absent() {
        assert_eq!(parse_uplink_status("not json"), None);
        assert_eq!(parse_uplink_status("null"), None);
    }

    #[test]
    fn stale_when_pid_dead() {
        let s = sample();
        assert!(is_uplink_status_stale(&s, s.updated_at, &|_| false));
    }

    #[test]
    fn stale_when_updated_at_too_old() {
        let s = sample();
        let now = s.updated_at + UPLINK_STALE_AFTER_MS + 1;
        assert!(is_uplink_status_stale(&s, now, &|_| true));
    }

    #[test]
    fn fresh_when_pid_alive_and_recent() {
        let s = sample();
        let now = s.updated_at + 1_000;
        assert!(!is_uplink_status_stale(&s, now, &|_| true));
    }
}
