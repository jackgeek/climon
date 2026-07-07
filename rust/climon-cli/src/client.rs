//! Attach client: connects the local terminal to a running session daemon.
//! Port of `src/client/connect.ts`.
//!
//! The pure pieces ([`InputProcessor`], [`LocalTerminalOutputGate`],
//! [`render_local_displaced`]) are unit-tested exactly like the TS. The socket
//! loop in [`connect_to_session`] forwards keystrokes and renders PTY output,
//! and supports detaching with the configured prefix then `d`.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;

use climon_proto::frame::{
    encode_frame, encode_json_frame, parse_json_payload, ControlPayload, ExitPayload, FrameDecoder,
    FrameType, ResizePayload, SurfaceKind,
};
use climon_session::socket::connect_session_socket;

/// Default detach prefix (Ctrl-\\). Matches `connectToSession`'s default.
pub const DEFAULT_DETACH_PREFIX: u8 = 0x1c;

const DETACH_KEY: u8 = 0x64; // 'd'
const TAKE_CONTROL_KEY: u8 = 0x14; // Ctrl+T

/// The action requested by a processed input chord. Mirrors the TS
/// `InputAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputAction {
    None,
    Detach,
    TakeControl,
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

/// Suppresses local PTY rendering while this terminal is displaced (the shared
/// grid is larger than the local console, so a bigger surface controls it).
#[derive(Default)]
pub struct LocalTerminalOutputGate {
    displaced: bool,
    just_restored: bool,
}

