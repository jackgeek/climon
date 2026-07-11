//! Owner-only per-session IPC credential + publication record.
//!
//! The daemon mints a 32-byte CSPRNG credential and a random `generation`,
//! records the resolved endpoint, and writes them to `<id>.ipc-auth` with
//! owner-only permissions. Consumers read the same file to authenticate.

use crate::atomic::atomic_write_owner_only;
use crate::error::{StoreError, StoreResult};
use crate::paths::Env;
use crate::session_id::validate_session_id;
use serde::{Deserialize, Serialize};
use std::fs;

/// Current sidecar schema version.
pub const IPC_AUTH_VERSION: u32 = 1;

/// On-disk record. `credential` is the hex-encoded 32-byte secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IpcAuthRecord {
    pub version: u32,
    pub generation: String,
    pub endpoint: String,
    pub credential: String,
}

impl IpcAuthRecord {
    /// Decodes the hex credential into raw bytes.
    pub fn credential_bytes(&self) -> StoreResult<Vec<u8>> {
        hex::decode(&self.credential)
            .map_err(|_| StoreError::Validation("Corrupt IPC credential".into()))
    }
}

/// Mints a fresh record with a random 32-byte credential and random generation.
pub fn mint(endpoint: &str) -> IpcAuthRecord {
    let mut cred = [0u8; 32];
    getrandom::fill(&mut cred).expect("getrandom");
    let mut generation = [0u8; 16];
    getrandom::fill(&mut generation).expect("getrandom");
    IpcAuthRecord {
        version: IPC_AUTH_VERSION,
        generation: hex::encode(generation),
        endpoint: endpoint.to_string(),
        credential: hex::encode(cred),
    }
}

/// Writes the record to the owner-only sidecar for `id` (fails on invalid id).
pub fn write(env: &Env, id: &str, record: &IpcAuthRecord) -> StoreResult<()> {
    validate_session_id(id)?;
    let body = serde_json::to_vec(record)?;
    atomic_write_owner_only(&env.ipc_auth_path(id), &body)?;
    Ok(())
}

/// Reads the record for `id`, or `Ok(None)` if the sidecar is absent (legacy).
pub fn read(env: &Env, id: &str) -> StoreResult<Option<IpcAuthRecord>> {
    validate_session_id(id)?;
    let path = env.ipc_auth_path(id);
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(StoreError::Io(e)),
    }
}

/// Deletes the sidecar for `id` (idempotent).
pub fn remove(env: &Env, id: &str) -> StoreResult<()> {
    validate_session_id(id)?;
    match fs::remove_file(env.ipc_auth_path(id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(StoreError::Io(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn env_for(tag: &str) -> Env {
        let home = crate::test_support::scratch_dir(tag);
        fs::create_dir_all(home.join("sessions")).unwrap();
        Env::with_home(home)
    }

    #[test]
    fn mint_produces_distinct_64_hex_credentials() {
        let a = mint("unix:/tmp/a.sock");
        let b = mint("unix:/tmp/b.sock");
        assert_eq!(a.credential.len(), 64);
        assert_eq!(a.version, IPC_AUTH_VERSION);
        assert_ne!(a.credential, b.credential);
        assert_ne!(a.generation, b.generation);
        assert_eq!(a.credential_bytes().unwrap().len(), 32);
    }

    #[test]
    fn write_then_read_roundtrips() {
        let env = env_for("ipc-auth-roundtrip");
        let rec = mint("unix:/tmp/x.sock");
        write(&env, "rare-geckos-jam", &rec).unwrap();
        let read_back = read(&env, "rare-geckos-jam").unwrap().unwrap();
        assert_eq!(read_back, rec);
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn read_absent_is_none_and_remove_is_idempotent() {
        let env = env_for("ipc-auth-absent");
        assert!(read(&env, "rare-geckos-jam").unwrap().is_none());
        remove(&env, "rare-geckos-jam").unwrap();
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn rejects_invalid_ids() {
        let env = env_for("ipc-auth-badid");
        let rec = mint("unix:/tmp/x.sock");
        assert!(write(&env, "../escape", &rec).is_err());
        assert!(read(&env, "../escape").is_err());
        let _ = fs::remove_dir_all(env.climon_home());
    }
}
