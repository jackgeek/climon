//! Session sort ordering. 1:1 port of `src/priority.ts`.
//!
//! Sort key: status rank (needs-attention first) -> user priority (absent = 500)
//! -> most recently updated first.

use crate::meta::{SessionMeta, SessionStatus};
use crate::session_meta::DEFAULT_PRIORITY;

fn status_rank(status: SessionStatus) -> u8 {
    match status {
        SessionStatus::NeedsAttention => 0,
        SessionStatus::Acknowledged => 1,
        SessionStatus::Running => 2,
        SessionStatus::Completed => 3,
        SessionStatus::Paused => 4,
        SessionStatus::Failed => 5,
        SessionStatus::Disconnected => 6,
    }
}

/// Milliseconds since the Unix epoch for an ISO-8601 timestamp, or 0 if it does
/// not parse. Mirrors the TS `Date.parse(value) || 0` fallback.
fn timestamp_ms(value: &str) -> i64 {
    parse_iso_millis(value).unwrap_or(0)
}

fn priority_of(session: &SessionMeta) -> u16 {
    session.priority.unwrap_or(DEFAULT_PRIORITY)
}

/// Returns a new vector sorted by the climon session ordering. Stable so equal
/// keys preserve input order, matching the TS `Array#sort` on V8.
pub fn sort_sessions_by_priority(sessions: Vec<SessionMeta>) -> Vec<SessionMeta> {
    let mut sorted = sessions;
    sorted.sort_by(|left, right| {
        status_rank(left.status)
            .cmp(&status_rank(right.status))
            .then_with(|| priority_of(left).cmp(&priority_of(right)))
            .then_with(|| timestamp_ms(&right.updated_at).cmp(&timestamp_ms(&left.updated_at)))
    });
    sorted
}

/// Minimal ISO-8601 (`YYYY-MM-DDTHH:MM:SS(.fff)Z`) -> epoch millis parser.
/// Sufficient for comparing `updatedAt` timestamps written by the Bun server.
fn parse_iso_millis(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let num = |start: usize, len: usize| -> Option<i64> {
        value.get(start..start + len)?.parse::<i64>().ok()
    };
    let year = num(0, 4)?;
    let month = num(5, 2)?;
    let day = num(8, 2)?;
    let hour = num(11, 2)?;
    let minute = num(14, 2)?;
    let second = num(17, 2)?;
    let mut millis = 0i64;
    if bytes.get(19) == Some(&b'.') {
        let frac: String = value[20..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !frac.is_empty() {
            let padded = format!("{:0<3}", &frac[..frac.len().min(3)]);
            millis = padded.parse::<i64>().ok()?;
        }
    }
    let days = days_from_civil(year, month as u32, day as u32);
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(secs * 1000 + millis)
}

/// Days since the Unix epoch for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // year of era, [0, 399]
    let m = m as i64;
    let d = d as i64;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1; // day of year, [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // day of era, [0, 146096]
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meta::{PriorityReason, SessionMeta, SessionStatus};

    fn meta(id: &str, status: SessionStatus) -> SessionMeta {
        SessionMeta {
            id: id.to_string(),
            command: vec!["cmd".to_string()],
            display_command: "cmd".to_string(),
            cwd: "/".to_string(),
            status,
            priority_reason: PriorityReason::Running,
            daemon_pid: None,
            cols: 80,
            rows: 24,
            headless: None,
            socket_path: "/tmp/sock".to_string(),
            client_version: None,
            created_at: "2024-01-01T00:00:00.000Z".to_string(),
            updated_at: "2024-01-01T00:00:00.000Z".to_string(),
            last_activity_at: "2024-01-01T00:00:00.000Z".to_string(),
            attention_matched_at: None,
            attention_reason: None,
            completed_at: None,
            exit_code: None,
            error: None,
            origin: None,
            client_label: None,
            name: None,
            priority: None,
            color: None,
            user_paused: None,
            theme: None,
            terminal_title: None,
            attention_snippet: None,
            progress: None,
        }
    }

    fn ids(sessions: &[SessionMeta]) -> Vec<String> {
        sessions.iter().map(|s| s.id.clone()).collect()
    }

    #[test]
    fn needs_attention_sorts_before_others() {
        let sessions = vec![
            meta("a", SessionStatus::Running),
            meta("b", SessionStatus::NeedsAttention),
            meta("c", SessionStatus::Completed),
        ];
        assert_eq!(sort_sessions_by_priority(sessions)[0].id, "b");
    }

    #[test]
    fn orders_attention_then_acknowledged_then_running() {
        let sessions = vec![
            meta("r", SessionStatus::Running),
            meta("v", SessionStatus::Acknowledged),
            meta("a", SessionStatus::NeedsAttention),
        ];
        assert_eq!(
            ids(&sort_sessions_by_priority(sessions)),
            vec!["a", "v", "r"]
        );
    }

    #[test]
    fn ties_broken_by_most_recent_update() {
        let mut old = meta("old", SessionStatus::Running);
        old.updated_at = "2020-01-01T00:00:00.000Z".to_string();
        let mut new = meta("new", SessionStatus::Running);
        new.updated_at = "2024-01-01T00:00:00.000Z".to_string();
        assert_eq!(sort_sessions_by_priority(vec![old, new])[0].id, "new");
    }

    #[test]
    fn status_sorts_before_priority() {
        let mut done = meta("highprio-done", SessionStatus::Completed);
        done.priority = Some(100);
        let mut attn = meta("lowprio-attn", SessionStatus::NeedsAttention);
        attn.priority = Some(900);
        assert_eq!(
            sort_sessions_by_priority(vec![done, attn])[0].id,
            "lowprio-attn"
        );
    }

    #[test]
    fn absent_priority_is_treated_as_500() {
        let mut p400 = meta("explicit-400", SessionStatus::Running);
        p400.priority = Some(400);
        let default = meta("default", SessionStatus::Running);
        let mut p600 = meta("explicit-600", SessionStatus::Running);
        p600.priority = Some(600);
        assert_eq!(
            ids(&sort_sessions_by_priority(vec![p400, default, p600])),
            vec!["explicit-400", "default", "explicit-600"]
        );
    }

    #[test]
    fn within_equal_priority_full_status_order_applies() {
        let make = |id: &str, status: SessionStatus| {
            let mut m = meta(id, status);
            m.priority = Some(500);
            m
        };
        let sessions = vec![
            make("disc", SessionStatus::Disconnected),
            make("fail", SessionStatus::Failed),
            make("pause", SessionStatus::Paused),
            make("done", SessionStatus::Completed),
            make("run", SessionStatus::Running),
            make("avail", SessionStatus::Acknowledged),
            make("attn", SessionStatus::NeedsAttention),
        ];
        assert_eq!(
            ids(&sort_sessions_by_priority(sessions)),
            vec!["attn", "avail", "run", "done", "pause", "fail", "disc"]
        );
    }
}
