//! Session metadata read/write/list, the `userPaused` overlay, the patch merge,
//! and scrollback IO. Ports `writeSessionMeta`/`readSessionMeta`/`listSessions`/
//! `removeSessionMeta`/`writeScrollback`/`readScrollback`/`applyUserPausedOverlay`
//! from `src/store.ts`.

use std::fs;
use std::io;

use climon_proto::meta::{PriorityReason, SessionMeta, SessionMetaPatch, SessionStatus};

use crate::atomic::atomic_write;
use crate::error::StoreResult;
use crate::paths::Env;

/// Statuses over which a `userPaused` marker renders the session as `paused`.
/// Mirrors `USER_PAUSED_OVERLAY_STATUSES`.
fn is_user_paused_overlay_status(status: SessionStatus) -> bool {
    matches!(
        status,
        SessionStatus::Running
            | SessionStatus::Acknowledged
            | SessionStatus::NeedsAttention
            | SessionStatus::Paused
    )
}

/// Applies the `userPaused` overlay: a user-pause marker over a non-terminal
/// status renders `paused`/`running` and clears live attention fields, so a
/// stale daemon's attention write can't override an explicit user pause. Inert
/// over terminal outcomes (completed/failed/disconnected). Mirrors
/// `applyUserPausedOverlay`.
pub fn apply_user_paused_overlay(mut meta: SessionMeta) -> SessionMeta {
    if meta.user_paused != Some(true) || !is_user_paused_overlay_status(meta.status) {
        return meta;
    }
    meta.status = SessionStatus::Paused;
    meta.priority_reason = PriorityReason::Running;
    meta.attention_matched_at = None;
    meta.attention_reason = None;
    meta
}

/// Merges a patch over a base metadata, overwriting only the fields the patch
/// carries (present `Some` overwrites; absent leaves the base). Reproduces the
/// JS object-spread `{ ...base, ...patch }` semantics, including the `color`
/// three-state (`Some(None)` = explicit null overwrites). Does NOT touch
/// `updatedAt`; the store layer stamps that after merging.
pub fn merge_patch(base: &SessionMeta, patch: &SessionMetaPatch) -> SessionMeta {
    let mut out = base.clone();
    if let Some(v) = patch.status {
        out.status = v;
    }
    if let Some(v) = patch.priority_reason {
        out.priority_reason = v;
    }
    if let Some(v) = patch.daemon_pid {
        out.daemon_pid = Some(v);
    }
    if let Some(v) = patch.last_activity_at.clone() {
        out.last_activity_at = v;
    }
    if let Some(v) = patch.attention_matched_at.clone() {
        out.attention_matched_at = v;
    }
    if let Some(v) = patch.attention_reason.clone() {
        out.attention_reason = v;
    }
    if let Some(v) = patch.completed_at.clone() {
        out.completed_at = Some(v);
    }
    if let Some(v) = patch.exit_code {
        out.exit_code = Some(v);
    }
    if let Some(v) = patch.error.clone() {
        out.error = Some(v);
    }
    if let Some(v) = patch.socket_path.clone() {
        out.socket_path = v;
    }
    if let Some(v) = patch.cols {
        out.cols = v;
    }
    if let Some(v) = patch.rows {
        out.rows = v;
    }
    if let Some(v) = patch.name.clone() {
        out.name = Some(v);
    }
    if let Some(v) = patch.priority {
        out.priority = Some(v);
    }
    if let Some(v) = patch.color {
        out.color = Some(v);
    }
    if let Some(v) = patch.theme.clone() {
        out.theme = v;
    }
    if let Some(v) = patch.user_paused {
        out.user_paused = Some(v);
    }
    if let Some(v) = patch.terminal_title.clone() {
        out.terminal_title = Some(v);
    }
    out
}

/// Serializes a `SessionMeta` exactly as `writeSessionMeta` does: pretty JSON
/// (two-space indent) with a trailing newline.
pub fn serialize_session_meta(meta: &SessionMeta) -> StoreResult<String> {
    let mut s = serde_json::to_string_pretty(meta)?;
    s.push('\n');
    Ok(s)
}

/// Atomically writes session metadata to `sessions/<id>.json`.
pub fn write_session_meta(env: &Env, meta: &SessionMeta) -> StoreResult<()> {
    let json = serialize_session_meta(meta)?;
    atomic_write(&env.session_meta_path(&meta.id), json.as_bytes())?;
    Ok(())
}