impl LocalTerminalOutputGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Updates displaced state from a `Control` frame. Records a
    /// displaced→not-displaced edge so the caller can request a repaint.
    pub fn set_displaced(&mut self, displaced: bool) {
        if self.displaced && !displaced {
            self.just_restored = true;
        }
        self.displaced = displaced;
    }

    pub fn is_displaced(&self) -> bool {
        self.displaced
    }

    /// Consumes the "just became un-displaced" edge (one-shot).
    pub fn take_just_restored(&mut self) -> bool {
        std::mem::take(&mut self.just_restored)
    }

    /// Returns the payload to write, or `None` while displaced (output paused).
    pub fn write_pty_output(&self, payload: &[u8]) -> Option<Vec<u8>> {
        if self.displaced {
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

    pub fn process(&mut self, chunk: &[u8], displaced: bool) -> ProcessedInput {
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
                // Incomplete detach chord: only replay the prefix+byte when
                // interactive; while displaced the command is non-interactive.
                if !displaced {
                    out.push(self.prefix);
                    out.push(byte);
                }
            } else if byte == self.prefix {
                self.armed = true;
            } else if displaced {
                // Non-interactive: only Ctrl+T (take control) is accepted; all
                // other input is swallowed.
                if byte == TAKE_CONTROL_KEY {
                    return ProcessedInput {
                        forward: out,
                        action: InputAction::TakeControl,
                    };
                }
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

/// The centered notice shown on the local terminal when it is displaced (the
/// shared PTY is larger than this console). Clears the screen and centers a
/// friendly message + take-control hint. Mirrors the daemon's
/// `render_local_displaced`.
pub fn render_local_displaced(cols: u16, rows: u16) -> String {
    let (w, h) = (cols.max(1), rows.max(1));
    let mut out = String::from("\x1b[2J\x1b[H");
    let msg = "This session is being viewed on a climon dashboard.";
    let hint = "Press Ctrl+T to take control and resize it to this terminal.";
    let row = (h / 2).max(1);
    for (i, line) in [msg, hint].iter().enumerate() {
        let col = ((w as usize).saturating_sub(line.len()) / 2 + 1).max(1);
        out.push_str(&format!("\x1b[{};{}H{}", row as usize + i, col, line));
    }
    out
}

/// Processes a single decoded frame from the daemon, writing PTY output to
/// `out` and updating the gate/exit-code. Pure (no socket / raw-mode side
/// effects) so it is unit-testable.
pub fn consume_frame<W: Write>(
    frame_type: FrameType,
    payload: &[u8],
    gate: &mut LocalTerminalOutputGate,
    out: &mut W,
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
        FrameType::Control => {
            if let Ok(ctrl) = parse_json_payload::<ControlPayload>(payload) {
                let (tcols, trows) = local_terminal_size();
                let displaced = tcols < ctrl.cols || trows < ctrl.rows;
                gate.set_displaced(displaced);
                if displaced {
                    let _ = out.write_all(render_local_displaced(tcols, trows).as_bytes());
                    let _ = out.flush();
                } else if gate.take_just_restored() {
                    // Fits again: clear the notice; the next Output/Replay repaints.
                    let _ = out.write_all(b"\x1b[2J\x1b[H");
                    let _ = out.flush();
                }
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

/// Windows console raw-mode guard for the attach client's standard handles.
///
/// Mirrors the Unix [`RawModeGuard`] and the legacy TS client's
/// `stdin.setRawMode(true)`: it puts the console *input* buffer into raw mode so
/// keystrokes are delivered to the session immediately (not line-buffered,
/// echoed, or intercepted as Ctrl-C) and translated to VT sequences, and enables
/// VT *output* processing so the PTY's escape sequences render. The previous
/// modes are restored on drop so cmd.exe/PowerShell are never left in raw mode.
///
/// Without this, the local terminal stays in cooked mode and the user cannot
/// type interactively into the session from the launching console — only the
/// dashboard's input frames reach the PTY.
#[cfg(windows)]
struct RawModeGuard {
    in_handle: windows_sys::Win32::Foundation::HANDLE,
    out_handle: windows_sys::Win32::Foundation::HANDLE,
    saved_in: u32,
    saved_out: u32,
    in_active: bool,
    out_active: bool,
}

#[cfg(windows)]
impl RawModeGuard {
    fn enable() -> Option<RawModeGuard> {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::Console::{
            GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT,
            ENABLE_PROCESSED_INPUT, ENABLE_VIRTUAL_TERMINAL_INPUT,
            ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
        };

        unsafe {
            let in_handle = GetStdHandle(STD_INPUT_HANDLE);
            if in_handle.is_null() || in_handle == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut saved_in: u32 = 0;
            // Fails when stdin is not a console (redirected from a pipe/file):
            // there is no console mode to flip, so leave it untouched.
            if GetConsoleMode(in_handle, &mut saved_in) == 0 {
                return None;
            }
            let raw_in = (saved_in
                & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT))
                | ENABLE_VIRTUAL_TERMINAL_INPUT;
            if SetConsoleMode(in_handle, raw_in) == 0 {
                return None;
            }

            // Best-effort: enable VT output processing so PTY escape sequences
            // render. A failure here must not disable input forwarding.
            let out_handle = GetStdHandle(STD_OUTPUT_HANDLE);
            let mut saved_out: u32 = 0;
            let out_active = !out_handle.is_null()
                && out_handle != INVALID_HANDLE_VALUE
                && GetConsoleMode(out_handle, &mut saved_out) != 0
                && SetConsoleMode(out_handle, saved_out | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0;

            Some(RawModeGuard {
                in_handle,
                out_handle,
                saved_in,
                saved_out,
                in_active: true,
                out_active,
            })
        }
    }
}

#[cfg(windows)]
impl Drop for RawModeGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Console::SetConsoleMode;
        unsafe {
            if self.in_active {
                SetConsoleMode(self.in_handle, self.saved_in);
            }
            if self.out_active {
                SetConsoleMode(self.out_handle, self.saved_out);
            }
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
                kind: Some(SurfaceKind::Terminal),
                viewer_id: Some("local".to_string()),
            },
        ));
        let _ = w.flush();
    }

    #[cfg(unix)]
    let _raw_guard = RawModeGuard::enable();
    #[cfg(windows)]
    let _raw_guard = RawModeGuard::enable();

    let exit_code = Arc::new(AtomicI32::new(0));
    let detached = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let displaced = Arc::new(AtomicBool::new(false));
    let reader_displaced = Arc::clone(&displaced);

    // Reader thread: decode daemon frames → stdout / exit.
    let reader_stream = stream.try_clone_box()?;
    let reader_exit = Arc::clone(&exit_code);
    let reader_done = Arc::clone(&done);
    let reader = std::thread::spawn(move || {
        let mut decoder = FrameDecoder::new();
        let mut gate = LocalTerminalOutputGate::new();
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
                            &mut out,
                            &mut code,
                        );
                    }
                    reader_exit.store(code, Ordering::SeqCst);
                    reader_displaced.store(gate.is_displaced(), Ordering::SeqCst);
                }
            }
        }
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
                    kind: Some(SurfaceKind::Terminal),
                    viewer_id: Some("local".to_string()),
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
            let is_displaced = displaced.load(Ordering::SeqCst);
            let processed = input.process(&buf[..n], is_displaced);
            if !processed.forward.is_empty() {
                let mut w = writer.lock().unwrap();
                let _ = w.write_all(&encode_frame(FrameType::Input, &processed.forward));
                let _ = w.flush();
            }
            match processed.action {
                InputAction::TakeControl => {
                    let mut w = writer.lock().unwrap();
                    let _ = w.write_all(&encode_frame(FrameType::TakeControl, &[]));
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
            let is_displaced = displaced.load(Ordering::SeqCst);
            let processed = input.process(&buf[..n], is_displaced);
            if !processed.forward.is_empty() {
                let mut w = writer.lock().unwrap();
                let _ = w.write_all(&encode_frame(FrameType::Input, &processed.forward));
                let _ = w.flush();
            }
            match processed.action {
                InputAction::TakeControl => {
                    let mut w = writer.lock().unwrap();
                    let _ = w.write_all(&encode_frame(FrameType::TakeControl, &[]));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detach_chord_requests_detach_without_forwarding() {
        let mut p = InputProcessor::new(0x1c);
        assert_eq!(
            p.process(&[0x1c, 0x64], false),
            ProcessedInput {
                forward: vec![],
                action: InputAction::Detach
            }
        );
    }

    #[test]
    fn non_command_prefixed_input_is_forwarded_unchanged() {
        let mut p = InputProcessor::new(0x1c);
        assert_eq!(
            p.process(&[0x1c, 0x78], false),
            ProcessedInput {
                forward: vec![0x1c, 0x78],
                action: InputAction::None
            }
        );
    }

    #[test]
    fn ctrl_t_takes_control_only_while_displaced() {
        let mut p = InputProcessor::new(0x1c);
        // While displaced: Ctrl+T -> TakeControl, swallowed (no forward).
        assert_eq!(
            p.process(&[0x14], true),
            ProcessedInput {
                forward: vec![],
                action: InputAction::TakeControl
            }
        );
        // While displaced: other input is swallowed.
        assert_eq!(
            p.process(&[b'a', b'b'], true),
            ProcessedInput {
                forward: vec![],
                action: InputAction::None
            }
        );
        // While NOT displaced: Ctrl+T forwards as a normal byte.
        assert_eq!(
            p.process(&[0x14], false),
            ProcessedInput {
                forward: vec![0x14],
                action: InputAction::None
            }
        );
    }

    #[test]
    fn gate_suppresses_while_displaced_and_resumes_after_restore() {
        let mut gate = LocalTerminalOutputGate::new();
        assert_eq!(gate.write_pty_output(b"before"), Some(b"before".to_vec()));
        gate.set_displaced(true);
        assert_eq!(gate.write_pty_output(b"hidden"), None);
        assert!(!gate.take_just_restored());
        gate.set_displaced(false);
        assert!(gate.take_just_restored());
        assert!(!gate.take_just_restored());
        assert_eq!(gate.write_pty_output(b"after"), Some(b"after".to_vec()));
    }
}
