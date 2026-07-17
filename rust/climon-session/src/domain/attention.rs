//! Actor-domain attention state: wraps the pure [`crate::idle::ScreenIdleDetector`]
//! and [`crate::attention::should_apply_user_attention_acknowledgement`] (shared,
//! unmodified, with the legacy host) with the mutable bookkeeping needed to emit
//! attention transitions as [`SessionMetaPatch`] values. No I/O, logging, or
//! time lookups: the caller supplies a monotonic `now_ms` and an ISO wall-clock
//! timestamp for every sample.
//!
// Consumed by the aggregate actor state assembled in a later task (Task 8);
// some accessors below are unused within this crate until then.
#![allow(dead_code)]

use climon_proto::frame::AttentionPayload;
use climon_proto::meta::{PriorityReason, SessionMetaPatch, SessionStatus};

use crate::attention::should_apply_user_attention_acknowledgement;
use crate::idle::ScreenIdleDetector;
use crate::snippet::extract_snippet;

/// Origin of an attention transition. Mirrors `host::legacy::AttentionSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AttentionSource {
    Detector,
    User,
}

/// The result of an attention transition: who triggered it, the resulting
/// session status, and the [`SessionMetaPatch`] to persist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AttentionTransition {
    pub(crate) source: AttentionSource,
    pub(crate) status: SessionStatus,
    pub(crate) patch: SessionMetaPatch,
}

/// Owns the idle detector plus the bookkeeping needed to accept or reject a
/// user acknowledgement and to build the [`SessionMetaPatch`] for a
/// transition. Pure: every method takes the caller-supplied monotonic
/// `now_ms` and/or ISO wall-clock timestamp, never looking either up itself.
pub(crate) struct AttentionState {
    detector: ScreenIdleDetector,
    last_attention_state: Option<bool>,
    current_attention_matched_at: Option<String>,
    current_attention_fingerprint: Option<String>,
    snippet_enabled: bool,
}

impl AttentionState {
    /// Creates attention state whose detector flags attention after
    /// `idle_seconds` of an unchanged screen (`<= 0` disables detection), and
    /// which computes an attention snippet only when `snippet_enabled`.
    pub(crate) fn new(idle_seconds: i64, snippet_enabled: bool) -> Self {
        Self {
            detector: ScreenIdleDetector::new(idle_seconds),
            last_attention_state: None,
            current_attention_matched_at: None,
            current_attention_fingerprint: None,
            snippet_enabled,
        }
    }

    /// Feeds a screen fingerprint sample into the idle detector at `now_ms`
    /// and, when the detector reports a transition, turns it into an
    /// [`AttentionTransition`] against `current_status`. `visible_lines` and
    /// `cursor_row` are the current terminal grid, used only to compute the
    /// attention snippet when snippets are enabled and a flag is emitted.
    pub(crate) fn sample(
        &mut self,
        fingerprint: &str,
        now_ms: i64,
        wall_time: &str,
        current_status: SessionStatus,
        visible_lines: &[String],
        cursor_row: Option<usize>,
    ) -> Option<AttentionTransition> {
        let transition = self.detector.update(fingerprint, now_ms)?;
        if transition.needs_attention {
            let snippet = if self.snippet_enabled {
                extract_snippet(visible_lines, cursor_row)
            } else {
                None
            };
            self.flag(
                AttentionSource::Detector,
                transition.reason,
                fingerprint,
                wall_time,
                current_status,
                snippet,
            )
        } else {
            Some(self.clear(AttentionSource::Detector, wall_time, current_status))
        }
    }

