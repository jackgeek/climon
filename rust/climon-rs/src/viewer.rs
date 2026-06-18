//! `view` command: connect to a hosted session socket and shadow it — render
//! the replay + live output, forward local keystrokes as input, and forward
//! terminal resizes. Exits when the session sends an `Exit` frame.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use crate::frame::{encode_frame, FrameDecoder, FrameType};
use crate::json::cols_rows_json;
use crate::term::{terminal_size, RawMode};

/// Connects to the session at `socket_path`, shadows it, and returns the
/// session's exit code (0 if the socket closes without an explicit Exit).
pub fn view(socket_path: &Path) -> io::Result<i32> {
    let stream = UnixStream::connect(socket_path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!(
                "could not connect to session socket {}: {}",
                socket_path.display(),
                e
            ),
        )
    })?;

    let _raw = RawMode::enable(libc::STDIN_FILENO)?;
    let running = Arc::new(AtomicBool::new(true));

    // Forward local keystrokes as Input frames.
    {
        let mut write_handle = stream.try_clone()?;
        let running = Arc::clone(&running);
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while running.load(Ordering::SeqCst) {
                let n = unsafe {
                    libc::read(
                        libc::STDIN_FILENO,
                        buf.as_mut_ptr() as *mut libc::c_void,
                        buf.len(),
                    )
                };
                if n <= 0 {
                    break;
                }
                if write_handle
                    .write_all(&encode_frame(FrameType::Input, &buf[..n as usize]))
                    .is_err()
                {
                    break;
                }
                let _ = write_handle.flush();
            }
        });
    }

    // Forward terminal resizes as Resize frames.
    {
        let mut write_handle = stream.try_clone()?;
        thread::spawn(move || {
            use signal_hook::consts::SIGWINCH;
            use signal_hook::iterator::Signals;
            let mut signals = match Signals::new([SIGWINCH]) {
                Ok(s) => s,
                Err(_) => return,
            };
            for _ in signals.forever() {
                let (cols, rows) = terminal_size(libc::STDIN_FILENO);
                let payload = cols_rows_json(cols, rows);
                if write_handle
                    .write_all(&encode_frame(FrameType::Resize, payload.as_bytes()))
                    .is_err()
                {
                    break;
                }
                let _ = write_handle.flush();
            }
        });
    }

    // Main thread: render output until the session exits.
    let mut reader = stream;
    let mut decoder = FrameDecoder::new();
    let mut buf = [0u8; 8192];
    let stdout = io::stdout();
    let mut exit_code = 0;
    'outer: loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for frame in decoder.push(&buf[..n]) {
            match frame.frame_type {
                FrameType::Output | FrameType::Replay => {
                    let mut out = stdout.lock();
                    let _ = out.write_all(&frame.payload);
                    let _ = out.flush();
                }
                FrameType::Exit => {
                    exit_code = parse_exit_code(&frame.payload);
                    break 'outer;
                }
                _ => {}
            }
        }
    }

    running.store(false, Ordering::SeqCst);
    Ok(exit_code)
}

/// Parses `{"exitCode":N}`; defaults to 0 when absent.
fn parse_exit_code(payload: &[u8]) -> i32 {
    // Reuse the resize parser shape by matching the field directly.
    let text = match std::str::from_utf8(payload) {
        Ok(t) => t,
        Err(_) => return 0,
    };
    if let Some(idx) = text.find("\"exitCode\"") {
        let rest = &text[idx + "\"exitCode\"".len()..];
        if let Some(colon) = rest.find(':') {
            let num: String = rest[colon + 1..]
                .chars()
                .skip_while(|c| c.is_whitespace())
                .take_while(|c| *c == '-' || c.is_ascii_digit())
                .collect();
            if let Ok(code) = num.parse::<i32>() {
                return code;
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::parse_exit_code;

    #[test]
    fn parses_exit_code() {
        assert_eq!(parse_exit_code(b"{\"exitCode\":0}"), 0);
        assert_eq!(parse_exit_code(b"{\"exitCode\":130}"), 130);
        assert_eq!(parse_exit_code(b"{\"exitCode\":-1}"), -1);
    }

    #[test]
    fn defaults_to_zero_when_missing() {
        assert_eq!(parse_exit_code(b"{}"), 0);
    }
}
