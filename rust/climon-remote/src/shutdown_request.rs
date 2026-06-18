//! Cross-OS demote control message. 1:1 port of `src/remote/shutdown-request.ts`.
//!
//! The promoting OS writes this file into the PEER's `CLIMON_HOME` over the
//! shared mount to ask the peer's durable ingest daemon to demote itself. It
//! carries NO token: same-user write access to the peer's home IS the
//! authorization. Its mere well-formed presence is the signal; replay is
//! prevented by the ingest clearing requests at startup and consuming them
//! after acting. All input is untrusted (see `docs/security.md`).

use std::path::{Path, PathBuf};

use climon_config::config::{get_climon_home, Env as ConfigEnv};
use climon_store::atomic::atomic_write;
use serde::{Deserialize, Serialize};

/// Basename of the request file.
pub const SHUTDOWN_REQUEST_BASENAME: &str = "shutdown-request.json";

/// Upper bound on the on-disk file; oversized requests are rejected pre-parse.
pub const MAX_SHUTDOWN_REQUEST_BYTES: usize = 4096;

const ALLOWED_REQUESTERS: [&str; 2] = ["WSL", "Windows"];

/// The single cross-OS control message. Mirrors `ShutdownRequest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShutdownRequest {
    /// "WSL" | "Windows" — diagnostics/observability only.
    #[serde(rename = "requestedBy")]
    pub requested_by: String,
    /// Epoch milliseconds the request was written.
    pub ts: i64,
}

/// Path to the request file under the resolved `CLIMON_HOME`.
pub fn get_shutdown_request_path(env: &ConfigEnv) -> PathBuf {
    get_climon_home(env).join(SHUTDOWN_REQUEST_BASENAME)
}

/// Path to the request file inside an explicit home dir (the peer's).
pub fn get_shutdown_request_path_in_dir(home_dir: &Path) -> PathBuf {
    home_dir.join(SHUTDOWN_REQUEST_BASENAME)
}

/// Serializes a request as compact JSON followed by a trailing newline.
pub fn serialize_shutdown_request(request: &ShutdownRequest) -> String {
    // Match the TS field order: requestedBy, ts.
    format!(
        "{}\n",
        serde_json::json!({ "requestedBy": request.requested_by, "ts": request.ts })
    )
}

/// Parses and validates a request. Returns `None` for anything oversized,
/// malformed, or outside the allow-listed shape. Mirrors `parseShutdownRequest`.
pub fn parse_shutdown_request(raw: &str) -> Option<ShutdownRequest> {
    if raw.len() > MAX_SHUTDOWN_REQUEST_BYTES {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    if !parsed.is_object() {
        return None;
    }
    let requested_by = parsed.get("requestedBy").and_then(|v| v.as_str())?;
    if !ALLOWED_REQUESTERS.contains(&requested_by) {
        return None;
    }
    let ts_value = parsed.get("ts")?;
    let ts = ts_value.as_f64().filter(|n| n.is_finite() && *n > 0.0)?;
    Some(ShutdownRequest {
        requested_by: requested_by.to_string(),
        ts: ts as i64,
    })
}

/// Atomically writes a shutdown request into an explicit home dir (the peer's).
pub fn write_shutdown_request_to_dir(
    home_dir: &Path,
    request: &ShutdownRequest,
) -> std::io::Result<()> {
    atomic_write(
        &get_shutdown_request_path_in_dir(home_dir),
        serialize_shutdown_request(request).as_bytes(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> ShutdownRequest {
        ShutdownRequest {
            requested_by: "Windows".to_string(),
            ts: 1_717_000_000_000,
        }
    }

    #[test]
    fn serialize_then_parse_preserves_all_fields() {
        assert_eq!(
            parse_shutdown_request(&serialize_shutdown_request(&valid())),
            Some(valid())
        );
    }

    #[test]
    fn serialize_matches_ts_compact_json() {
        assert_eq!(
            serialize_shutdown_request(&valid()),
            "{\"requestedBy\":\"Windows\",\"ts\":1717000000000}\n"
        );
    }

    #[test]
    fn rejects_unknown_requested_by() {
        assert!(parse_shutdown_request(r#"{"requestedBy":"Linux","ts":1}"#).is_none());
    }

    #[test]
    fn rejects_missing_requested_by() {
        assert!(parse_shutdown_request(r#"{"ts":1}"#).is_none());
    }

    #[test]
    fn rejects_non_positive_or_non_numeric_ts() {
        assert!(parse_shutdown_request(r#"{"requestedBy":"Windows","ts":0}"#).is_none());
        assert!(parse_shutdown_request(r#"{"requestedBy":"Windows","ts":"soon"}"#).is_none());
    }

    #[test]
    fn rejects_oversized_payload_before_parsing() {
        let pad = "x".repeat(5000);
        let huge = format!(r#"{{"requestedBy":"Windows","ts":1,"pad":"{pad}"}}"#);
        assert!(huge.len() > MAX_SHUTDOWN_REQUEST_BYTES);
        assert!(parse_shutdown_request(&huge).is_none());
    }

    #[test]
    fn rejects_non_json() {
        assert!(parse_shutdown_request("not json").is_none());
    }

    #[test]
    fn path_is_basename_under_climon_home() {
        let env = ConfigEnv::new(Some("/tmp/home"), "/tmp/userhome");
        assert_eq!(
            get_shutdown_request_path(&env),
            std::path::Path::new("/tmp/home").join(SHUTDOWN_REQUEST_BASENAME)
        );
    }
}
