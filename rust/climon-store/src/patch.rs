//! Patch APIs with two serialization layers: a per-id in-process mutex that
//! coalesces same-process bursts (the TS `patchQueues` chain) wrapped around the
//! cross-process [`crate::lock`] directory lock. Ports `patchSessionMeta` /
//! `patchSessionMetaWithCurrent` / `patchSessionMetaFromCurrent` from `store.ts`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use climon_proto::meta::{SessionMeta, SessionMetaPatch};

use crate::error::{StoreError, StoreResult};
use crate::lock::{acquire_patch_lock, PatchLockOptions};
use crate::meta::{merge_patch, read_session_meta, write_session_meta};
use crate::paths::{now_iso, Env};

/// Process-global registry of per-id mutexes. Holding a session's mutex across
/// the whole read-merge-write serializes a same-process patch burst so two
/// patches fired on different threads never interleave and drop a field —
/// mirroring the FIFO-per-id promise chain in `store.ts`.
///
/// Accepted divergence (Phase 5 review issue #2): the TS `patchQueues` map
/// prunes a queue once it drains; this registry never evicts entries, so it
/// grows by one `Arc<Mutex<()>>` per distinct session id seen for the lifetime
/// of the process. In the Rust client the only patch writer is the per-session
/// daemon, which patches exactly one id, so the registry holds a single entry;
/// the multi-session dashboard server remains Bun. The leak is therefore
/// bounded to O(sessions touched) in test/tooling processes and negligible in
/// production. Pruning is intentionally omitted to keep the lock-free fast path
/// simple — revisit only if a single Rust process ever patches many ids.
fn id_mutex(id: &str) -> Arc<Mutex<()>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let registry = REGISTRY.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = registry.lock().unwrap_or_else(|p| p.into_inner());
    map.entry(id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn patch_queued<F>(env: &Env, id: &str, resolve: F) -> StoreResult<Option<SessionMeta>>
where
    F: FnOnce(&SessionMeta) -> StoreResult<Option<SessionMetaPatch>>,
{
    let queue = id_mutex(id);
    let _in_process = queue.lock().unwrap_or_else(|p| p.into_inner());

    let lock = acquire_patch_lock(env, id, &PatchLockOptions::default())?;
    let result: StoreResult<Option<SessionMeta>> = (|| {
        let current = match read_session_meta(env, id)? {
            Some(meta) => meta,
            None => return Ok(None),
        };
        let resolved = match resolve(&current)? {
            Some(patch) => patch,
            None => return Ok(Some(current)),
        };
        let mut updated = merge_patch(&current, &resolved);
        updated.updated_at = now_iso();
        write_session_meta(env, &updated)?;
        Ok(Some(updated))
    })();
    // Release the cross-process lock regardless of the inner outcome.
    let release = lock.release();
    let value = result?;
    release?;
    Ok(value)
}

/// Applies a static patch to a session's metadata, returning the updated meta or
/// `None` when the session does not exist. Mirrors `patchSessionMeta`.
pub fn patch_session_meta(
    env: &Env,
    id: &str,
    patch: SessionMetaPatch,
) -> StoreResult<Option<SessionMeta>> {
    patch_queued(env, id, move |_current| Ok(Some(patch)))
}

/// Validates the current metadata, then applies a static patch. If `validate`
/// returns an error the patch is rejected and nothing is written. Mirrors
/// `patchSessionMetaWithCurrent`.
pub fn patch_session_meta_with_current<V>(
    env: &Env,
    id: &str,
    patch: SessionMetaPatch,
    validate: V,
) -> StoreResult<Option<SessionMeta>>
where
    V: FnOnce(&SessionMeta) -> StoreResult<()>,
{
    patch_queued(env, id, move |current| {
        validate(current)?;
        Ok(Some(patch))
    })
}

/// Computes a patch from the current metadata (read under the lock). Returning
/// `None` leaves the session untouched (no write, no `updatedAt` bump). Mirrors
/// `patchSessionMetaFromCurrent`.
pub fn patch_session_meta_from_current<U>(
    env: &Env,
    id: &str,
    update: U,
) -> StoreResult<Option<SessionMeta>>
where
    U: FnOnce(&SessionMeta) -> Option<SessionMetaPatch>,
{
    patch_queued(env, id, move |current| Ok(update(current)))
}

/// Convenience: build a `StoreError::Validation` for a rejecting validator.
pub fn validation_error(msg: impl Into<String>) -> StoreError {
    StoreError::Validation(msg.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meta::write_session_meta;
    use climon_proto::meta::{PriorityReason, SessionStatus};
    use std::fs;
    use std::thread;

    fn base_meta(id: &str) -> SessionMeta {
        let now = now_iso();
        SessionMeta {
            id: id.to_string(),
            command: vec!["sleep".into(), "100".into()],
            display_command: "sleep 100".into(),
            cwd: "/tmp".into(),
            status: SessionStatus::Running,
            priority_reason: PriorityReason::Running,
            daemon_pid: None,
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
        }
    }

    fn env_for(tag: &str) -> Env {
        let home = crate::test_support::scratch_dir(tag);
        fs::create_dir_all(home.join("sessions")).unwrap();
        Env::with_home(home)
    }

    #[test]
    fn patch_missing_session_returns_none() {
        let env = env_for("patch-missing");
        let out = patch_session_meta(
            &env,
            "ghost-ghost-ghost",
            SessionMetaPatch {
                daemon_pid: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.is_none());
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn concurrent_patches_on_different_fields_all_persist() {
        let env = env_for("patch-burst");
        let id = "concurrent-burst";
        write_session_meta(&env, &base_meta(id)).unwrap();

        let e1 = env.clone();
        let e2 = env.clone();
        let t1 = thread::spawn(move || {
            patch_session_meta(
                &e1,
                "concurrent-burst",
                SessionMetaPatch {
                    daemon_pid: Some(4242),
                    ..Default::default()
                },
            )
            .unwrap();
        });
        let t2 = thread::spawn(move || {
            patch_session_meta(
                &e2,
                "concurrent-burst",
                SessionMetaPatch {
                    status: Some(SessionStatus::NeedsAttention),
                    priority_reason: Some(PriorityReason::Attention),
                    ..Default::default()
                },
            )
            .unwrap();
        });
        t1.join().unwrap();
        t2.join().unwrap();

        let meta = read_session_meta(&env, id).unwrap().unwrap();
        assert_eq!(meta.daemon_pid, Some(4242));
        assert_eq!(meta.status, SessionStatus::NeedsAttention);
        assert_eq!(meta.priority_reason, PriorityReason::Attention);
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn many_interleaved_patches_persist() {
        let env = env_for("patch-many");
        let id = "concurrent-many";
        write_session_meta(&env, &base_meta(id)).unwrap();

        let patches: Vec<SessionMetaPatch> = vec![
            SessionMetaPatch {
                daemon_pid: Some(4242),
                ..Default::default()
            },
            SessionMetaPatch {
                exit_code: Some(0),
                ..Default::default()
            },
            SessionMetaPatch {
                status: Some(SessionStatus::NeedsAttention),
                ..Default::default()
            },
            SessionMetaPatch {
                attention_reason: Some(Some("Screen idle for 10s".into())),
                ..Default::default()
            },
            SessionMetaPatch {
                cols: Some(120),
                rows: Some(40),
                ..Default::default()
            },
        ];
        let handles: Vec<_> = patches
            .into_iter()
            .map(|p| {
                let e = env.clone();
                thread::spawn(move || {
                    patch_session_meta(&e, "concurrent-many", p).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let meta = read_session_meta(&env, id).unwrap().unwrap();
        assert_eq!(meta.daemon_pid, Some(4242));
        assert_eq!(meta.exit_code, Some(0));
        assert_eq!(meta.status, SessionStatus::NeedsAttention);
        assert_eq!(
            meta.attention_reason.as_deref(),
            Some("Screen idle for 10s")
        );
        assert_eq!(meta.cols, 120);
        assert_eq!(meta.rows, 40);
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn with_current_validate_rejects_without_writing() {
        let env = env_for("patch-reject");
        let id = "conditional-current";
        let mut meta = base_meta(id);
        meta.status = SessionStatus::Completed;
        meta.priority_reason = PriorityReason::Completed;
        write_session_meta(&env, &meta).unwrap();

        let err = patch_session_meta_with_current(
            &env,
            id,
            SessionMetaPatch {
                status: Some(SessionStatus::Running),
                name: Some("renamed".into()),
                ..Default::default()
            },
            |current| {
                if current.status == SessionStatus::Completed {
                    Err(validation_error("cannot resume completed session"))
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert!(matches!(err, StoreError::Validation(_)));

        let after = read_session_meta(&env, id).unwrap().unwrap();
        assert_eq!(after.status, SessionStatus::Completed);
        assert!(after.name.is_none());
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn from_current_recomputes_after_earlier_write() {
        let env = env_for("patch-current");
        let id = "current-based";
        write_session_meta(&env, &base_meta(id)).unwrap();

        let e1 = env.clone();
        let e2 = env.clone();
        let t1 = thread::spawn(move || {
            patch_session_meta(
                &e1,
                "current-based",
                SessionMetaPatch {
                    status: Some(SessionStatus::Paused),
                    priority_reason: Some(PriorityReason::Running),
                    ..Default::default()
                },
            )
            .unwrap();
        });
        let t2 = thread::spawn(move || {
            patch_session_meta_from_current(&e2, "current-based", |current| {
                let paused = current.status == SessionStatus::Paused;
                Some(SessionMetaPatch {
                    status: Some(if paused {
                        SessionStatus::Paused
                    } else {
                        SessionStatus::NeedsAttention
                    }),
                    priority_reason: Some(if paused {
                        PriorityReason::Running
                    } else {
                        PriorityReason::Attention
                    }),
                    ..Default::default()
                })
            })
            .unwrap();
        });
        t1.join().unwrap();
        t2.join().unwrap();

        // Regardless of thread order the static patch forces `paused`, and the
        // current-based patch keeps `paused` when it sees it — so the result is
        // deterministic.
        let meta = read_session_meta(&env, id).unwrap().unwrap();
        assert_eq!(meta.status, SessionStatus::Paused);
        assert_eq!(meta.priority_reason, PriorityReason::Running);
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn from_current_none_leaves_session_untouched() {
        let env = env_for("patch-noop");
        let id = "noop-noop-noop";
        write_session_meta(&env, &base_meta(id)).unwrap();
        let before = read_session_meta(&env, id).unwrap().unwrap();

        let out = patch_session_meta_from_current(&env, id, |_| None).unwrap();
        assert_eq!(out.unwrap().updated_at, before.updated_at);
        let _ = fs::remove_dir_all(env.climon_home());
    }
}
