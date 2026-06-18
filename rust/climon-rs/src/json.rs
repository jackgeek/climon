//! Tiny hand-rolled JSON helpers for the small, fixed-shape control payloads
//! used by the frame protocol. Avoids pulling in a full serde stack for a PoC
//! that only needs `{cols, rows}` and `{exitCode}`.

/// Serializes a `PtySize`/`Resize` payload: `{"cols":N,"rows":M}`.
pub fn cols_rows_json(cols: u16, rows: u16) -> String {
    format!("{{\"cols\":{},\"rows\":{}}}", cols, rows)
}

/// Serializes an `Exit` payload: `{"exitCode":N}`.
pub fn exit_code_json(code: i32) -> String {
    format!("{{\"exitCode\":{}}}", code)
}

/// Extracts an integer value for `key` from a flat JSON object payload.
///
/// Intentionally minimal: it finds `"key"`, skips to the following number, and
/// parses it. Sufficient for the fixed-shape control payloads in this PoC.
fn parse_int_field(payload: &[u8], key: &str) -> Option<i64> {
    let text = std::str::from_utf8(payload).ok()?;
    let needle = format!("\"{}\"", key);
    let start = text.find(&needle)? + needle.len();
    let rest = &text[start..];
    // Skip whitespace and the colon.
    let after_colon = rest.find(':')? + 1;
    let mut chars = rest[after_colon..].chars().peekable();
    let mut num = String::new();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            if num.is_empty() {
                chars.next();
                continue;
            }
            break;
        }
        if c == '-' || c.is_ascii_digit() {
            num.push(c);
            chars.next();
        } else {
            break;
        }
    }
    num.parse::<i64>().ok()
}

/// Parses `{cols, rows}` from a Resize payload. Returns `None` if either field
/// is missing or non-positive.
pub fn parse_cols_rows(payload: &[u8]) -> Option<(u16, u16)> {
    let cols = parse_int_field(payload, "cols")?;
    let rows = parse_int_field(payload, "rows")?;
    if cols <= 0 || rows <= 0 {
        return None;
    }
    Some((cols as u16, rows as u16))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_cols_rows() {
        assert_eq!(cols_rows_json(80, 24), "{\"cols\":80,\"rows\":24}");
    }

    #[test]
    fn serializes_exit_code() {
        assert_eq!(exit_code_json(0), "{\"exitCode\":0}");
        assert_eq!(exit_code_json(130), "{\"exitCode\":130}");
    }

    #[test]
    fn parses_cols_rows_round_trip() {
        let json = cols_rows_json(120, 40);
        assert_eq!(parse_cols_rows(json.as_bytes()), Some((120, 40)));
    }

    #[test]
    fn parses_cols_rows_with_extra_fields() {
        let payload = b"{\"cols\":100,\"rows\":30,\"source\":\"host\"}";
        assert_eq!(parse_cols_rows(payload), Some((100, 30)));
    }

    #[test]
    fn rejects_missing_field() {
        assert_eq!(parse_cols_rows(b"{\"cols\":80}"), None);
    }

    #[test]
    fn rejects_non_positive() {
        assert_eq!(parse_cols_rows(b"{\"cols\":0,\"rows\":24}"), None);
    }
}
