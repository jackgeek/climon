//! Pretty terminal formatting.
//!
//! Port of `src/logging/pretty.ts`. Turns NDJSON pino lines into human-readable
//! terminal output: only the message is printed (no timestamp/level/pid),
//! colored by severity and routed by level (info/warn → out, error/fatal →
//! err). Output is suppressed while the terminal is suspended.

use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;

static TERMINAL_SUSPENDED: AtomicBool = AtomicBool::new(false);

/// ANSI reset sequence.
pub const RESET: &str = "\u{1b}[0m";

/// Mutes (`true`) or restores (`false`) all pretty terminal output.
pub fn set_terminal_suspended(value: bool) {
    TERMINAL_SUSPENDED.store(value, Ordering::SeqCst);
}

/// Returns whether pretty terminal output is currently suspended.
pub fn is_terminal_suspended() -> bool {
    TERMINAL_SUSPENDED.load(Ordering::SeqCst)
}

/// ANSI color for a pino numeric level (the message is tinted by severity).
pub fn color_for_level(level: u16) -> &'static str {
    if level >= 60 {
        "\u{1b}[35m" // fatal — magenta
    } else if level >= 50 {
        "\u{1b}[31m" // error — red
    } else if level >= 40 {
        "\u{1b}[33m" // warn — yellow
    } else if level >= 30 {
        "\u{1b}[32m" // info — green
    } else if level >= 20 {
        "\u{1b}[34m" // debug — blue
    } else {
        "\u{1b}[38;5;240m" // trace — dark gray
    }
}

/// Writes one NDJSON pino `line` to `out`/`err` as the pretty stream would.
///
/// Mirrors the `write` callback of `createPrettyStream`: parses the message and
/// level, routes error/fatal (level ≥ 50) to `err` and everything else to
/// `out`, colorizes by severity when `colorize` is set, and emits nothing while
/// the terminal is suspended. Non-JSON input is emitted verbatim under `out`.
pub fn write_pretty_line<O: Write, E: Write>(
    line: &str,
    out: &mut O,
    err: &mut E,
    colorize: bool,
) -> io::Result<()> {
    if is_terminal_suspended() {
        return Ok(());
    }

    let mut level: u16 = 30;
    let message: String = match serde_json::from_str::<Value>(line) {
        Ok(record) => {
            level = record
                .get("level")
                .and_then(Value::as_u64)
                .map(|n| n as u16)
                .unwrap_or(30);
            record
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        }
        Err(_) => strip_trailing_newline(line).to_string(),
    };

    if message.is_empty() {
        return Ok(());
    }

    let rendered = if colorize {
        format!("{}{}{}\n", color_for_level(level), message, RESET)
    } else {
        format!("{message}\n")
    };

    if level >= 50 {
        err.write_all(rendered.as_bytes())
    } else {
        out.write_all(rendered.as_bytes())
    }
}

/// Strips a single trailing `\r?\n`, matching the JS `replace(/\r?\n$/, "")`.
fn strip_trailing_newline(s: &str) -> &str {
    s.strip_suffix('\n')
        .map(|t| t.strip_suffix('\r').unwrap_or(t))
        .unwrap_or(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(level: u16, msg: &str) -> String {
        json!({ "level": level, "msg": msg }).to_string()
    }

    fn render(input: &[String], colorize: bool) -> (String, String) {
        let _guard = crate::test_lock();
        set_terminal_suspended(false);
        let mut out: Vec<u8> = Vec::new();
        let mut err: Vec<u8> = Vec::new();
        for l in input {
            write_pretty_line(l, &mut out, &mut err, colorize).unwrap();
        }
        (
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    #[test]
    fn routes_info_warn_to_out_error_fatal_to_err() {
        let (out, err) = render(
            &[
                line(30, "an info"),
                line(40, "a warn"),
                line(50, "an error"),
                line(20, "a debug"),
            ],
            false,
        );
        assert!(out.contains("an info"));
        assert!(out.contains("a warn"));
        assert!(!out.contains("an error"));
        assert!(err.contains("an error"));
        assert!(out.contains("a debug")); // debug routes to out (level < 50)
    }

    #[test]
    fn prints_only_the_message_no_level_timestamp_or_pid() {
        let record = json!({
            "level": 30,
            "time": 1,
            "role": "client",
            "pid": 4242,
            "component": "demo",
            "extra": "field",
            "msg": "hello world",
        })
        .to_string();
        let (out, _err) = render(&[record], false);
        assert_eq!(out, "hello world\n");
        assert!(!out.contains("4242"));
        assert!(!out.contains("component"));
        assert!(!out.contains("level"));
    }

    #[test]
    fn colorizes_the_message_by_level() {
        let (out, _err) = render(&[line(40, "warn message")], true);
        assert_eq!(out, "\u{1b}[33mwarn message\u{1b}[0m\n");
    }

    #[test]
    fn suspended_terminal_mutes_both_streams() {
        let _guard = crate::test_lock();
        let mut out: Vec<u8> = Vec::new();
        let mut err: Vec<u8> = Vec::new();
        set_terminal_suspended(true);
        write_pretty_line(&line(30, "hidden"), &mut out, &mut err, false).unwrap();
        write_pretty_line(&line(50, "hidden too"), &mut out, &mut err, false).unwrap();
        set_terminal_suspended(false);
        assert!(out.is_empty());
        assert!(err.is_empty());
    }

    #[test]
    fn non_json_line_emitted_verbatim_under_out() {
        let (out, err) = render(&["not json\n".to_string()], false);
        assert_eq!(out, "not json\n");
        assert!(err.is_empty());
    }
}
