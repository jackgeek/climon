//! Dashboard server state file (`server.json`). Ports `server-state.ts`:
//! pid + bound ports written atomically into one file so they can never skew.
//! Parsing rejects non-positive / non-integer pid/port, mirroring the TS guards.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::atomic::atomic_write;
use crate::error::StoreResult;
use crate::paths::Env;

/// Basename of the server state file under `CLIMON_HOME`.
pub const SERVER_STATE_BASENAME: &str = "server.json";

/// Single state file for the running dashboard server. Optional fields are
/// omitted when absent so the on-disk shape matches the TS `ServerState`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerState {
    /// PID of the running dashboard server process.
    pub pid: u32,
    /// TCP port the dashboard server (HTTP) bound to.
    pub port: u16,
    /// TCP port the remote ingest listener bound to, when remotes are enabled.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ingest: Option<u16>,
    /// Epoch milliseconds when this server promoted (wrote its state file).
    #[serde(rename = "startedAt", skip_serializing_if = "Option::is_none", default)]
    pub started_at: Option<u64>,
}

/// Parses raw JSON into a [`ServerState`], returning `None` when the JSON is
/// malformed or pid/port are missing / non-positive / non-integer. Mirrors
/// `parseServerState`.
pub fn parse_server_state(raw: &str) -> Option<ServerState> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = value.as_object()?;

    let pid = positive_integer(obj.get("pid"))?;
    let port = positive_integer(obj.get("port"))?;

    let ingest = positive_integer(obj.get("ingest"));
    let started_at = obj
        .get("startedAt")
        .and_then(|v| v.as_f64())
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n as u64);

    Some(ServerState {
        pid: pid as u32,
        port: port as u16,
        ingest: ingest.map(|n| n as u16),
        started_at,
    })
}

/// Returns the integer value when `value` is a positive, integral JSON number.
fn positive_integer(value: Option<&serde_json::Value>) -> Option<u64> {
    let n = value?.as_f64()?;
    if n.is_finite() && n.fract() == 0.0 && n > 0.0 {
        Some(n as u64)
    } else {
        None
    }
}

/// Serializes server state to the compact JSON (with trailing newline) written
/// into the state file. Mirrors `serializeServerState`.
pub fn serialize_server_state(state: &ServerState) -> String {
    // serde_json compact output matches `JSON.stringify` key order (struct order)
    // for our fields, and `skip_serializing_if` omits optionals.
    format!("{}\n", serde_json::to_string(state).expect("serialize"))
}

fn read_server_state_from_path(path: &Path) -> Option<ServerState> {
    let raw = std::fs::read_to_string(path).ok()?;
    parse_server_state(&raw)
}

/// Reads the local dashboard server state file (under this process's home).
/// Returns `None` when absent, unreadable, or malformed.
pub fn read_server_state(env: &Env) -> Option<ServerState> {
    read_server_state_from_path(&env.server_state_path())
}

/// Reads a server state file from an explicit home directory (peer discovery
/// over a mount). Returns `None` on any failure. Mirrors `readServerStateFromDir`.
pub fn read_server_state_from_dir(home_dir: &Path) -> Option<ServerState> {
    read_server_state_from_path(&home_dir.join(SERVER_STATE_BASENAME))
}

/// Atomically writes the server state file under the process's home.
pub fn write_server_state(env: &Env, state: &ServerState) -> StoreResult<()> {
    atomic_write(
        &env.server_state_path(),
        serialize_server_state(state).as_bytes(),
    )?;
    Ok(())
}

/// Removes the server state file if present (best-effort, ignores absence).
pub fn remove_server_state(env: &Env) -> StoreResult<()> {
    match std::fs::remove_file(env.server_state_path()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn env_for(tag: &str) -> Env {
        let home = crate::test_support::scratch_dir(tag);
        fs::create_dir_all(&home).unwrap();
        Env::with_home(home)
    }

    #[test]
    fn parses_minimal_pid_port() {
        let state = parse_server_state(r#"{"pid":1234,"port":7421}"#).unwrap();
        assert_eq!(state.pid, 1234);
        assert_eq!(state.port, 7421);
        assert_eq!(state.ingest, None);
        assert_eq!(state.started_at, None);
    }

    #[test]
    fn parses_full_state() {
        let state =
            parse_server_state(r#"{"pid":9,"port":7421,"ingest":7500,"startedAt":1700000000000}"#)
                .unwrap();
        assert_eq!(state.ingest, Some(7500));
        assert_eq!(state.started_at, Some(1_700_000_000_000));
    }

    #[test]
    fn rejects_malformed_and_nonpositive() {
        assert!(parse_server_state("not json").is_none());
        assert!(parse_server_state(r#"{"port":7421}"#).is_none());
        assert!(parse_server_state(r#"{"pid":0,"port":7421}"#).is_none());
        assert!(parse_server_state(r#"{"pid":12,"port":-3}"#).is_none());
        assert!(parse_server_state(r#"{"pid":12.5,"port":7421}"#).is_none());
    }

    #[test]
    fn ignores_invalid_ingest_but_keeps_state() {
        let state = parse_server_state(r#"{"pid":1,"port":2,"ingest":0}"#).unwrap();
        assert_eq!(state.ingest, None);
    }

    #[test]
    fn serialize_omits_optionals_and_adds_newline() {
        let state = ServerState {
            pid: 1234,
            port: 7421,
            ingest: None,
            started_at: None,
        };
        assert_eq!(
            serialize_server_state(&state),
            "{\"pid\":1234,\"port\":7421}\n"
        );
    }

    #[test]
    fn serialize_includes_optionals_in_order() {
        let state = ServerState {
            pid: 1,
            port: 2,
            ingest: Some(3),
            started_at: Some(4),
        };
        assert_eq!(
            serialize_server_state(&state),
            "{\"pid\":1,\"port\":2,\"ingest\":3,\"startedAt\":4}\n"
        );
    }

    #[test]
    fn write_then_read_roundtrips() {
        let env = env_for("server-state-rt");
        let state = ServerState {
            pid: 42,
            port: 7421,
            ingest: Some(7500),
            started_at: Some(1700),
        };
        write_server_state(&env, &state).unwrap();
        assert_eq!(read_server_state(&env), Some(state));
        remove_server_state(&env).unwrap();
        assert_eq!(read_server_state(&env), None);
        let _ = fs::remove_dir_all(env.climon_home());
    }
}