    /// Applies a user (browser/dashboard) attention frame. When
    /// `payload.needs_attention` is false this is an acknowledgement attempt,
    /// accepted only via
    /// [`should_apply_user_attention_acknowledgement`]; `payload.attention_matched_at`
    /// is the token the caller is acknowledging, and `visible_lines`/`cursor_row`
    /// are unused. When true, this is a user-origin flag, sharing the same
    /// paused/duplicate guard as the detector; `payload.attention_matched_at` is
    /// ignored (the daemon's `wall_time` is authoritative for the token) and, like
    /// [`Self::sample`], `visible_lines`/`cursor_row` are the current terminal
    /// grid used to compute the attention snippet when snippets are enabled.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn apply_user(
        &mut self,
        payload: AttentionPayload,
        fingerprint: &str,
        now_ms: i64,
        wall_time: &str,
        current_status: SessionStatus,
        visible_lines: &[String],
        cursor_row: Option<usize>,
    ) -> Option<AttentionTransition> {
        if !payload.needs_attention {
            if !should_apply_user_attention_acknowledgement(
                self.last_attention_state,
                self.current_attention_matched_at.as_deref(),
                payload.attention_matched_at.as_deref(),
                self.current_attention_fingerprint.as_deref(),
                fingerprint,
            ) {
                return None;
            }
            // A user acknowledgement clears the detector's flagged state so a
            // later screen change cannot emit a stale revert, and marks the
            // screen acknowledged so it does not re-flag while unchanged.
            self.detector.acknowledge(fingerprint, now_ms);
            return Some(self.clear(AttentionSource::User, wall_time, current_status));
        }
        let snippet = if self.snippet_enabled {
            extract_snippet(visible_lines, cursor_row)
        } else {
            None
        };
        self.flag(
            AttentionSource::User,
            payload.reason,
            fingerprint,
            wall_time,
            current_status,
            snippet,
        )
    }

    /// Re-baselines the idle detector after a viewer resize. See
    /// [`ScreenIdleDetector::absorb_resize`].
    pub(crate) fn absorb_resize(&mut self, fingerprint: &str, now_ms: i64) {
        self.detector.absorb_resize(fingerprint, now_ms);
    }

    /// Whether the idle detector currently has the screen flagged. Diagnostic
    /// accessor for host status logging.
    pub(crate) fn is_flagged(&self) -> bool {
        self.detector.is_flagged()
    }

    /// Whether the current screen has been user-acknowledged. Diagnostic
    /// accessor for host status logging.
    pub(crate) fn is_acknowledged(&self) -> bool {
        self.detector.is_acknowledged()
    }

    /// The token (ISO timestamp) of the current outstanding attention, if
    /// any. Diagnostic accessor for host status logging.
    pub(crate) fn current_token(&self) -> Option<&str> {
        self.current_attention_matched_at.as_deref()
    }

    /// Builds a flagging transition, guarding against a duplicate flag and a
    /// paused session (attention is never raised while paused). Returns
    /// `None` when the guard rejects the flag; otherwise updates the
    /// outstanding-attention bookkeeping and returns the transition.
    fn flag(
        &mut self,
        source: AttentionSource,
        reason: Option<String>,
        fingerprint: &str,
        wall_time: &str,
        current_status: SessionStatus,
        snippet: Option<String>,
    ) -> Option<AttentionTransition> {
        if self.last_attention_state == Some(true) || current_status == SessionStatus::Paused {
            return None;
        }
        self.last_attention_state = Some(true);
        self.current_attention_matched_at = Some(wall_time.to_string());
        self.current_attention_fingerprint = Some(fingerprint.to_string());
        let patch = SessionMetaPatch {
            status: Some(SessionStatus::NeedsAttention),
            priority_reason: Some(PriorityReason::Attention),
            attention_matched_at: Some(Some(wall_time.to_string())),
            attention_reason: Some(reason),
            last_activity_at: Some(wall_time.to_string()),
            attention_snippet: Some(snippet),
            ..Default::default()
        };
        Some(AttentionTransition {
            source,
            status: SessionStatus::NeedsAttention,
            patch,
        })
    }

    /// Builds a clearing transition. A paused session stays paused; otherwise
    /// a user-origin clear becomes `Acknowledged` and a detector-origin clear
    /// becomes `Running`. Always clears the outstanding-attention bookkeeping.
    fn clear(
        &mut self,
        source: AttentionSource,
        wall_time: &str,
        current_status: SessionStatus,
    ) -> AttentionTransition {
        self.last_attention_state = Some(false);
        self.current_attention_matched_at = None;
        self.current_attention_fingerprint = None;
        let status = if current_status == SessionStatus::Paused {
            SessionStatus::Paused
        } else if source == AttentionSource::User {
            SessionStatus::Acknowledged
        } else {
            SessionStatus::Running
        };
        let patch = SessionMetaPatch {
            status: Some(status),
            priority_reason: Some(PriorityReason::Running),
            attention_matched_at: Some(None),
            attention_reason: Some(None),
            attention_snippet: Some(None),
            last_activity_at: Some(wall_time.to_string()),
            ..Default::default()
        };
        AttentionTransition {
            source,
            status,
            patch,
        }
    }
}

