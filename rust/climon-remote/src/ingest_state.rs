//! Durable ingest beacon (`ingest.json`). 1:1 port of `src/remote/ingest-state.ts`.
//!
//! The ingest is the single writer; the beacon carries the bound pid, port, and
//! published host. When the loopback control socket is enabled, it also carries
//! the same-user bearer token and is written as an explicit `0600` file.

use std::path::Path;

use climon_config::config::{get_climon_home, Env as ConfigEnv};
use climon_store::atomic::atomic_write_with_mode;
use serde::{Deserialize, Serialize};

use crate::ingest_port::DEFAULT_INGEST_PORT;
use crate::process::is_process_alive;
use crate::remote_host::read_remote_host_state;

/// Basename of the ingest beacon under `CLIMON_HOME`.
pub const INGEST_STATE_BASENAME: &str = "ingest.json";

/// The ingest beacon. Mirrors `IngestState`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngestState {
    pub pid: u32,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(
        rename = "controlSocket",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub control_socket: Option<String>,
    #[serde(
        rename = "controlToken",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub control_token: Option<String>,
}

/// `$CLIMON_HOME/ingest.json`. Mirrors `getIngestStatePath`.
pub fn get_ingest_state_path(config_env: &ConfigEnv) -> std::path::PathBuf {
    get_climon_home(config_env).join(INGEST_STATE_BASENAME)
}

/// Parses and validates an ingest beacon. Returns `None` for malformed,
/// non-object, or invalid pid/port input. Mirrors `parseIngestState`.
pub fn parse_ingest_state(raw: &str) -> Option<IngestState> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = value.as_object()?;
    let pid = positive_integer(obj.get("pid"))?;
    let port = positive_integer(obj.get("port"))?;
    let host = obj
        .get("host")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let control_socket = obj
        .get("controlSocket")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let control_token = obj
        .get("controlToken")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Some(IngestState {
        pid: pid as u32,
        port: port as u16,
        host,
        control_socket,
        control_token,
    })
}

fn positive_integer(value: Option<&serde_json::Value>) -> Option<u64> {
    let n = value?.as_f64()?;
    if n.is_finite() && n.fract() == 0.0 && n > 0.0 {
        Some(n as u64)
    } else {
        None
    }
}

/// Serializes a beacon to compact JSON + trailing newline. Mirrors
/// `serializeIngestState`.
pub fn serialize_ingest_state(state: &IngestState) -> String {
    format!("{}\n", serde_json::to_string(state).unwrap())
}

/// Atomically writes the local ingest beacon as `0600`. Mirrors `writeIngestState`.
pub fn write_ingest_state(state: &IngestState, config_env: &ConfigEnv) -> std::io::Result<()> {
    atomic_write_with_mode(
        &get_ingest_state_path(config_env),
        serialize_ingest_state(state).as_bytes(),
        0o600,
    )
}

fn read_ingest_state_from_path(path: &Path) -> Option<IngestState> {
    let raw = std::fs::read_to_string(path).ok()?;
    parse_ingest_state(&raw)
}

/// Reads the ingest beacon from an explicit `CLIMON_HOME` (local or peer over a
/// mount). Mirrors `readIngestStateFromDir`.
pub fn read_ingest_state_from_dir(home_dir: &Path) -> Option<IngestState> {
    read_ingest_state_from_path(&home_dir.join(INGEST_STATE_BASENAME))
}

/// Reads the local ingest beacon. Mirrors `readIngestState`.
pub fn read_ingest_state(config_env: &ConfigEnv) -> Option<IngestState> {
    read_ingest_state_from_path(&get_ingest_state_path(config_env))
}

/// Single source of truth for the ingest port: the live `ingest.json` port (when
/// its pid is alive), then `remote-host.json`'s ingestPort, then the default.
/// Mirrors `resolveIngestPort`. `is_alive` is injectable for tests.
pub fn resolve_ingest_port(config_env: &ConfigEnv, is_alive: &dyn Fn(u32) -> bool) -> u16 {
    if let Some(beacon) = read_ingest_state(config_env) {
        if is_alive(beacon.pid) {
            return beacon.port;
        }
    }
    if let Some(host_state) = read_remote_host_state(config_env) {
        if host_state.ingest_port > 0 {
            return host_state.ingest_port;
        }
    }
    DEFAULT_INGEST_PORT
}

