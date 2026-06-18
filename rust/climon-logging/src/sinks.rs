//! Log file sinks and path helpers.
//!
//! Port of `src/logging/sinks.ts`. Computes per-role log directories and file
//! paths under `$CLIMON_HOME/logs/<role>/` and opens NDJSON destination files.
//!
//! `get_climon_home`/`get_logs_dir` mirror `src/config.ts` minimally: the
//! `climon-config` crate (Phase 3) is a sibling not yet merged into this
//! worktree, so the small `$CLIMON_HOME`-or-`~/.climon` resolution is duplicated
//! here and can delegate to `climon-config` once it lands.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::env::Env;

/// The role a logger serves; selects the log subdirectory and file naming.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogRole {
    Client,
    Daemon,
    Server,
    Ingest,
    Uplink,
}

impl LogRole {
    /// The directory/name token for this role (matches the TS `LogRole` union).
    pub fn as_str(&self) -> &'static str {
        match self {
            LogRole::Client => "client",
            LogRole::Daemon => "daemon",
            LogRole::Server => "server",
            LogRole::Ingest => "ingest",
            LogRole::Uplink => "uplink",
        }
    }
}

/// Resolves `$CLIMON_HOME` (default `~/.climon`). Mirrors `getClimonHome`.
pub fn get_climon_home(env: &Env) -> PathBuf {
    if let Some(home) = env.get("CLIMON_HOME") {
        return PathBuf::from(home);
    }
    home_dir().join(".climon")
}

/// The logs root: `$CLIMON_HOME/logs`. Mirrors `getLogsDir`.
pub fn get_logs_dir(env: &Env) -> PathBuf {
    get_climon_home(env).join("logs")
}

/// The per-role log directory: `$CLIMON_HOME/logs/<role>`. Mirrors
/// `logDirForRole`.
pub fn log_dir_for_role(role: LogRole, env: &Env) -> PathBuf {
    get_logs_dir(env).join(role.as_str())
}

/// A UTC `YYYY-MM-DD-HH-MM-SS` start stamp. Mirrors `startStamp`.
pub fn start_stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (year, month, day, hour, min, sec) = civil_from_unix(secs as i64);
    format!("{year:04}-{month:02}-{day:02}-{hour:02}-{min:02}-{sec:02}")
}

/// The NDJSON log file path for a role. Daemon uses `<sessionId>.log`; other
/// roles use `<utc-stamp>-<pid>.log` (one file per process invocation). Mirrors
/// `logFilePathForRole`.
pub fn log_file_path_for_role(
    role: LogRole,
    env: &Env,
    session_id: Option<&str>,
) -> io::Result<PathBuf> {
    let dir = log_dir_for_role(role, env);
    if role == LogRole::Daemon {
        let id = session_id.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "daemon log file path requires a sessionId",
            )
        })?;
        return Ok(dir.join(format!("{id}.log")));
    }
    Ok(dir.join(format!("{}-{}.log", start_stamp(), std::process::id())))
}

/// Creates the role's log directory and opens its NDJSON file for appending.
/// Mirrors `buildFileStream`.
pub fn build_file_stream(role: LogRole, env: &Env, session_id: Option<&str>) -> io::Result<File> {
    let dir = log_dir_for_role(role, env);
    fs::create_dir_all(&dir)?;
    let path = log_file_path_for_role(role, env, session_id)?;
    OpenOptions::new().create(true).append(true).open(path)
}

/// Best-effort home directory (`HOME` on Unix, `USERPROFILE` on Windows).
fn home_dir() -> PathBuf {
    if cfg!(windows) {
        std::env::var_os("USERPROFILE")
    } else {
        std::env::var_os("HOME")
    }
    .map(PathBuf::from)
    .unwrap_or_else(|| PathBuf::from("."))
}

/// Converts a Unix timestamp (seconds) to UTC civil `(y, m, d, hh, mm, ss)`
/// using Howard Hinnant's `civil_from_days` algorithm — no external crate.
fn civil_from_unix(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let hour = (rem / 3600) as u32;
    let min = ((rem % 3600) / 60) as u32;
    let sec = (rem % 60) as u32;

    // civil_from_days: days since 1970-01-01.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d, hour, min, sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Env {
        Env::from_pairs([("CLIMON_HOME", "/tmp/climon-test-home")])
    }

    #[test]
    fn log_dir_for_role_nests_under_logs_role() {
        assert_eq!(
            log_dir_for_role(LogRole::Server, &env()),
            PathBuf::from("/tmp/climon-test-home/logs/server"),
        );
    }

    #[test]
    fn daemon_file_path_uses_session_id() {
        let p = log_file_path_for_role(LogRole::Daemon, &env(), Some("abc123")).unwrap();
        assert_eq!(
            p,
            PathBuf::from("/tmp/climon-test-home/logs/daemon/abc123.log"),
        );
    }

    #[test]
    fn daemon_file_path_without_session_id_errors() {
        let err = log_file_path_for_role(LogRole::Daemon, &env(), None).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn process_role_file_path_uses_timestamp_pid() {
        let p = log_file_path_for_role(LogRole::Server, &env(), None).unwrap();
        let dir = PathBuf::from("/tmp/climon-test-home/logs/server");
        assert!(p.starts_with(&dir));
        let name = p.file_name().unwrap().to_str().unwrap();
        assert!(name.ends_with(".log"));
        assert!(name.contains(&std::process::id().to_string()));
    }

    #[test]
    fn start_stamp_has_expected_shape() {
        let stamp = start_stamp();
        let parts: Vec<&str> = stamp.split('-').collect();
        assert_eq!(parts.len(), 6, "stamp = {stamp}");
        assert_eq!(parts[0].len(), 4); // year
        for p in &parts[1..] {
            assert_eq!(p.len(), 2, "segment {p} of {stamp}");
            assert!(p.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn civil_from_unix_known_epoch() {
        // 2021-01-01T00:00:00Z = 1609459200
        assert_eq!(civil_from_unix(1_609_459_200), (2021, 1, 1, 0, 0, 0));
        // 1970-01-01T00:00:00Z
        assert_eq!(civil_from_unix(0), (1970, 1, 1, 0, 0, 0));
        // 2000-02-29T23:59:59Z (leap day) = 951868799
        assert_eq!(civil_from_unix(951_868_799), (2000, 2, 29, 23, 59, 59));
    }
}
