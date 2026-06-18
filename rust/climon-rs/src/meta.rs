//! climon server integration: writes session metadata to
//! `$CLIMON_HOME/sessions/<id>.json` so the existing dashboard server discovers,
//! health-checks, and bridges browser viewers to a Rust-hosted session.
//!
//! The metadata shape mirrors `SessionMeta` in `src/types.ts`; the server only
//! requires `status` + a live `daemonPid` + a responsive `socketPath`, plus the
//! descriptive fields it renders.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// A registered climon session whose metadata file is kept up to date.
pub struct Session {
    id: String,
    meta_path: PathBuf,
    command: Vec<String>,
    display_command: String,
    cwd: String,
    socket_path: String,
    created_at: String,
    pid: u32,
    /// Current size, guarded so resize updates are serialized.
    size: Mutex<(u16, u16)>,
}

impl Session {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Creates an unregistered session (no metadata file written yet). The
    /// socket path is assigned later via [`Session::activate`], so callers can
    /// derive a default socket path from the generated [`Session::id`].
    pub fn register_pending(
        home: &Path,
        command: &[String],
        cols: u16,
        rows: u16,
    ) -> io::Result<Session> {
        let sessions_dir = home.join("sessions");
        std::fs::create_dir_all(&sessions_dir)?;
        let id = generate_id();
        Ok(Session {
            meta_path: sessions_dir.join(format!("{}.json", id)),
            command: command.to_vec(),
            display_command: display_command(command),
            cwd: std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            socket_path: String::new(),
            created_at: now_iso(),
            pid: std::process::id(),
            size: Mutex::new((cols, rows)),
            id,
        })
    }

    /// Records the socket path and writes the initial `running` metadata file.
    pub fn activate(&mut self, socket_path: &Path) -> io::Result<()> {
        self.socket_path = socket_path.to_string_lossy().into_owned();
        self.write("running", "running", None, None)
    }

    /// Updates the recorded terminal size.
    pub fn update_size(&self, cols: u16, rows: u16) {
        {
            let mut size = self.size.lock().unwrap();
            if *size == (cols, rows) {
                return;
            }
            *size = (cols, rows);
        }
        let _ = self.write("running", "running", None, None);
    }

    /// Marks the session completed/failed with the child's exit code.
    pub fn complete(&self, exit_code: i32) {
        let (status, reason) = if exit_code == 0 {
            ("completed", "completed")
        } else {
            ("failed", "failed")
        };
        let _ = self.write(status, reason, Some(exit_code), Some(now_iso()));
    }

    fn write(
        &self,
        status: &str,
        priority_reason: &str,
        exit_code: Option<i32>,
        completed_at: Option<String>,
    ) -> io::Result<()> {
        let (cols, rows) = *self.size.lock().unwrap();
        let now = now_iso();
        let command_json = json_string_array(&self.command);
        let mut fields = vec![
            format!("\"id\":{}", json_string(&self.id)),
            format!("\"command\":{}", command_json),
            format!("\"displayCommand\":{}", json_string(&self.display_command)),
            format!("\"cwd\":{}", json_string(&self.cwd)),
            format!("\"status\":{}", json_string(status)),
            format!("\"priorityReason\":{}", json_string(priority_reason)),
            format!("\"daemonPid\":{}", self.pid),
            format!("\"cols\":{}", cols),
            format!("\"rows\":{}", rows),
            "\"headless\":false".to_string(),
            format!("\"socketPath\":{}", json_string(&self.socket_path)),
            "\"clientVersion\":\"climon-rs-poc\"".to_string(),
            "\"priority\":500".to_string(),
            format!("\"createdAt\":{}", json_string(&self.created_at)),
            format!("\"updatedAt\":{}", json_string(&now)),
            format!("\"lastActivityAt\":{}", json_string(&now)),
        ];
        if let Some(code) = exit_code {
            fields.push(format!("\"exitCode\":{}", code));
        }
        if let Some(ts) = completed_at {
            fields.push(format!("\"completedAt\":{}", json_string(&ts)));
        }
        let body = format!("{{{}}}", fields.join(","));
        atomic_write(&self.meta_path, body.as_bytes())
    }
}

/// Resolves `$CLIMON_HOME`, defaulting to `~/.climon`.
pub fn climon_home() -> PathBuf {
    if let Some(home) = std::env::var_os("CLIMON_HOME") {
        return PathBuf::from(home);
    }
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(".climon")
}

/// Default per-session socket path under `$CLIMON_HOME/sock/`.
pub fn registered_socket_path(home: &Path, id: &str) -> PathBuf {
    home.join("sock").join(format!("{}.sock", id))
}

fn display_command(command: &[String]) -> String {
    if command.is_empty() {
        return String::new();
    }
    let first = &command[0];
    let short = Path::new(first)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| first.clone());
    let mut parts = vec![short];
    parts.extend(command[1..].iter().cloned());
    parts.join(" ")
}

fn generate_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    format!("rs-{:x}", (nanos ^ (pid << 17)) & 0xffff_ffff_ffff)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.flush()?;
    }
    std::fs::rename(&tmp, path)
}

// --- Minimal JSON serialization ---

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn json_string_array(items: &[String]) -> String {
    let parts: Vec<String> = items.iter().map(|s| json_string(s)).collect();
    format!("[{}]", parts.join(","))
}

/// Formats the current UTC time as an ISO-8601 string (e.g.
/// `2026-06-17T07:00:00.000Z`), matching JavaScript's `Date#toISOString`.
fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        y, m, d, hh, mm, ss
    )
}

/// Converts days since the Unix epoch into a civil (year, month, day).
/// Howard Hinnant's `civil_from_days` algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_json_strings() {
        assert_eq!(json_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }

    #[test]
    fn serializes_command_array() {
        let cmd = vec!["bash".to_string(), "-c".to_string(), "echo hi".to_string()];
        assert_eq!(json_string_array(&cmd), "[\"bash\",\"-c\",\"echo hi\"]");
    }

    #[test]
    fn shortens_display_command_to_basename() {
        let cmd = vec!["/usr/bin/bash".to_string(), "-l".to_string()];
        assert_eq!(display_command(&cmd), "bash -l");
    }

    #[test]
    fn epoch_formats_correctly() {
        // 0 seconds since epoch = 1970-01-01T00:00:00.000Z
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn known_date_formats_correctly() {
        // 2021-01-01 is 18628 days after the epoch.
        assert_eq!(civil_from_days(18_628), (2021, 1, 1));
    }

    #[test]
    fn now_iso_has_expected_shape() {
        let s = now_iso();
        assert_eq!(s.len(), 24);
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
    }
}