/// Reads session metadata for `id`, applying the `userPaused` overlay. Returns
/// `None` when the metadata file does not exist.
pub fn read_session_meta(env: &Env, id: &str) -> StoreResult<Option<SessionMeta>> {
    match fs::read_to_string(env.session_meta_path(id)) {
        Ok(raw) => {
            let meta: SessionMeta = serde_json::from_str(&raw)?;
            Ok(Some(apply_user_paused_overlay(meta)))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Lists all session metadata, applying the `userPaused` overlay and skipping
/// partially written or corrupt entries. Returns an empty list when the sessions
/// directory does not exist.
pub fn list_sessions(env: &Env) -> StoreResult<Vec<SessionMeta>> {
    let dir = env.sessions_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut sessions = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(meta) = serde_json::from_str::<SessionMeta>(&raw) {
                sessions.push(apply_user_paused_overlay(meta));
            }
        }
    }
    Ok(sessions)
}

/// Removes session metadata and its scrollback. Returns `false` when the
/// metadata file did not exist. Mirrors `removeSessionMeta`.
pub fn remove_session_meta(env: &Env, id: &str) -> StoreResult<bool> {
    match fs::remove_file(env.session_meta_path(id)) {
        Ok(()) => {
            let _ = fs::remove_file(env.scrollback_path(id));
            Ok(true)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Atomically writes a session's final scrollback buffer.
pub fn write_scrollback(env: &Env, id: &str, data: &[u8]) -> StoreResult<()> {
    atomic_write(&env.scrollback_path(id), data)?;
    Ok(())
}

/// Reads a session's scrollback buffer, or `None` when absent.
pub fn read_scrollback(env: &Env, id: &str) -> StoreResult<Option<Vec<u8>>> {
    match fs::read(env.scrollback_path(id)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::now_iso;
    use climon_proto::meta::AnsiColor;

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
            progress: None,
        }
    }

    fn env_for(tag: &str) -> Env {
        let home = crate::test_support::scratch_dir(tag);
        fs::create_dir_all(home.join("sessions")).unwrap();
        Env::with_home(home)
    }

    #[test]
    fn round_trips_session_meta() {
        let env = env_for("meta-roundtrip");
        let meta = base_meta("alpha-beta-gamma");
        write_session_meta(&env, &meta).unwrap();
        let read = read_session_meta(&env, "alpha-beta-gamma")
            .unwrap()
            .unwrap();
        assert_eq!(read.id, "alpha-beta-gamma");
        assert_eq!(read.status, SessionStatus::Running);
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn read_missing_is_none() {
        let env = env_for("meta-missing");
        assert!(read_session_meta(&env, "nope-nope-nope").unwrap().is_none());
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn list_skips_corrupt_and_non_json() {
        let env = env_for("meta-list");
        write_session_meta(&env, &base_meta("one-two-three")).unwrap();
        fs::write(env.sessions_dir().join("broken.json"), "{not json").unwrap();
        fs::write(env.sessions_dir().join("ignore.txt"), "x").unwrap();
        let mut listed = list_sessions(&env).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed.remove(0).id, "one-two-three");
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn user_paused_overlay_renders_paused_over_non_terminal() {
        let env = env_for("meta-overlay");
        let mut meta = base_meta("paused-over-lay");
        meta.status = SessionStatus::NeedsAttention;
        meta.priority_reason = PriorityReason::Attention;
        meta.attention_matched_at = Some("token".into());
        meta.attention_reason = Some("Screen idle".into());
        meta.user_paused = Some(true);
        write_session_meta(&env, &meta).unwrap();

        let read = read_session_meta(&env, "paused-over-lay").unwrap().unwrap();
        assert_eq!(read.status, SessionStatus::Paused);
        assert_eq!(read.priority_reason, PriorityReason::Running);
        assert!(read.attention_matched_at.is_none());
        assert!(read.attention_reason.is_none());

        let listed = list_sessions(&env).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, SessionStatus::Paused);
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn user_paused_overlay_inert_over_terminal() {
        let env = env_for("meta-overlay-terminal");
        let mut meta = base_meta("done-and-done");
        meta.status = SessionStatus::Completed;
        meta.priority_reason = PriorityReason::Completed;
        meta.completed_at = Some(now_iso());
        meta.exit_code = Some(0);
        meta.user_paused = Some(true);
        write_session_meta(&env, &meta).unwrap();

        let read = read_session_meta(&env, "done-and-done").unwrap().unwrap();
        assert_eq!(read.status, SessionStatus::Completed);
        assert_eq!(read.priority_reason, PriorityReason::Completed);
        assert_eq!(read.exit_code, Some(0));
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn merge_overwrites_only_present_fields_incl_color_three_state() {
        let base = base_meta("merge-me-now");
        let patch = SessionMetaPatch {
            daemon_pid: Some(4242),
            status: Some(SessionStatus::NeedsAttention),
            color: Some(Some(AnsiColor::Cyan)),
            ..Default::default()
        };
        let merged = merge_patch(&base, &patch);
        assert_eq!(merged.daemon_pid, Some(4242));
        assert_eq!(merged.status, SessionStatus::NeedsAttention);
        assert_eq!(merged.color, Some(Some(AnsiColor::Cyan)));
        // Untouched fields preserved.
        assert_eq!(merged.cols, 80);
        assert_eq!(merged.priority_reason, base.priority_reason);

        // Explicit-null color overwrites.
        let clear = SessionMetaPatch {
            color: Some(None),
            ..Default::default()
        };
        let merged2 = merge_patch(&merged, &clear);
        assert_eq!(merged2.color, Some(None));
    }

    #[test]
    fn merge_clears_attention_fields_on_acknowledge() {
        // Mirrors the TS daemon/session-host acknowledge flow which emits a patch
        // with `attentionMatchedAt: undefined, attentionReason: undefined` to
        // REMOVE those keys from the written metadata. The patch must distinguish
        // "clear" (Some(None)) from "leave unchanged" (None).
        let mut base = base_meta("ack-now-please");
        base.attention_matched_at = Some("2026-06-18T00:00:00.000Z".into());
        base.attention_reason = Some("Screen idle for 10s".into());

        // Absent (None) leaves the fields untouched.
        let noop = SessionMetaPatch {
            daemon_pid: Some(7),
            ..Default::default()
        };
        let after_noop = merge_patch(&base, &noop);
        assert_eq!(
            after_noop.attention_matched_at.as_deref(),
            Some("2026-06-18T00:00:00.000Z")
        );
        assert_eq!(
            after_noop.attention_reason.as_deref(),
            Some("Screen idle for 10s")
        );

        // Explicit clear (Some(None)) removes the fields.
        let ack = SessionMetaPatch {
            attention_matched_at: Some(None),
            attention_reason: Some(None),
            ..Default::default()
        };
        let acked = merge_patch(&base, &ack);
        assert!(acked.attention_matched_at.is_none());
        assert!(acked.attention_reason.is_none());
        // Cleared fields are omitted from the on-disk JSON (matching JS undefined).
        let json = serde_json::to_string(&acked).unwrap();
        assert!(!json.contains("attentionMatchedAt"), "json: {json}");
        assert!(!json.contains("attentionReason"), "json: {json}");

        // Set (Some(Some(v))) overwrites.
        let set = SessionMetaPatch {
            attention_reason: Some(Some("New reason".into())),
            ..Default::default()
        };
        let reset = merge_patch(&base, &set);
        assert_eq!(reset.attention_reason.as_deref(), Some("New reason"));
    }

    #[test]
    fn merge_sets_and_clears_theme() {
        let base = base_meta("theme-test");
        let set = SessionMetaPatch {
            theme: Some(Some("Dracula".into())),
            ..Default::default()
        };
        assert_eq!(merge_patch(&base, &set).theme.as_deref(), Some("Dracula"));

        let mut themed = base.clone();
        themed.theme = Some("Dracula".into());
        let clear = SessionMetaPatch {
            theme: Some(None),
            ..Default::default()
        };
        assert_eq!(merge_patch(&themed, &clear).theme, None);
    }

    #[test]
    fn merge_patch_sets_terminal_title() {
        let mut base = base_meta("s1");
        let patched = merge_patch(
            &base,
            &SessionMetaPatch {
                terminal_title: Some("vim README.md".into()),
                ..Default::default()
            },
        );
        assert_eq!(patched.terminal_title.as_deref(), Some("vim README.md"));
        // Absent patch field leaves the existing value untouched.
        base.terminal_title = Some("keep".into());
        let unchanged = merge_patch(&base, &SessionMetaPatch::default());
        assert_eq!(unchanged.terminal_title.as_deref(), Some("keep"));
    }

    #[test]
    fn remove_returns_false_when_absent_and_clears_scrollback() {
        let env = env_for("meta-remove");

        assert!(!remove_session_meta(&env, "ghost-ghost-ghost").unwrap());

        write_session_meta(&env, &base_meta("real-real-real")).unwrap();
        write_scrollback(&env, "real-real-real", b"scrollback").unwrap();
        assert!(remove_session_meta(&env, "real-real-real").unwrap());
        assert!(read_session_meta(&env, "real-real-real").unwrap().is_none());
        assert!(read_scrollback(&env, "real-real-real").unwrap().is_none());
        let _ = fs::remove_dir_all(env.climon_home());
    }
}
