//! Store error type shared across the crate.

use std::fmt;
use std::io;

/// Errors surfaced by the metadata store.
#[derive(Debug)]
pub enum StoreError {
    /// Underlying filesystem error.
    Io(io::Error),
    /// JSON (de)serialization error for a metadata or state file.
    Json(serde_json::Error),
    /// Timed out acquiring the cross-process patch lock for a session id.
    LockTimeout(String),
    /// A `patch_session_meta_with_current` validator rejected the current state.
    Validation(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Io(e) => write!(f, "{e}"),
            StoreError::Json(e) => write!(f, "{e}"),
            StoreError::LockTimeout(id) => {
                write!(f, "Timed out waiting for session metadata lock: {id}")
            }
            StoreError::Validation(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            StoreError::Io(e) => Some(e),
            StoreError::Json(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for StoreError {
    fn from(e: io::Error) -> Self {
        StoreError::Io(e)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        StoreError::Json(e)
    }
}

/// Convenience result alias for store operations.
pub type StoreResult<T> = Result<T, StoreError>;
