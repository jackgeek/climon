//! Attach client: connects the local terminal to a running session daemon.
//! Port of `src/client/connect.ts`.
//!
//! The pure pieces ([`InputProcessor`], [`LocalTerminalOutputGate`],
//! [`render_terminal_warning`]) are unit-tested exactly like the TS. The socket
//! loop in [`connect_to_session`] forwards keystrokes and renders PTY output,
//! and supports detaching with the configured prefix then `d`.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;

use climon_proto::frame::{
    encode_frame, encode_json_frame, parse_json_payload, ExitPayload, FrameDecoder, FrameType,
    ResizePayload, ResizeSource, TerminalModePayload, TerminalResizeMode, TerminalWarningPayload,
    TitlePayload,
};
use climon_session::socket::connect_session_socket;

use crate::detach_key::describe_detach_key;
use crate::title::TitleController;

/// Default detach prefix (Ctrl-\\). Matches `connectToSession`'s default.
pub const DEFAULT_DETACH_PREFIX: u8 = 0x1c;

const DETACH_KEY: u8 = 0x64; // 'd'
const RESTORE_CLAMPED_KEY: u8 = 0x63; // 'c'

/// The action requested by a processed input chord. Mirrors the TS
/// `InputAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputAction {
    None,
    Detach,
    RestoreClamped,
}

/// Result of [`InputProcessor::process`]. Mirrors `ProcessedInput`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessedInput {
    pub forward: Vec<u8>,
    pub action: InputAction,
}

/// The outcome of an attach session. Mirrors `AttachResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachResult {
    pub detached: bool,
    pub exit_code: i32,
}

/// Suppresses local PTY rendering while the browser terminal is overgrown.
/// Mirrors `LocalTerminalOutputGate`.
#[derive(Default)]
pub struct LocalTerminalOutputGate {
    suppress_pty_output: bool,
}

impl LocalTerminalOutputGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply_warning(&mut self, warning: &TerminalWarningPayload) {
        self.suppress_pty_output = matches!(warning, TerminalWarningPayload::Overgrown { .. });
    }

    /// Returns the payload to write, or `None` while output is suppressed.
    pub fn write_pty_output(&self, payload: &[u8]) -> Option<Vec<u8>> {
        if self.suppress_pty_output {
            None
        } else {
            Some(payload.to_vec())
        }
    }
}

/// Detects the detach prefix chord in the local input stream. Mirrors
/// `InputProcessor`.
pub struct InputProcessor {
    prefix: u8,
    armed: bool,
}

impl InputProcessor {
    pub fn new(prefix: u8) -> Self {
        InputProcessor {
            prefix,
            armed: false,
        }
    }

    pub fn process(&mut self, chunk: &[u8]) -> ProcessedInput {
        let mut out: Vec<u8> = Vec::new();
        for &byte in chunk {
            if self.armed {
                self.armed = false;
                if byte == DETACH_KEY {
                    return ProcessedInput {
                        forward: out,
                        action: InputAction::Detach,
                    };
                }
                if byte == RESTORE_CLAMPED_KEY {
                    return ProcessedInput {
                        forward: out,
                        action: InputAction::RestoreClamped,
                    };
                }
                out.push(self.prefix);
                out.push(byte);
            } else if byte == self.prefix {
                self.armed = true;
            } else {
                out.push(byte);
            }
        }
        ProcessedInput {
            forward: out,
            action: InputAction::None,
        }
    }
}

/// Renders the host-side overgrown / restored terminal warning. Mirrors
/// `renderTerminalWarning`.
pub fn render_terminal_warning(warning: &TerminalWarningPayload, detach_prefix: u8) -> String {
    match warning {
        TerminalWarningPayload::Restored => {
            "\r\n\x1b[32m[climon] Local terminal rendering restored; browser terminal is clamped again.\x1b[0m\r\n".to_string()
        }
        TerminalWarningPayload::Overgrown {
            cols,
            rows,
            host_cols,
            host_rows,
        } => format!(
            "\r\n\x1b[33m[climon] The browser terminal is not clamped ({cols}x{rows}), \
which is larger than this local terminal ({host_cols}x{host_rows}). \
Local PTY output is paused here to avoid corrupt rendering. Press {} then c \
to restore clamp mode, click the lock icon on the active session in the web dashboard, \
or stop viewing the terminal in the web server.\x1b[0m\r\n",
            describe_detach_key(detach_prefix)
        ),
    }
}

