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

/// Removes the credential sidecar and ownership lock for `id` (idempotent).
/// Returns `true` if either artifact actually existed and was removed. Used to
/// reap sessions whose daemon died without cleaning up.
pub fn remove_ipc_artifacts(env: &Env, id: &str) -> StoreResult<bool> {
    validate_session_id(id)?;
    let mut removed = false;
    match fs::remove_file(env.ipc_auth_path(id)) {
        Ok(()) => removed = true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(StoreError::Io(e)),
    }
    let lock = env.sessions_dir().join(format!("{id}.ipc-lock"));
    match fs::remove_dir_all(&lock) {
        Ok(()) => removed = true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(StoreError::Io(e)),
    }
    Ok(removed)
}

/// Reaps IPC artifacts for every session whose recorded `daemon_pid` is present
/// but no longer alive (per `is_alive`). Sessions with no `daemon_pid` are left
/// untouched (they may be mid-startup or remote). Returns the ids whose
/// artifacts actually existed and were removed (so already-clean dead sessions
/// are not re-reported). Per-session errors (e.g. an unexpected id) are skipped,
/// not fatal.
pub fn reap_dead_session_ipc_artifacts(
    env: &Env,
    is_alive: &dyn Fn(i64) -> bool,
) -> StoreResult<Vec<String>> {
    let mut reaped = Vec::new();
    for meta in crate::meta::list_sessions(env)? {
        match meta.daemon_pid {
            Some(pid)
                if !is_alive(i64::from(pid))
                    && remove_ipc_artifacts(env, &meta.id).unwrap_or(false) =>
            {
                reaped.push(meta.id);
            }
            _ => {}
        }
    }
    Ok(reaped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meta::write_session_meta;
    use crate::paths::now_iso;
    use climon_proto::meta::{PriorityReason, SessionMeta, SessionStatus};
    use std::fs;

    fn env_for(tag: &str) -> Env {
        let home = crate::test_support::scratch_dir(tag);
        fs::create_dir_all(home.join("sessions")).unwrap();
        Env::with_home(home)
    }

    fn base_meta(id: &str, daemon_pid: Option<u32>) -> SessionMeta {
        let now = now_iso();
        SessionMeta {
            id: id.to_string(),
            command: vec!["sleep".into(), "100".into()],
            display_command: "sleep 100".into(),
            cwd: "/tmp".into(),
            status: SessionStatus::Running,
            priority_reason: PriorityReason::Running,
            daemon_pid,
            cols: 80,
            rows: 24,
            headless: None,
            socket_path: "tcp://127.0.0.1:0".into(),
            client_version: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_activity_at: now,
            attention_matched_at: None,
            attention_reason: None,
            completed_at: None,
            exit_code: None,
            error: None,
            origin: None,
            client_label: None,
            name: None,
            priority: None,
            color: None,
            user_paused: None,
            theme: None,
            terminal_title: None,
            attention_snippet: None,
            progress: None,
            ipc_protocol_version: None,
            ipc_generation: None,
        }
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
    fn cleanup_removes_orphaned_ipc_sidecar_and_lock() {
        let env = env_for("cleanup-ipc");
        let rec = mint("tcp://127.0.0.1:5555");
        write(&env, "rare-geckos-jam", &rec).unwrap();
        std::fs::create_dir_all(env.sessions_dir().join("rare-geckos-jam.ipc-lock")).unwrap();
        remove_ipc_artifacts(&env, "rare-geckos-jam").unwrap();
        assert!(read(&env, "rare-geckos-jam").unwrap().is_none());
        assert!(!env.sessions_dir().join("rare-geckos-jam.ipc-lock").exists());
        let _ = std::fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn reaper_removes_ipc_artifacts_only_for_dead_daemons() {
        let env = env_for("reap-ipc");
        let alive_id = "brave-otters-run";
        let dead_id = "rare-geckos-jam";
        let alive_pid = 4242_u32;
        let dead_pid = 4343_u32;
        let rec = mint("tcp://127.0.0.1:5555");

        write_session_meta(&env, &base_meta(alive_id, Some(alive_pid))).unwrap();
        write_session_meta(&env, &base_meta(dead_id, Some(dead_pid))).unwrap();
        for id in [alive_id, dead_id] {
            write(&env, id, &rec).unwrap();
            std::fs::create_dir_all(env.sessions_dir().join(format!("{id}.ipc-lock"))).unwrap();
        }

        let reaped =
            reap_dead_session_ipc_artifacts(&env, &|pid| pid == i64::from(alive_pid)).unwrap();

        assert_eq!(reaped, vec![dead_id.to_string()]);
        assert!(read(&env, alive_id).unwrap().is_some());
        assert!(env
            .sessions_dir()
            .join(format!("{alive_id}.ipc-lock"))
            .exists());
        assert!(read(&env, dead_id).unwrap().is_none());
        assert!(!env
            .sessions_dir()
            .join(format!("{dead_id}.ipc-lock"))
            .exists());
        let _ = std::fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn reaper_skips_dead_daemons_with_no_ipc_artifacts() {
        // A dead session whose artifacts are already gone (e.g. removed on a
        // graceful exit or a prior cleanup) must NOT be re-reported as reaped.
        let env = env_for("reap-ipc-noartifacts");
        let dead_id = "rare-geckos-jam";
        write_session_meta(&env, &base_meta(dead_id, Some(4343))).unwrap();
        // Deliberately write NO sidecar and NO lock dir.

        let reaped = reap_dead_session_ipc_artifacts(&env, &|_| false).unwrap();

        assert!(reaped.is_empty(), "reaped nothing but reported: {reaped:?}");
        let _ = std::fs::remove_dir_all(env.climon_home());
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
