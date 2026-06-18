//! Minimal terminal helpers: raw-mode guard and window-size query.
//!
//! Both the host (local relay) and the viewer need to place the controlling
//! terminal in raw mode so keystrokes pass through untransformed, and to read
//! the terminal's column/row dimensions.
//!
//! On Unix these use termios / `TIOCGWINSZ` ioctls. On Windows ConPTY manages
//! controlling-terminal semantics itself, so [`RawMode`] is a no-op guard and
//! [`terminal_size`] returns the default unless a console-size query is added.

/// The conventional fallback terminal size (cols, rows) when the real size
/// cannot be determined.
pub const DEFAULT_SIZE: (u16, u16) = (80, 24);

#[cfg(unix)]
mod imp {
    use super::DEFAULT_SIZE;
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
        /// Enables raw mode on `fd`. Returns `Ok` with a no-op guard if `fd` is
        /// not a TTY (e.g. piped input), so callers don't need to special-case
        /// pipes.
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

    /// Returns the (cols, rows) size of the terminal on `fd`, or a sensible
    /// default (80x24) when the size cannot be determined.
    pub fn terminal_size(fd: RawFd) -> (u16, u16) {
        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) };
        if rc != 0 || ws.ws_col == 0 || ws.ws_row == 0 {
            return DEFAULT_SIZE;
        }
        (ws.ws_col, ws.ws_row)
    }
}

#[cfg(windows)]
mod imp {
    use super::DEFAULT_SIZE;
    use std::io;

    /// No-op raw-mode guard on Windows: ConPTY manages controlling-terminal
    /// semantics itself, so there is no termios to flip.
    pub struct RawMode {
        _private: (),
    }

    impl RawMode {
        /// Always succeeds with a no-op guard. The `fd` is accepted for API
        /// parity with the Unix implementation and ignored.
        pub fn enable(_fd: std::os::windows::io::RawHandle) -> io::Result<RawMode> {
            Ok(RawMode { _private: () })
        }
    }

    /// Returns the default terminal size. A real console-size query can be
    /// added later via `GetConsoleScreenBufferInfo`; ConPTY sessions are driven
    /// by an explicit size from the caller.
    pub fn terminal_size(_handle: std::os::windows::io::RawHandle) -> (u16, u16) {
        DEFAULT_SIZE
    }
}

pub use imp::{terminal_size, RawMode};

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn terminal_size_defaults_for_non_tty() {
        use std::os::unix::io::AsRawFd;
        // A pipe is not a TTY, so the size query falls back to the default.
        let (reader, _writer) = std::io::pipe().expect("pipe");
        assert_eq!(terminal_size(reader.as_raw_fd()), DEFAULT_SIZE);
    }

    #[cfg(unix)]
    #[test]
    fn raw_mode_is_noop_on_non_tty() {
        use std::os::unix::io::AsRawFd;
        let (reader, _writer) = std::io::pipe().expect("pipe");
        // Enabling raw mode on a pipe must succeed as a no-op guard.
        let guard = RawMode::enable(reader.as_raw_fd());
        assert!(guard.is_ok());
    }
}