/// Processes a single decoded frame from the daemon, writing PTY output to
/// `out`, applying titles via `title`, and updating the gate/exit-code. Pure
/// (no socket / raw-mode side effects) so it is unit-testable.
pub fn consume_frame<W: Write, T: Write>(
    frame_type: FrameType,
    payload: &[u8],
    gate: &mut LocalTerminalOutputGate,
    title: &mut TitleController<T>,
    out: &mut W,
    detach_prefix: u8,
    exit_code: &mut i32,
) {
    match frame_type {
        FrameType::Output | FrameType::Replay => {
            if let Some(bytes) = gate.write_pty_output(payload) {
                let _ = out.write_all(&bytes);
                let _ = out.flush();
            }
        }
        FrameType::Exit => {
            if let Ok(p) = parse_json_payload::<ExitPayload>(payload) {
                *exit_code = p.exit_code;
            }
        }
        FrameType::Title => {
            if let Ok(p) = parse_json_payload::<TitlePayload>(payload) {
                title.apply(&p.name);
            }
        }
        FrameType::TerminalWarning => {
            if let Ok(warning) = parse_json_payload::<TerminalWarningPayload>(payload) {
                gate.apply_warning(&warning);
                let _ = out.write_all(render_terminal_warning(&warning, detach_prefix).as_bytes());
                let _ = out.flush();
            }
        }
        _ => {}
    }
}

#[cfg(unix)]
fn local_terminal_size() -> (u16, u16) {
    use std::os::fd::AsRawFd;
    let fd = std::io::stdout().as_raw_fd();
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) } == 0 && ws.ws_col > 0 && ws.ws_row > 0
    {
        (ws.ws_col, ws.ws_row)
    } else {
        (80, 24)
    }
}

#[cfg(not(unix))]
fn local_terminal_size() -> (u16, u16) {
    (80, 24)
}

#[cfg(unix)]
struct RawModeGuard {
    fd: i32,
    saved: libc::termios,
    active: bool,
}

#[cfg(unix)]
impl RawModeGuard {
    fn enable() -> Option<RawModeGuard> {
        use std::os::fd::AsRawFd;
        let fd = std::io::stdin().as_raw_fd();
        if unsafe { libc::isatty(fd) } != 1 {
            return None;
        }
        let mut saved: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(fd, &mut saved) } != 0 {
            return None;
        }
        let mut raw = saved;
        unsafe { libc::cfmakeraw(&mut raw) };
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
            return None;
        }
        Some(RawModeGuard {
            fd,
            saved,
            active: true,
        })
    }
}

#[cfg(unix)]
impl Drop for RawModeGuard {
    fn drop(&mut self) {
        if self.active {
            unsafe { libc::tcsetattr(self.fd, libc::TCSANOW, &self.saved) };
        }
    }
}

/// Set by the SIGWINCH handler; drained by the attach input loop to forward a
/// terminal resize to the daemon (mirrors the TS `stdout.on("resize")`).
#[cfg(unix)]
static SIGWINCH_PENDING: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn handle_sigwinch(_: libc::c_int) {
    // Storing to an atomic is async-signal-safe.
    SIGWINCH_PENDING.store(true, Ordering::SeqCst);
}

#[cfg(unix)]
fn install_sigwinch_handler() {
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = handle_sigwinch as extern "C" fn(libc::c_int) as libc::sighandler_t;
        // No SA_RESTART: let SIGWINCH interrupt poll() so the resize is
        // forwarded promptly rather than after the poll timeout.
        action.sa_flags = 0;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGWINCH, &action, std::ptr::null_mut());
    }
}