#[cfg(test)]
mod tests {
    use climon_proto::frame::AttentionPayload;
    use climon_proto::meta::SessionStatus;

    use super::{AttentionSource, AttentionState};

    #[test]
    fn matching_user_acknowledgement_emits_acknowledged_patch() {
        let mut state = AttentionState::new(1, false);
        assert!(state
            .sample(
                "80x24\nprompt",
                0,
                "2026-07-17T20:00:00.000Z",
                SessionStatus::Running,
                &[],
                None
            )
            .is_none());
        let flagged = state
            .sample(
                "80x24\nprompt",
                1_000,
                "2026-07-17T20:00:01.000Z",
                SessionStatus::Running,
                &[],
                None,
            )
            .unwrap();
        assert_eq!(flagged.status, SessionStatus::NeedsAttention);
        let transition = state
            .apply_user(
                AttentionPayload {
                    needs_attention: false,
                    reason: None,
                    attention_matched_at: Some("2026-07-17T20:00:01.000Z".into()),
                },
                "80x24\nprompt",
                1_100,
                "2026-07-17T20:00:01.100Z",
                SessionStatus::NeedsAttention,
                &[],
                None,
            )
            .unwrap();
        assert_eq!(transition.status, SessionStatus::Acknowledged);
        assert_eq!(transition.source, AttentionSource::User);
        assert_eq!(transition.patch.attention_matched_at, Some(None));
    }

    #[test]
    fn stale_user_acknowledgement_token_is_rejected() {
        let mut state = AttentionState::new(1, false);
        assert!(state
            .sample("80x24\nprompt", 0, "T0", SessionStatus::Running, &[], None)
            .is_none());
        let flagged = state
            .sample(
                "80x24\nprompt",
                1_000,
                "T1",
                SessionStatus::Running,
                &[],
                None,
            )
            .unwrap();
        assert_eq!(flagged.status, SessionStatus::NeedsAttention);

        let rejected = state.apply_user(
            AttentionPayload {
                needs_attention: false,
                reason: None,
                attention_matched_at: Some("WRONG-TOKEN".into()),
            },
            "80x24\nprompt",
            1_100,
            "T1.1",
            SessionStatus::NeedsAttention,
            &[],
            None,
        );
        assert!(rejected.is_none());
    }

    #[test]
    fn changed_same_dimension_fingerprint_rejects_acknowledgement() {
        let mut state = AttentionState::new(1, false);
        assert!(state
            .sample("80x24\nprompt", 0, "T0", SessionStatus::Running, &[], None)
            .is_none());
        state
            .sample(
                "80x24\nprompt",
                1_000,
                "T1",
                SessionStatus::Running,
                &[],
                None,
            )
            .unwrap();

        // Same dimensions, different content: the screen changed since attention
        // was flagged, so the acknowledgement token no longer applies.
        let rejected = state.apply_user(
            AttentionPayload {
                needs_attention: false,
                reason: None,
                attention_matched_at: Some("T1".into()),
            },
            "80x24\nCHANGED",
            1_100,
            "T1.1",
            SessionStatus::NeedsAttention,
            &[],
            None,
        );
        assert!(rejected.is_none());
    }

