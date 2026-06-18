//! Error type for the PTY layer.

use std::fmt;

/// Result alias for fallible PTY operations.
pub type PtyResult<T> = Result<T, PtyError>;

/// Errors raised while spawning or driving a PTY.
#[derive(Debug)]
pub enum PtyError {
    /// The command vector was empty (nothing to spawn).
    EmptyCommand,
    /// An underlying I/O error.
    Io(std::io::Error),
    /// A `portable-pty` backend error (openpty/spawn/resize/wait).
    Backend(String),
    /// The writer was already taken (each PTY yields one writer).
    WriterTaken,
}

impl fmt::Display for PtyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PtyError::EmptyCommand => write!(f, "cannot spawn an empty command"),
            PtyError::Io(e) => write!(f, "io error: {e}"),
            PtyError::Backend(e) => write!(f, "pty backend error: {e}"),
            PtyError::WriterTaken => write!(f, "pty writer already taken"),
        }
    }
}

impl std::error::Error for PtyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            PtyError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for PtyError {
    fn from(e: std::io::Error) -> Self {
        PtyError::Io(e)
    }
}
