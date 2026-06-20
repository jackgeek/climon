//! Best-effort terminal window-title query. Port of `src/client/query-title.ts`.
//!
//! The pure reply parser ([`parse_title_reply`]) is unit-tested exactly like the
//! TS. The interactive [`query_terminal_title`] is a faithful unix port (raw
//! termios + `poll` with a 150 ms deadline); on non-unix or non-TTY it returns
//! `None` immediately, matching the TS early-out for non-TTY streams.

#[cfg(unix)]
const MAX_REPLY_BYTES: usize = 2048;

/// Extracts the title from a terminal's window-title report. The reply to
/// `ESC [ 21 t` is `ESC ] l <title> ST`, where ST is `ESC \\` or BEL. Returns
/// the title, or `None` if a complete reply is not present yet. Mirrors
/// `parseTitleReply`.
pub fn parse_title_reply(buf: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(buf);
    let start = text.find("\x1b]l")?;
    let rest = &text[start + 3..];
    if let Some(st_index) = rest.find("\x1b\\") {
        return Some(rest[..st_index].to_string());
    }
    if let Some(bel_index) = rest.find('\x07') {
        return Some(rest[..bel_index].to_string());
    }
    None
}

/// Best-effort read of the terminal's current window title. Returns `None`
/// immediately when not attached to a TTY (or on non-unix platforms). On unix,
/// writes `ESC [ 21 t`, waits in raw mode up to `timeout_ms` for a complete
/// reply, and always restores the prior termios. Mirrors `queryTerminalTitle`.
#[cfg(unix)]
pub fn query_terminal_title(timeout_ms: u64) -> Option<String> {
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;
    use std::time::{Duration, Instant};

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let in_fd = stdin.as_raw_fd();
    let out_fd = stdout.as_raw_fd();

    // Both ends must be a TTY (mirrors the TS `isTTY` guard on stdin + stdout).
    if unsafe { libc::isatty(in_fd) } != 1 || unsafe { libc::isatty(out_fd) } != 1 {
        return None;
    }

    // Save and switch stdin to raw so the reply isn't line-buffered or echoed.
    let mut saved: libc::termios = unsafe { std::mem::zeroed() };
    if unsafe { libc::tcgetattr(in_fd, &mut saved) } != 0 {
        return None;
    }
    let mut raw = saved;
    unsafe { libc::cfmakeraw(&mut raw) };
    if unsafe { libc::tcsetattr(in_fd, libc::TCSANOW, &raw) } != 0 {
        return None;
    }

    let result = (|| {
        {
            let mut out = stdout.lock();
            out.write_all(b"\x1b[21t").ok()?;
            out.flush().ok()?;
        }

        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 256];
        let mut handle = stdin.lock();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let mut pfd = libc::pollfd {
                fd: in_fd,
                events: libc::POLLIN,
                revents: 0,
            };
            let ms = remaining.as_millis().min(i32::MAX as u128) as i32;
            let ready = unsafe { libc::poll(&mut pfd, 1, ms) };
            if ready <= 0 {
                return None;
            }
            let n = handle.read(&mut chunk).ok()?;
            if n == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..n]);
            if let Some(title) = parse_title_reply(&buffer) {
                return Some(title);
            }
            if buffer.len() > MAX_REPLY_BYTES {
                return None;
            }
        }
    })();

    unsafe { libc::tcsetattr(in_fd, libc::TCSANOW, &saved) };
    result
}

/// Non-unix platforms cannot portably toggle raw mode here; the title query is
/// a best-effort optimization, so this returns `None` (the launcher falls back
/// to the display command for the session name).
#[cfg(not(unix))]
pub fn query_terminal_title(_timeout_ms: u64) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_st_terminated_reply() {
        assert_eq!(
            parse_title_reply(b"\x1b]lmy title\x1b\\").as_deref(),
            Some("my title")
        );
    }

    #[test]
    fn parses_bel_terminated_reply() {
        assert_eq!(
            parse_title_reply(b"\x1b]lhello\x07").as_deref(),
            Some("hello")
        );
    }

    #[test]
    fn returns_none_for_incomplete_reply() {
        assert_eq!(parse_title_reply(b"\x1b]lpartial"), None);
        assert_eq!(parse_title_reply(b"no marker here"), None);
    }
}
