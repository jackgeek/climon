//! Minimal terminal helpers: raw-mode guard and window-size query.
//!
//! Both the host (local relay) and the viewer need to place the controlling
//! terminal in raw mode so keystrokes pass through untransformed, and to read
//! the terminal's column/row dimensions.

use std::io;
use std::os::unix::io::RawFd;

/// Puts a terminal file descriptor into raw mode and restores the previous
/// settings when dropped, so the user's shell is never left in raw mode.
pub struct RawMode {
    fd: RawFd,
    original: libc::termios,
    active: bool,
}

impl RawMode {
    /// Enables raw mode on `fd`. Returns `Ok` with a no-op guard if `fd` is not
    /// a TTY (e.g. piped input), so callers don't need to special-case pipes.
    pub fn enable(fd: RawFd) -> io::Result<RawMode> {
        if unsafe { libc::isatty(fd) } != 1 {
            return Ok(RawMode {
                fd,
                original: unsafe { std::mem::zeroed() },
                active: false,
            });
        }
        let mut termios: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(fd, &mut termios) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let original = termios;
        unsafe { libc::cfmakeraw(&mut termios) };
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &termios) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(RawMode {
            fd,
            original,
            active: true,
        })
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        if self.active {
            unsafe { libc::tcsetattr(self.fd, libc::TCSANOW, &self.original) };
        }
    }
}

/// Returns the (cols, rows) size of the terminal on `fd`, or a sensible default
/// (80x24) when the size cannot be determined.
pub fn terminal_size(fd: RawFd) -> (u16, u16) {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) };
    if rc != 0 || ws.ws_col == 0 || ws.ws_row == 0 {
        return (80, 24);
    }
    (ws.ws_col, ws.ws_row)
}
