//! Exclusive daemon-ownership guard for a session id.
//!
//! A directory `sessions/<id>.ipc-lock/` created with `mkdir` (atomic) proves a
//! single daemon owns the session. The guard is held for the whole listener
//! lifetime and removed on drop, so a second daemon for the same id fails fast
//! instead of racing to bind a second endpoint.

use crate::error::{StoreError, StoreResult};
use crate::paths::Env;
use crate::session_id::validate_session_id;
use std::fs;
use std::path::PathBuf;

/// RAII ownership guard. The lock directory is removed on drop.
#[derive(Debug)]
pub struct IpcOwnershipGuard {
    dir: PathBuf,
}

impl IpcOwnershipGuard {
    /// Attempts to take exclusive ownership of `id`. Returns
    /// `Err(StoreError::Validation)` if another daemon already owns it.
    pub fn acquire(env: &Env, id: &str) -> StoreResult<Self> {
        validate_session_id(id)?;
        let dir = env.sessions_dir().join(format!("{id}.ipc-lock"));
        if let Some(parent) = dir.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::create_dir(&dir) {
            Ok(()) => Ok(IpcOwnershipGuard { dir }),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(StoreError::Validation(
                format!("Session {id} is already owned by a live daemon"),
            )),
            Err(e) => Err(StoreError::Io(e)),
        }
    }
}

impl Drop for IpcOwnershipGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_for(tag: &str) -> Env {
        let home = crate::test_support::scratch_dir(tag);
        fs::create_dir_all(home.join("sessions")).unwrap();
        Env::with_home(home)
    }

    #[test]
    fn second_acquire_fails_until_first_is_dropped() {
        let env = env_for("ipc-lock");
        let g1 = IpcOwnershipGuard::acquire(&env, "rare-geckos-jam").unwrap();
        assert!(IpcOwnershipGuard::acquire(&env, "rare-geckos-jam").is_err());
        drop(g1);
        let g2 = IpcOwnershipGuard::acquire(&env, "rare-geckos-jam");
        assert!(g2.is_ok());
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn rejects_invalid_ids() {
        let env = env_for("ipc-lock-badid");
        assert!(IpcOwnershipGuard::acquire(&env, "../escape").is_err());
        let _ = fs::remove_dir_all(env.climon_home());
    }
}