/// Connects the local terminal to a running session daemon at `reference`,
/// forwarding keystrokes and rendering PTY output until the session exits or the
/// detach chord is pressed. Mirrors `connectToSession`.
pub fn connect_to_session(reference: &str, detach_prefix: u8) -> std::io::Result<AttachResult> {
    let stream = connect_session_socket(reference)?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(5)))?;
    let writer = stream.try_clone_box()?;
    let writer = Arc::new(std::sync::Mutex::new(writer));

    // Send the initial host resize.
    let (cols, rows) = local_terminal_size();
    {
        let mut w = writer.lock().unwrap();
        let _ = w.write_all(&encode_json_frame(
            FrameType::Resize,
            &ResizePayload {
                cols,
                rows,
                source: Some(ResizeSource::Host),
                mode: None,
            },
        ));
        let _ = w.flush();
    }

    #[cfg(unix)]
    let _raw_guard = RawModeGuard::enable();

    let exit_code = Arc::new(AtomicI32::new(0));
    let detached = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));

    // Reader thread: decode daemon frames → stdout / title / exit.
    let reader_stream = stream.try_clone_box()?;
    let reader_exit = Arc::clone(&exit_code);
    let reader_done = Arc::clone(&done);
    let reader = std::thread::spawn(move || {
        let mut decoder = FrameDecoder::new();
        let mut gate = LocalTerminalOutputGate::new();
        let stdout = std::io::stdout();
        let is_tty = is_stdout_tty();
        let mut title = TitleController::new(stdout, is_tty);
        let mut buf = [0u8; 8192];
        let mut stream = reader_stream;
        loop {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut out = std::io::stdout();
                    let mut code = reader_exit.load(Ordering::SeqCst);
                    for frame in decoder.push(&buf[..n]) {
                        consume_frame(
                            frame.frame_type,
                            &frame.payload,
                            &mut gate,
                            &mut title,
                            &mut out,
                            detach_prefix,
                            &mut code,
                        );
                    }
                    reader_exit.store(code, Ordering::SeqCst);
                }
            }
        }
        title.clear();
        reader_done.store(true, Ordering::SeqCst);
    });

    // Input loop on the main thread: stdin → Input frames, handle detach chord.
    // On Unix we poll stdin with a timeout so the loop wakes to (a) return
    // promptly when the reader thread observes session exit (`done`), and (b)
    // forward terminal resizes (SIGWINCH), matching the event-driven TS client.
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        install_sigwinch_handler();
        let stdin_fd = std::io::stdin().as_raw_fd();
        let mut input = InputProcessor::new(detach_prefix);
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 4096];
        let forward_resize = || {
            let (cols, rows) = local_terminal_size();
            let mut w = writer.lock().unwrap();
            let _ = w.write_all(&encode_json_frame(
                FrameType::Resize,
                &ResizePayload {
                    cols,
                    rows,
                    source: Some(ResizeSource::Host),
                    mode: None,
                },
            ));
            let _ = w.flush();
        };
        while !done.load(Ordering::SeqCst) {
            if SIGWINCH_PENDING.swap(false, Ordering::SeqCst) {
                forward_resize();
            }
            let mut pfd = libc::pollfd {
                fd: stdin_fd,
                events: libc::POLLIN,
                revents: 0,
            };
            let rc = unsafe { libc::poll(&mut pfd, 1, 200) };
            if rc < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue; // SIGWINCH (or other signal): re-check above.
                }
                break;
            }
            if rc == 0 || pfd.revents & libc::POLLIN == 0 {
                continue; // Timeout: re-check `done` / pending resize.
            }
            let n = match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            let processed = input.process(&buf[..n]);
            if !processed.forward.is_empty() {
                let mut w = writer.lock().unwrap();
                let _ = w.write_all(&encode_frame(FrameType::Input, &processed.forward));
                let _ = w.flush();
            }
            match processed.action {
                InputAction::RestoreClamped => {
                    let mut w = writer.lock().unwrap();
                    let _ = w.write_all(&encode_json_frame(
                        FrameType::TerminalMode,
                        &TerminalModePayload {
                            mode: TerminalResizeMode::Clamped,
                        },
                    ));
                    let _ = w.flush();
                }
                InputAction::Detach => {
                    detached.store(true, Ordering::SeqCst);
                    let _ = stream.shutdown_both();
                    break;
                }
                InputAction::None => {}
            }
        }
    }

    #[cfg(not(unix))]
    {
        let mut input = InputProcessor::new(detach_prefix);
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 4096];
        while !done.load(Ordering::SeqCst) {
            let n = match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            let processed = input.process(&buf[..n]);
            if !processed.forward.is_empty() {
                let mut w = writer.lock().unwrap();
                let _ = w.write_all(&encode_frame(FrameType::Input, &processed.forward));
                let _ = w.flush();
            }
            match processed.action {
                InputAction::RestoreClamped => {
                    let mut w = writer.lock().unwrap();
                    let _ = w.write_all(&encode_json_frame(
                        FrameType::TerminalMode,
                        &TerminalModePayload {
                            mode: TerminalResizeMode::Clamped,
                        },
                    ));
                    let _ = w.flush();
                }
                InputAction::Detach => {
                    detached.store(true, Ordering::SeqCst);
                    let _ = stream.shutdown_both();
                    break;
                }
                InputAction::None => {}
            }
        }
    }

    let _ = stream.shutdown_both();
    let _ = reader.join();

    Ok(AttachResult {
        detached: detached.load(Ordering::SeqCst),
        exit_code: exit_code.load(Ordering::SeqCst),
    })
}

