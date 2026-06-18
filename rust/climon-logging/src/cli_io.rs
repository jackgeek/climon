//! CLI input/output tee helpers.
//!
//! Port of `src/logging/cli-io.ts`. Writes user-facing output to stdout/stderr
//! AND mirrors it (ANSI-stripped) to the cli debug log so a command's terminal
//! output is always captured in the log files.
//!
//! The TS code routes the mirror through the i18n `logMsg` catalog
//! (`msgId`/`msgKey` + rendered template). i18n is not ported in Phase 4, so
//! this port emits the equivalent observable record directly: the rendered text
//! as `msg` plus the same structured fields (`component:"cli"`, `stream`,
//! `detail`, or `command`) at debug level.

use std::io::{self, Write};

use serde_json::json;

use crate::level::LogLevel;
use crate::logger::child;

/// Removes a single trailing `\r?\n` and ANSI SGR color codes, matching
/// `toLogMessage` (`replace(/\r?\n$/, "").replace(/\u001b\[[0-9;]*m/g, "")`).
pub fn to_log_message(text: &str) -> String {
    strip_ansi(strip_trailing_newline(text))
}

/// Removes ANSI SGR color sequences (`ESC [ [0-9;]* m`) from `text`. Other
/// escape sequences are left untouched, matching the JS regex.
pub fn strip_ansi(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            // Try to match [0-9;]* then 'm'.
            let mut j = i + 2;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b';') {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'm' {
                i = j + 1; // drop the whole SGR sequence
                continue;
            }
        }
        // Copy one UTF-8 char starting at i.
        let ch_len = utf8_char_len(bytes[i]);
        out.push_str(&text[i..i + ch_len]);
        i += ch_len;
    }
    out
}

fn utf8_char_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

fn strip_trailing_newline(s: &str) -> &str {
    s.strip_suffix('\n')
        .map(|t| t.strip_suffix('\r').unwrap_or(t))
        .unwrap_or(s)
}

fn mirror(stream: &str, text: &str) {
    let msg = to_log_message(text);
    if !msg.is_empty() {
        child("cli").log_with(
            LogLevel::Debug,
            json!({ "stream": stream, "detail": msg }),
            &msg,
        );
    }
}

/// Writes `text` to stdout and mirrors it (ANSI-stripped) to the cli debug log.
/// Pass `log = false` to skip the mirror (high-volume output like `--help`).
/// Mirrors `writeStdout`.
pub fn write_stdout(text: &str, log: bool) {
    let stdout = io::stdout();
    let _ = stdout.lock().write_all(text.as_bytes());
    if log {
        mirror("stdout", text);
    }
}

/// Like [`write_stdout`], but for stderr. Mirrors `writeStderr`.
pub fn write_stderr(text: &str, log: bool) {
    let stderr = io::stderr();
    let _ = stderr.lock().write_all(text.as_bytes());
    if log {
        mirror("stderr", text);
    }
}

/// Records a CLI command invocation at debug level. Mirrors `logCliCommand`.
pub fn log_cli_command(command: &str) {
    child("cli").log_with(
        LogLevel::Debug,
        json!({ "command": command }),
        &format!("cli command: {command}"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::Env;
    use crate::level::LogLevel;
    use crate::logger::{init_logger, reset_logger_for_tests, LoggerInitOptions};
    use crate::sinks::LogRole;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_home() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../target/lt-test-homes")
            .join(format!("cliio-{}-{}-{}", std::process::id(), n, nanos));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_client_logs(home: &Path) -> String {
        let dir = home.join("logs").join("client");
        fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| fs::read_to_string(e.path()).unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default()
    }

    fn init_client(home: &Path) {
        reset_logger_for_tests();
        init_logger(
            LogRole::Client,
            LoggerInitOptions {
                level: Some(LogLevel::Debug),
                env: Some(Env::from_pairs([("CLIMON_HOME", home.to_str().unwrap())])),
                ..Default::default()
            },
        );
    }

    #[test]
    fn strip_ansi_removes_sgr_codes() {
        assert_eq!(strip_ansi("\u{1b}[33mhi\u{1b}[0m"), "hi");
        assert_eq!(strip_ansi("plain"), "plain");
        assert_eq!(strip_ansi("\u{1b}[1;31mred\u{1b}[0m text"), "red text");
    }

    #[test]
    fn to_log_message_strips_trailing_newline_then_ansi() {
        assert_eq!(to_log_message("\u{1b}[33mclimon\u{1b}[0m\n"), "climon");
        assert_eq!(
            to_log_message("Killed session abc.\n"),
            "Killed session abc."
        );
    }

    #[test]
    fn write_stdout_mirrors_to_cli_debug_log() {
        let _guard = crate::test_lock();
        let home = temp_home();
        init_client(&home);
        write_stdout("Killed session abc.\n", true);
        let logs = read_client_logs(&home);
        assert!(logs.contains("Killed session abc."));
        assert!(logs.contains("\"component\":\"cli\""));
        assert!(logs.contains("\"stream\":\"stdout\""));
        assert!(logs.contains("\"level\":20"));
        reset_logger_for_tests();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_stderr_strips_ansi_in_the_log() {
        let _guard = crate::test_lock();
        let home = temp_home();
        init_client(&home);
        write_stderr("\u{1b}[33mclimon: nested session\u{1b}[0m\n", true);
        let logs = read_client_logs(&home);
        assert!(logs.contains("climon: nested session"));
        assert!(!logs.contains("\\u001b"));
        assert!(logs.contains("\"stream\":\"stderr\""));
        reset_logger_for_tests();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_stdout_log_false_skips_mirror() {
        let _guard = crate::test_lock();
        let home = temp_home();
        init_client(&home);
        write_stdout("no-mirror-marker\n", false);
        let logs = read_client_logs(&home);
        assert!(!logs.contains("no-mirror-marker"));
        reset_logger_for_tests();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn log_cli_command_records_the_command() {
        let _guard = crate::test_lock();
        let home = temp_home();
        init_client(&home);
        log_cli_command("cleanup");
        let logs = read_client_logs(&home);
        assert!(logs.contains("cli command: cleanup"));
        assert!(logs.contains("\"command\":\"cleanup\""));
        reset_logger_for_tests();
        let _ = fs::remove_dir_all(&home);
    }
}