    #[test]
    fn differing_dimensions_accepts_matching_token_resize_parity() {
        let mut state = AttentionState::new(1, false);
        assert!(state
            .sample("80x24\nprompt", 0, "T0", SessionStatus::Running, &[], None)
            .is_none());
        state
            .sample(
                "80x24\nprompt",
                1_000,
                "T1",
                SessionStatus::Running,
                &[],
                None,
            )
            .unwrap();

        // Dimensions differ (a resize), so the content comparison is skipped and
        // the matching token is accepted.
        let transition = state
            .apply_user(
                AttentionPayload {
                    needs_attention: false,
                    reason: None,
                    attention_matched_at: Some("T1".into()),
                },
                "120x30\nprompt reflowed",
                1_100,
                "T1.1",
                SessionStatus::NeedsAttention,
                &[],
                None,
            )
            .unwrap();
        assert_eq!(transition.status, SessionStatus::Acknowledged);
    }

    #[test]
    fn paused_session_never_flags() {
        let mut state = AttentionState::new(1, false);
        assert!(state
            .sample("80x24\nprompt", 0, "T0", SessionStatus::Paused, &[], None)
            .is_none());
        let result = state.sample(
            "80x24\nprompt",
            1_000,
            "T1",
            SessionStatus::Paused,
            &[],
            None,
        );
        assert!(result.is_none());
    }

    #[test]
    fn detector_screen_change_after_flag_emits_running_and_clears_fields() {
        let mut state = AttentionState::new(1, false);
        assert!(state
            .sample("80x24\nprompt", 0, "T0", SessionStatus::Running, &[], None)
            .is_none());
        let flagged = state
            .sample(
                "80x24\nprompt",
                1_000,
                "T1",
                SessionStatus::Running,
                &[],
                None,
            )
            .unwrap();
        assert_eq!(flagged.status, SessionStatus::NeedsAttention);

        let reverted = state
            .sample(
                "80x24\nCHANGED",
                1_100,
                "T2",
                SessionStatus::Running,
                &[],
                None,
            )
            .unwrap();
        assert_eq!(reverted.status, SessionStatus::Running);
        assert_eq!(reverted.source, AttentionSource::Detector);
        assert_eq!(reverted.patch.attention_matched_at, Some(None));
        assert_eq!(reverted.patch.attention_reason, Some(None));
        assert_eq!(reverted.patch.attention_snippet, Some(None));
        assert_eq!(state.current_token(), None);
    }

    #[test]
    fn acknowledged_unchanged_screen_does_not_reflag() {
        let mut state = AttentionState::new(1, false);
        assert!(state
            .sample("80x24\nprompt", 0, "T0", SessionStatus::Running, &[], None)
            .is_none());
        state
            .sample(
                "80x24\nprompt",
                1_000,
                "T1",
                SessionStatus::Running,
                &[],
                None,
            )
            .unwrap();
        let ack = state
            .apply_user(
                AttentionPayload {
                    needs_attention: false,
                    reason: None,
                    attention_matched_at: Some("T1".into()),
                },
                "80x24\nprompt",
                1_100,
                "T1.1",
                SessionStatus::NeedsAttention,
                &[],
                None,
            )
            .unwrap();
        assert_eq!(ack.status, SessionStatus::Acknowledged);

        // Well past another idle window with the same content: no re-flag.
        let result = state.sample(
            "80x24\nprompt",
            20_000,
            "T3",
            SessionStatus::Acknowledged,
            &[],
            None,
        );
        assert!(result.is_none());
    }

    #[test]
    fn resize_settle_preserves_acknowledged() {
        let mut state = AttentionState::new(1, false);
        assert!(state
            .sample("80x24\nprompt", 0, "T0", SessionStatus::Running, &[], None)
            .is_none());
        state
            .sample(
                "80x24\nprompt",
                1_000,
                "T1",
                SessionStatus::Running,
                &[],
                None,
            )
            .unwrap();
        state
            .apply_user(
                AttentionPayload {
                    needs_attention: false,
                    reason: None,
                    attention_matched_at: Some("T1".into()),
                },
                "80x24\nprompt",
                1_100,
                "T1.1",
                SessionStatus::NeedsAttention,
                &[],
                None,
            )
            .unwrap();

        state.absorb_resize("120x30\nprompt reflowed", 1_200);
        // Async reflow output within the settle window must not revert the
        // acknowledged session.
        let result = state.sample(
            "120x30\nprompt REFLOWED DIFFERENTLY",
            1_400,
            "T2",
            SessionStatus::Acknowledged,
            &[],
            None,
        );
        assert!(result.is_none());
        assert!(state.is_acknowledged());
    }