#[cfg(unix)]
fn is_stdout_tty() -> bool {
    use std::os::fd::AsRawFd;
    unsafe { libc::isatty(std::io::stdout().as_raw_fd()) == 1 }
}

#[cfg(not(unix))]
fn is_stdout_tty() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detach_chord_requests_detach_without_forwarding() {
        let mut p = InputProcessor::new(0x1c);
        assert_eq!(
            p.process(&[0x1c, 0x64]),
            ProcessedInput {
                forward: vec![],
                action: InputAction::Detach
            }
        );
    }

    #[test]
    fn restore_clamped_chord_requests_restore_without_forwarding() {
        let mut p = InputProcessor::new(0x1c);
        assert_eq!(
            p.process(&[0x1c, 0x63]),
            ProcessedInput {
                forward: vec![],
                action: InputAction::RestoreClamped
            }
        );
    }

    #[test]
    fn non_command_prefixed_input_is_forwarded_unchanged() {
        let mut p = InputProcessor::new(0x1c);
        assert_eq!(
            p.process(&[0x1c, 0x78]),
            ProcessedInput {
                forward: vec![0x1c, 0x78],
                action: InputAction::None
            }
        );
    }

    #[test]
    fn overgrown_warning_explains_restore() {
        let message = render_terminal_warning(
            &TerminalWarningPayload::Overgrown {
                cols: 140,
                rows: 40,
                host_cols: 80,
                host_rows: 24,
            },
            0x1c,
        );
        assert!(message.contains("not clamped"));
        assert!(message.contains("Ctrl-\\ then c"));
        assert!(message.contains("lock icon"));
        assert!(message.contains("stop viewing"));
    }

    #[test]
    fn gate_suppresses_while_overgrown_and_resumes_after_restore() {
        let mut gate = LocalTerminalOutputGate::new();
        let overgrown = TerminalWarningPayload::Overgrown {
            cols: 140,
            rows: 40,
            host_cols: 80,
            host_rows: 24,
        };
        assert_eq!(gate.write_pty_output(b"before"), Some(b"before".to_vec()));
        gate.apply_warning(&overgrown);
        assert_eq!(gate.write_pty_output(b"hidden"), None);
        gate.apply_warning(&TerminalWarningPayload::Restored);
        assert_eq!(gate.write_pty_output(b"after"), Some(b"after".to_vec()));
    }
}
