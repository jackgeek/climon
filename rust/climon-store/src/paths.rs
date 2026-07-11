//! `$CLIMON_HOME` filesystem layout, the `Env` resolver, the Node-compatible
//! platform string, and the millisecond ISO-8601 clock.
//!
//! Path helpers are kept local to `climon-store` (rather than depending on
//! `climon-config`, which lands in parallel) so the crate is self-contained and
//! merge-conflict free. They mirror `getClimonHome`/`getSessionsDir`/... from
//! `src/config.ts` and `getServerStatePath` from `src/server-state.ts`.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Basename of the dashboard server-state file under `$CLIMON_HOME`.
pub const SERVER_STATE_BASENAME: &str = "server.json";

/// Resolves the `$CLIMON_HOME` layout. Construct from the process environment
/// with [`Env::from_env`] or pin an explicit home (tests) with [`Env::with_home`].
#[derive(Debug, Clone)]
pub struct Env {
    climon_home: PathBuf,
}

impl Env {
    /// Mirrors `getClimonHome`: `$CLIMON_HOME` when set, else `~/.climon`.
    pub fn from_env() -> Env {
        let home = std::env::var_os("CLIMON_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".climon"));
        Env { climon_home: home }
    }

    /// Pins an explicit climon home (used by tests via a temp dir).
    pub fn with_home(home: impl Into<PathBuf>) -> Env {
        Env {
            climon_home: home.into(),
        }
    }

    /// The resolved `$CLIMON_HOME` directory.
    pub fn climon_home(&self) -> &Path {
        &self.climon_home
    }

    /// `$CLIMON_HOME/sessions`.
    pub fn sessions_dir(&self) -> PathBuf {
        self.climon_home.join("sessions")
    }

    /// `$CLIMON_HOME/logs`.
    pub fn logs_dir(&self) -> PathBuf {
        self.climon_home.join("logs")
    }

    /// `$CLIMON_HOME/sock`.
    pub fn sock_dir(&self) -> PathBuf {
        self.climon_home.join("sock")
    }

    /// `$CLIMON_HOME/sessions/<id>.json`.
    pub fn session_meta_path(&self, id: &str) -> PathBuf {
        self.sessions_dir().join(format!("{id}.json"))
    }

    /// `$CLIMON_HOME/sessions/<id>.scrollback`.
    pub fn scrollback_path(&self, id: &str) -> PathBuf {
        self.sessions_dir().join(format!("{id}.scrollback"))
    }

    /// `$CLIMON_HOME/server.json`.
    pub fn server_state_path(&self) -> PathBuf {
        self.climon_home.join(SERVER_STATE_BASENAME)
    }

    /// `$CLIMON_HOME/sessions/<id>.ipc-auth` — owner-only credential sidecar.
    pub fn ipc_auth_path(&self, id: &str) -> PathBuf {
        self.sessions_dir().join(format!("{id}.ipc-auth"))
    }
}

/// Best-effort home directory for the `~/.climon` fallback. Reads `$HOME` on
/// unix and `$USERPROFILE` on Windows. `$CLIMON_HOME` overrides this in every
/// path that matters, so the fallback is only used when neither is set.
fn home_dir() -> PathBuf {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Node `process.platform` value for this target, so the lock `owner.json`
/// `platform` field matches a TS process on the same host (`darwin`/`win32`/...).
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// System hostname, matching Node's `os.hostname()` for same-host scope checks.
pub fn hostname() -> String {
    platform_hostname().unwrap_or_default()
}

#[cfg(unix)]
fn platform_hostname() -> Option<String> {
    // SAFETY: we pass a correctly sized buffer and length; gethostname writes at
    // most `len` bytes and null-terminates when there is room.
    let mut buf = [0u8; 256];
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Some(String::from_utf8_lossy(&buf[..end]).into_owned())
}

#[cfg(windows)]
fn platform_hostname() -> Option<String> {
    // Best-effort on Windows: COMPUTERNAME is the machine name. Exact parity with
    // Node's os.hostname() casing is not guaranteed; documented as best-effort.
    std::env::var("COMPUTERNAME").ok()
}

/// Formats a `SystemTime` as `YYYY-MM-DDTHH:MM:SS.mmmZ`, matching JavaScript's
/// `Date.prototype.toISOString()` (UTC, millisecond precision, `Z` suffix).
pub fn iso8601_millis_utc(time: SystemTime) -> String {
    let dur = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let total_millis = dur.as_millis() as i64;
    let secs = total_millis.div_euclid(1000);
    let millis = total_millis.rem_euclid(1000);

    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;

    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
}

/// Current time as an ISO-8601 millisecond UTC string.
pub fn now_iso() -> String {
    iso8601_millis_utc(SystemTime::now())
}

/// Howard Hinnant's `civil_from_days`: days since the Unix epoch → (year, month, day).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn resolves_layout_under_explicit_home() {
        let env = Env::with_home("/tmp/climon-home");
        assert_eq!(env.sessions_dir(), Path::new("/tmp/climon-home/sessions"));
        assert_eq!(
            env.session_meta_path("rare-geckos-jam"),
            Path::new("/tmp/climon-home/sessions/rare-geckos-jam.json")
        );
        assert_eq!(
            env.scrollback_path("rare-geckos-jam"),
            Path::new("/tmp/climon-home/sessions/rare-geckos-jam.scrollback")
        );
        assert_eq!(
            env.server_state_path(),
            Path::new("/tmp/climon-home/server.json")
        );
        assert_eq!(
            env.ipc_auth_path("rare-geckos-jam"),
            Path::new("/tmp/climon-home/sessions/rare-geckos-jam.ipc-auth")
        );
    }

    #[test]
    fn node_platform_maps_known_targets() {
        let p = node_platform();
        assert!(matches!(
            p,
            "darwin" | "win32" | "linux" | "freebsd" | "openbsd" | "netbsd"
        ));
        #[cfg(target_os = "macos")]
        assert_eq!(p, "darwin");
        #[cfg(target_os = "linux")]
        assert_eq!(p, "linux");
        #[cfg(target_os = "windows")]
        assert_eq!(p, "win32");
    }

    #[test]
    fn iso8601_matches_js_to_iso_string_format() {
        // 2021-01-01T00:00:00.000Z == 1609459200000 ms.
        let t = UNIX_EPOCH + Duration::from_millis(1_609_459_200_000);
        assert_eq!(iso8601_millis_utc(t), "2021-01-01T00:00:00.000Z");

        // 2026-06-18T10:36:20.889Z == 1781andsome; verify shape + a known value.
        let t2 = UNIX_EPOCH + Duration::from_millis(1_700_000_000_123);
        assert_eq!(iso8601_millis_utc(t2), "2023-11-14T22:13:20.123Z");
    }

    #[test]
    fn now_iso_is_well_shaped() {
        let s = now_iso();
        assert_eq!(s.len(), 24);
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
    }
}
