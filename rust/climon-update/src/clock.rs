//! Minimal UTC ISO-8601 millisecond clock, matching JavaScript's
//! `new Date().toISOString()` output (`YYYY-MM-DDTHH:MM:SS.sssZ`) and
//! `Date.parse()` semantics for that format. Avoids pulling in a date crate.

use std::time::{SystemTime, UNIX_EPOCH};

/// Current epoch milliseconds (UTC), like JS `Date.now()`.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Days from civil date (Howard Hinnant's algorithm). Returns days since the
/// Unix epoch (1970-01-01).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Inverse of [`days_from_civil`]: civil (year, month, day) from epoch days.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Formats epoch milliseconds as a JS-`toISOString()`-compatible UTC string.
pub fn to_iso8601(ms: i64) -> String {
    let mut secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86400);
    secs = secs.rem_euclid(86400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs / 3600;
    let minute = (secs % 3600) / 60;
    let second = secs % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Current time as a JS-`toISOString()`-compatible UTC string.
pub fn now_iso8601() -> String {
    to_iso8601(now_ms())
}

/// Parses a `YYYY-MM-DDTHH:MM:SS(.sss)?Z`-style timestamp to epoch milliseconds.
/// Returns `None` when the string is not a recognizable ISO-8601 instant,
/// mirroring `Number.isNaN(Date.parse(...))`.
pub fn parse_iso8601_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let sep = bytes[10];
    if sep != b'T' && sep != b't' && sep != b' ' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    // Optional fractional seconds.
    let mut idx = 19;
    let mut millis: i64 = 0;
    if bytes.get(idx) == Some(&b'.') {
        idx += 1;
        let frac_start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        let frac = &s[frac_start..idx];
        if !frac.is_empty() {
            // Take the first three digits as milliseconds (pad/truncate).
            let padded: String = frac.chars().chain(std::iter::repeat('0')).take(3).collect();
            millis = padded.parse().ok()?;
        }
    }

    // Optional timezone: Z / +HH:MM / -HH:MM.
    let mut offset_min: i64 = 0;
    if idx < bytes.len() {
        match bytes[idx] {
            b'Z' | b'z' => {}
            b'+' | b'-' => {
                let sign = if bytes[idx] == b'-' { -1 } else { 1 };
                let oh: i64 = s.get(idx + 1..idx + 3)?.parse().ok()?;
                let om: i64 = if bytes.get(idx + 3) == Some(&b':') {
                    s.get(idx + 4..idx + 6)?.parse().ok()?
                } else {
                    s.get(idx + 3..idx + 5)?.parse().ok()?
                };
                offset_min = sign * (oh * 60 + om);
            }
            _ => return None,
        }
    }

    let days = days_from_civil(year, month, day);
    let total_secs = days * 86400 + hour * 3600 + minute * 60 + second;
    Some((total_secs - offset_min * 60) * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_iso8601() {
        let ms = 1_750_000_000_000; // arbitrary
        let iso = to_iso8601(ms);
        assert_eq!(parse_iso8601_ms(&iso), Some(ms));
    }

    #[test]
    fn matches_known_instant() {
        // 2021-01-01T00:00:00.000Z = 1609459200000 ms.
        assert_eq!(to_iso8601(1_609_459_200_000), "2021-01-01T00:00:00.000Z");
        assert_eq!(
            parse_iso8601_ms("2021-01-01T00:00:00.000Z"),
            Some(1_609_459_200_000)
        );
    }

    #[test]
    fn parses_offset_timezone() {
        assert_eq!(
            parse_iso8601_ms("2021-01-01T01:00:00+01:00"),
            Some(1_609_459_200_000)
        );
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_iso8601_ms("not-a-date"), None);
        assert_eq!(parse_iso8601_ms(""), None);
    }
}