/// Convenience wrapper using the real process-liveness check.
pub fn resolve_ingest_port_default(config_env: &ConfigEnv) -> u16 {
    resolve_ingest_port(config_env, &is_process_alive)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_for(home: &Path) -> ConfigEnv {
        ConfigEnv::new(Some(home.to_str().unwrap()), home.to_path_buf())
    }

    fn tmp_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::current_dir()
            .unwrap()
            .join(".copilot-tmp")
            .join(format!(
                "climon-ingest-state-{tag}-{}-{:?}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn serialize_then_parse_preserves_pid_and_port() {
        let state = IngestState {
            pid: 1234,
            port: 3132,
            host: None,
            control_socket: None,
            control_token: None,
        };
        assert_eq!(
            parse_ingest_state(&serialize_ingest_state(&state)),
            Some(state)
        );
    }

    #[test]
    fn serialize_then_parse_preserves_control_socket() {
        let state = IngestState {
            pid: 1,
            port: 3132,
            host: Some("172.30.192.1".into()),
            control_socket: Some("tcp://127.0.0.1:54321".into()),
            control_token: None,
        };
        assert_eq!(
            parse_ingest_state(&serialize_ingest_state(&state)),
            Some(state)
        );
    }

    #[test]
    fn control_socket_serializes_with_camel_case_key() {
        let state = IngestState {
            pid: 1,
            port: 3132,
            host: None,
            control_socket: Some("tcp://127.0.0.1:5/".into()),
            control_token: None,
        };
        assert!(serialize_ingest_state(&state).contains("\"controlSocket\""));
    }

    #[test]
    fn write_then_read_from_dir_returns_the_same_state() {
        let home = tmp_home("wr");
        let env = env_for(&home);
        let state = IngestState {
            pid: 4321,
            port: 3140,
            host: None,
            control_socket: None,
            control_token: None,
        };
        write_ingest_state(&state, &env).unwrap();
        assert_eq!(read_ingest_state_from_dir(&home), Some(state));
        std::fs::remove_dir_all(&home).ok();
    }

    #[cfg(unix)]
    #[test]
    fn write_ingest_state_creates_0600_beacon() {
        use std::os::unix::fs::PermissionsExt;

        let home = tmp_home("mode");
        let env = env_for(&home);
        let state = IngestState {
            pid: 4321,
            port: 3140,
            host: None,
            control_socket: Some("tcp://127.0.0.1:54321".into()),
            control_token: Some("secret-token".into()),
        };

        write_ingest_state(&state, &env).unwrap();

        let mode = std::fs::metadata(get_ingest_state_path(&env))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_tokenless_beacon_is_valid() {
        assert_eq!(
            parse_ingest_state(r#"{"pid":1,"port":3132}"#),
            Some(IngestState {
                pid: 1,
                port: 3132,
                host: None,
                control_socket: None,
                control_token: None,
            })
        );
    }

    #[test]
    fn a_leftover_shutdown_token_field_is_ignored() {
        assert_eq!(
            parse_ingest_state(r#"{"pid":1,"port":3132,"shutdownToken":"old"}"#),
            Some(IngestState {
                pid: 1,
                port: 3132,
                host: None,
                control_socket: None,
                control_token: None,
            })
        );
    }

    #[test]
    fn a_malformed_pid_or_port_beacon_is_invalid() {
        assert_eq!(parse_ingest_state(r#"{"pid":0,"port":3132}"#), None);
        assert_eq!(parse_ingest_state(r#"{"pid":1,"port":-1}"#), None);
        assert_eq!(parse_ingest_state("not json"), None);
    }

    #[test]
    fn a_non_object_beacon_is_invalid_without_throwing() {
        assert_eq!(parse_ingest_state("null"), None);
        assert_eq!(parse_ingest_state("123"), None);
        assert_eq!(parse_ingest_state(r#""a string""#), None);
        assert_eq!(parse_ingest_state("[1,2,3]"), None);
    }

    #[test]
    fn serialize_then_parse_preserves_an_explicit_host() {
        let state = IngestState {
            pid: 1,
            port: 3132,
            host: Some("172.30.192.1".into()),
            control_socket: None,
            control_token: None,
        };
        assert_eq!(
            parse_ingest_state(&serialize_ingest_state(&state)),
            Some(state)
        );
    }

    #[test]
    fn resolve_returns_the_bound_port_from_a_live_ingest_json() {
        let home = tmp_home("live");
        let env = env_for(&home);
        write_ingest_state(
            &IngestState {
                pid: std::process::id(),
                port: 3140,
                host: None,
                control_socket: None,
                control_token: None,
            },
            &env,
        )
        .unwrap();
        assert_eq!(resolve_ingest_port(&env, &|_| true), 3140);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn resolve_falls_back_to_remote_host_ingest_port() {
        let home = tmp_home("fallback");
        let env = env_for(&home);
        std::fs::write(
            home.join("remote-host.json"),
            r#"{"tunnelId":"x","ingestPort":3150}"#,
        )
        .unwrap();
        assert_eq!(resolve_ingest_port(&env, &|_| true), 3150);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn resolve_falls_back_to_default_when_nothing_recorded() {
        let home = tmp_home("default");
        let env = env_for(&home);
        assert_eq!(resolve_ingest_port(&env, &|_| true), DEFAULT_INGEST_PORT);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn resolve_ignores_a_dead_ingest_beacon_and_falls_back() {
        let home = tmp_home("dead");
        let env = env_for(&home);
        write_ingest_state(
            &IngestState {
                pid: 999999,
                port: 3199,
                host: None,
                control_socket: None,
                control_token: None,
            },
            &env,
        )
        .unwrap();
        std::fs::write(
            home.join("remote-host.json"),
            r#"{"tunnelId":"x","ingestPort":3150}"#,
        )
        .unwrap();
        assert_eq!(resolve_ingest_port(&env, &|_| false), 3150);
        std::fs::remove_dir_all(&home).ok();
    }
}
