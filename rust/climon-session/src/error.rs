//! Error type for the session host.

use std::fmt;

/// Errors raised while running the session host.
#[derive(Debug)]
pub enum SessionError {
    /// A PTY-layer failure (spawn/resize/wait/kill).
    Pty(climon_pty::PtyError),
    /// A metadata-store failure.
    Store(climon_store::StoreError),
    /// A configuration-load failure.
    Config(String),
    /// An I/O failure (socket bind/accept, local relay).
    Io(std::io::Error),
    /// The requested session metadata was missing.
    MissingMeta(String),
}

/// Convenience result alias for the session host.
pub type SessionResult<T> = Result<T, SessionError>;

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SessionError::Pty(e) => write!(f, "pty error: {e}"),
            SessionError::Store(e) => write!(f, "store error: {e}"),
            SessionError::Config(e) => write!(f, "config error: {e}"),
            SessionError::Io(e) => write!(f, "io error: {e}"),
            SessionError::MissingMeta(id) => write!(f, "session metadata for '{id}' not found"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<climon_pty::PtyError> for SessionError {
    fn from(e: climon_pty::PtyError) -> Self {
        SessionError::Pty(e)
    }
}

impl From<climon_store::StoreError> for SessionError {
    fn from(e: climon_store::StoreError) -> Self {
        SessionError::Store(e)
    }
}

impl From<std::io::Error> for SessionError {
    fn from(e: std::io::Error) -> Self {
        SessionError::Io(e)
    }
}