    #[test]
    fn snippet_only_included_when_enabled_and_relevant_lines_provided() {
        let lines = vec!["  The deploy succeeded and traffic looks healthy.".to_string()];

        let mut enabled = AttentionState::new(1, true);
        assert!(enabled
            .sample("80x24\nprompt", 0, "T0", SessionStatus::Running, &[], None)
            .is_none());
        let flagged = enabled
            .sample(
                "80x24\nprompt",
                1_000,
                "T1",
                SessionStatus::Running,
                &lines,
                None,
            )
            .unwrap();
        let snippet = flagged
            .patch
            .attention_snippet
            .unwrap()
            .expect("expected a snippet when enabled");
        assert!(snippet.contains("deploy succeeded"));

        let mut disabled = AttentionState::new(1, false);
        assert!(disabled
            .sample("80x24\nprompt", 0, "T0", SessionStatus::Running, &[], None)
            .is_none());
        let flagged_disabled = disabled
            .sample(
                "80x24\nprompt",
                1_000,
                "T1",
                SessionStatus::Running,
                &lines,
                None,
            )
            .unwrap();
        assert_eq!(flagged_disabled.patch.attention_snippet, Some(None));
    }

    #[test]
    fn duplicate_true_flag_produces_no_second_transition() {
        let mut state = AttentionState::new(1, false);
        let first = state
            .apply_user(
                AttentionPayload {
                    needs_attention: true,
                    reason: Some("waiting".into()),
                    attention_matched_at: None,
                },
                "80x24\nprompt",
                0,
                "T0",
                SessionStatus::Running,
                &[],
                None,
            )
            .unwrap();
        assert_eq!(first.status, SessionStatus::NeedsAttention);

        let second = state.apply_user(
            AttentionPayload {
                needs_attention: true,
                reason: Some("waiting".into()),
                attention_matched_at: None,
            },
            "80x24\nprompt",
            100,
            "T1",
            SessionStatus::Running,
            &[],
            None,
        );
        assert!(second.is_none());
    }

    #[test]
    fn user_origin_flag_includes_snippet_when_enabled() {
        let lines = vec!["  The deploy succeeded and traffic looks healthy.".to_string()];
        let mut state = AttentionState::new(0, true);

        let transition = state
            .apply_user(
                AttentionPayload {
                    needs_attention: true,
                    reason: Some("manual".into()),
                    attention_matched_at: None,
                },
                "80x24\nprompt",
                0,
                "T0",
                SessionStatus::Running,
                &lines,
                None,
            )
            .unwrap();

        assert_eq!(
            transition.patch.attention_snippet,
            Some(Some(
                "The deploy succeeded and traffic looks healthy.".to_string()
            ))
        );
    }

    #[test]
    fn disabled_detector_never_flags_but_user_origin_true_still_flags() {
        let mut state = AttentionState::new(0, false);
        assert!(state
            .sample("80x24\nprompt", 0, "T0", SessionStatus::Running, &[], None)
            .is_none());
        assert!(state
            .sample(
                "80x24\nprompt",
                1_000_000,
                "T1",
                SessionStatus::Running,
                &[],
                None
            )
            .is_none());

        let flagged = state
            .apply_user(
                AttentionPayload {
                    needs_attention: true,
                    reason: Some("user flagged".into()),
                    attention_matched_at: None,
                },
                "80x24\nprompt",
                1_000_000,
                "T2",
                SessionStatus::Running,
                &[],
                None,
            )
            .unwrap();
        assert_eq!(flagged.status, SessionStatus::NeedsAttention);
        assert_eq!(flagged.source, AttentionSource::User);
    }
}
