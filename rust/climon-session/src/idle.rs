//! Screen idle detector. Ports `src/daemon/idle-detector.ts`, extended so that
//! dimension-only fingerprint differences never count as activity and a user
//! acknowledgement suppresses re-flagging of the same idle screen.
//!
//! Pure (no timers, no I/O): callers supply a screen fingerprint and the current
//! time in milliseconds and it returns the transition to emit — or `None` when
//! nothing changes. A session "needs attention" when its fingerprint body has
//! not changed for `idle_seconds`.

use crate::attention::fingerprint_body;

/// A transition emitted by [`ScreenIdleDetector::update`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleTransition {
    /// Whether the session now needs attention.
    pub needs_attention: bool,
    /// Human-readable reason, set only when flagging attention.
    pub reason: Option<String>,
}

/// How long after a viewer resize the detector keeps absorbing screen-content
/// changes as reflow rather than program activity. A resize delivers a `SIGWINCH`
/// to the child, whose redraw output arrives asynchronously on the PTY reader
/// thread *after* the synchronous re-baseline. Without a settle window that
/// trailing redraw is misread as activity and reverts an acknowledged or flagged
/// session to `running`. Two idle samples (the loop ticks once a second) is ample
/// for a shell to finish repainting.
const RESIZE_SETTLE_MS: i64 = 2_000;

/// Tracks a stream of screen fingerprints over time and decides when a session
/// transitions into or out of the "needs attention" state.
pub struct ScreenIdleDetector {
    idle_ms: i64,
    last_fingerprint: Option<String>,
    last_change_at: i64,
    flagged: bool,
    acknowledged: bool,
    settle_until: i64,
}

impl ScreenIdleDetector {
    /// Creates a detector that flags attention after `idle_seconds` of an
    /// unchanged fingerprint. A value `<= 0` disables detection.
    pub fn new(idle_seconds: i64) -> Self {
        ScreenIdleDetector {
            idle_ms: idle_seconds * 1000,
            last_fingerprint: None,
            last_change_at: 0,
            flagged: false,
            acknowledged: false,
            settle_until: 0,
        }
    }

    /// Whether the detector currently has the screen flagged as needing
    /// attention. Diagnostic accessor used by the host's status logging.
    pub fn is_flagged(&self) -> bool {
        self.flagged
    }

    /// Whether the current screen has been user-acknowledged. Diagnostic
    /// accessor used by the host's status logging.
    pub fn is_acknowledged(&self) -> bool {
        self.acknowledged
    }

    /// The timestamp (ms, on the host's monotonic clock) until which body
    /// changes are absorbed as post-resize reflow. Diagnostic accessor.
    pub fn settle_until(&self) -> i64 {
        self.settle_until
    }

    /// Feeds a fingerprint sampled at `now` (ms). Returns the transition, if any.
    ///
    /// Change detection compares only the fingerprint *body*: a difference in
    /// the `{cols}x{rows}` dimension header alone (a resize, not program
    /// activity) is never treated as a change and never produces a transition.
    pub fn update(&mut self, fingerprint: &str, now: i64) -> Option<IdleTransition> {
        if self.idle_ms <= 0 {
            return None;
        }

        let Some(last) = self.last_fingerprint.as_deref() else {
            self.last_fingerprint = Some(fingerprint.to_string());
            self.last_change_at = now;
            return None;
        };

        if fingerprint_body(last) != fingerprint_body(fingerprint) {
            // Within the post-resize settle window a body change is the child's
            // asynchronous reflow/redraw, not program activity: re-baseline to it
            // and preserve `flagged`/`acknowledged` and the idle countdown so the
            // session does not revert to `running`.
            if now < self.settle_until {
                self.last_fingerprint = Some(fingerprint.to_string());
                return None;
            }
            self.last_fingerprint = Some(fingerprint.to_string());
            self.last_change_at = now;
            let was_active = self.flagged || self.acknowledged;
            self.flagged = false;
            self.acknowledged = false;
            if was_active {
                return Some(IdleTransition {
                    needs_attention: false,
                    reason: None,
                });
            }
            return None;
        }

        // Body unchanged (identical or a dimension-only difference). Refresh the
        // stored header so it tracks the current dimensions, but leave the idle
        // countdown untouched.
        self.last_fingerprint = Some(fingerprint.to_string());

        // An acknowledged screen must not re-flag while it stays unchanged.
        if self.acknowledged {
            return None;
        }

        if !self.flagged && now - self.last_change_at >= self.idle_ms {
            self.flagged = true;
            return Some(IdleTransition {
                needs_attention: true,
                reason: Some(format!("Screen idle for {}s", self.idle_ms / 1000)),
            });
        }

        None
    }

    /// Records a user acknowledgement of the current screen. Clears the flagged
    /// state so a later screen change cannot emit a stale revert, and marks the
    /// screen acknowledged so it does not re-flag while it stays unchanged. The
    /// next genuine body change resumes normal detection. No-op when disabled or
    /// before the first update.
    pub fn acknowledge(&mut self, fingerprint: &str, now: i64) {
        if self.idle_ms <= 0 || self.last_fingerprint.is_none() {
            return;
        }
        self.flagged = false;
        self.acknowledged = true;
        self.last_fingerprint = Some(fingerprint.to_string());
        self.last_change_at = now;
    }

    /// Ends any resize-settle window when controller input is forwarded to the
    /// program. Output that follows explicit input is genuine activity, not an
    /// asynchronous resize redraw, so its fingerprint change must resume normal
    /// detection even when it arrives immediately after a viewer resize.
    pub fn note_program_input(&mut self) {
        self.settle_until = 0;
    }

    /// Re-baselines the tracked fingerprint after a viewer resize reflows the
    /// screen. A resize is not program activity, so `flagged`, `acknowledged`
    /// and the idle countdown are preserved. It also opens a [`RESIZE_SETTLE_MS`]
    /// window (anchored at `now`) during which any further body change is treated
    /// as the child's asynchronous `SIGWINCH` redraw rather than activity. No-op
    /// when disabled or before the first update.
    pub fn absorb_resize(&mut self, fingerprint: &str, now: i64) {
        if self.idle_ms <= 0 || self.last_fingerprint.is_none() {
            return;
        }
        self.last_fingerprint = Some(fingerprint.to_string());
        self.settle_until = now + RESIZE_SETTLE_MS;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attention(reason: &str) -> Option<IdleTransition> {
        Some(IdleTransition {
            needs_attention: true,
            reason: Some(reason.to_string()),
        })
    }

    fn running() -> Option<IdleTransition> {
        Some(IdleTransition {
            needs_attention: false,
            reason: None,
        })
    }

    #[test]
    fn seeds_on_first_update_and_does_not_flag_immediately() {
        let mut detector = ScreenIdleDetector::new(10);
        assert_eq!(detector.update("screen-a", 0), None);
    }

    #[test]
    fn flags_after_the_idle_window_with_an_unchanged_fingerprint() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("screen-a", 0);
        assert_eq!(detector.update("screen-a", 5_000), None);
        assert_eq!(
            detector.update("screen-a", 10_000),
            attention("Screen idle for 10s")
        );
    }

    #[test]
    fn does_not_fire_twice_while_still_idle() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("screen-a", 0);
        detector.update("screen-a", 10_000);
        assert_eq!(detector.update("screen-a", 11_000), None);
    }

    #[test]
    fn reverts_to_running_when_the_fingerprint_changes_after_flagging() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("screen-a", 0);
        detector.update("screen-a", 10_000);
        assert_eq!(detector.update("screen-b", 10_500), running());
    }

    #[test]
    fn a_change_before_the_window_resets_the_idle_timer() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("screen-a", 0);
        assert_eq!(detector.update("screen-b", 9_000), None);
        assert_eq!(detector.update("screen-b", 18_000), None);
        assert_eq!(
            detector.update("screen-b", 19_000),
            attention("Screen idle for 10s")
        );
    }

    #[test]
    fn a_change_while_not_flagged_does_not_emit_a_transition() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("screen-a", 0);
        assert_eq!(detector.update("screen-b", 5_000), None);
    }

    #[test]
    fn is_disabled_when_idle_seconds_is_zero() {
        let mut detector = ScreenIdleDetector::new(0);
        assert_eq!(detector.update("screen-a", 0), None);
        assert_eq!(detector.update("screen-a", 100_000), None);
    }

    #[test]
    fn absorbing_a_resize_re_baselines_without_clearing_the_flagged_state() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("80x24\nidle screen", 0);
        assert_eq!(
            detector.update("80x24\nidle screen", 10_000),
            attention("Screen idle for 10s")
        );

        detector.absorb_resize("120x30\nidle screen reflowed", 10_500);
        assert_eq!(
            detector.update("120x30\nidle screen reflowed", 11_000),
            None
        );

        // Genuine output arriving after the post-resize settle window reverts.
        assert_eq!(detector.update("120x30\nNEW OUTPUT", 13_000), running());
    }

    #[test]
    fn absorbing_a_resize_before_flagging_preserves_the_idle_countdown() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("80x24\nidle screen", 0);
        detector.absorb_resize("120x30\nidle screen reflowed", 1_000);
        assert_eq!(
            detector.update("120x30\nidle screen reflowed", 10_000),
            attention("Screen idle for 10s")
        );
    }

    #[test]
    fn a_dimension_only_change_does_not_revert_a_flagged_session() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("80x24\nidle screen", 0);
        assert_eq!(
            detector.update("80x24\nidle screen", 10_000),
            attention("Screen idle for 10s")
        );
        // A switch/resize changes only the dimension header; the body is the
        // same, so no status change is emitted and the session stays flagged.
        assert_eq!(detector.update("120x30\nidle screen", 11_000), None);
        assert_eq!(detector.update("120x30\nidle screen", 12_000), None);
    }

    #[test]
    fn a_dimension_only_change_emits_nothing_when_not_flagged() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("80x24\nidle screen", 0);
        assert_eq!(detector.update("120x30\nidle screen", 1_000), None);
    }

    #[test]
    fn acknowledgement_suppresses_re_flagging_while_the_screen_stays_idle() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("80x24\nidle screen", 0);
        assert_eq!(
            detector.update("80x24\nidle screen", 10_000),
            attention("Screen idle for 10s")
        );

        detector.acknowledge("80x24\nidle screen", 11_000);

        // The screen stays idle well past another idle window: no re-flag.
        assert_eq!(detector.update("80x24\nidle screen", 21_000), None);
        assert_eq!(detector.update("80x24\nidle screen", 40_000), None);
    }

    #[test]
    fn acknowledgement_then_a_switch_keeps_the_session_acknowledged() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("80x24\nidle screen", 0);
        detector.update("80x24\nidle screen", 10_000);
        detector.acknowledge("80x24\nidle screen", 11_000);

        // A dimension-only switch must not emit a revert or a re-flag.
        assert_eq!(detector.update("120x30\nidle screen", 12_000), None);
        // A reflow absorbed on resize is likewise quiet.
        detector.absorb_resize("120x30\nidle screen reflowed", 12_500);
        assert_eq!(
            detector.update("120x30\nidle screen reflowed", 30_000),
            None
        );
    }

    #[test]
    fn a_real_change_after_acknowledgement_reverts_to_running_then_re_flags() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("80x24\nidle screen", 0);
        detector.update("80x24\nidle screen", 10_000);
        detector.acknowledge("80x24\nidle screen", 11_000);

        // Genuine program output (body changes) resumes normal behaviour.
        assert_eq!(detector.update("80x24\nNEW OUTPUT", 12_000), running());
        // Idle again for a full window -> flags afresh.
        assert_eq!(
            detector.update("80x24\nNEW OUTPUT", 22_000),
            attention("Screen idle for 10s")
        );
    }

    #[test]
    fn a_resize_redraw_arriving_after_acknowledgement_does_not_revert_to_running() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("269x68\n$ prompt", 0);
        detector.update("269x68\n$ prompt", 10_000);
        detector.acknowledge("269x68\n$ prompt", 11_000);

        // Switching away disconnects the last viewer, so the host reverts the PTY
        // to its terminal size and re-baselines the detector synchronously.
        detector.absorb_resize("269x68\n$ prompt", 12_000);

        // The shell's SIGWINCH redraw output then arrives asynchronously on the
        // PTY reader thread, changing the rendered body. A resize-induced reflow
        // is not program activity and must not revert the acknowledged session.
        assert_eq!(detector.update("269x68\n$ prompt redrawn", 12_200), None);

        // Once the reflow settles, the session stays acknowledged.
        assert_eq!(detector.update("269x68\n$ prompt redrawn", 20_000), None);
    }

    #[test]
    fn controller_input_ends_resize_settle_before_program_output() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("80x24\n$ prompt", 0);
        detector.update("80x24\n$ prompt", 10_000);
        detector.acknowledge("80x24\n$ prompt", 11_000);
        detector.absorb_resize("100x30\n$ prompt", 12_000);

        detector.note_program_input();
        assert_eq!(
            detector.update("100x30\n$ prompt\nchanged-body", 12_100),
            running()
        );
        assert!(!detector.is_acknowledged());
    }

    #[test]
    fn a_resize_redraw_arriving_after_flagging_does_not_revert_to_running() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("80x24\nidle", 0);
        assert_eq!(
            detector.update("80x24\nidle", 10_000),
            attention("Screen idle for 10s")
        );

        detector.absorb_resize("100x30\nidle", 11_000);
        // Async reflow output after the resize must keep the session flagged.
        assert_eq!(detector.update("100x30\nidle reflowed", 11_200), None);
        assert_eq!(detector.update("100x30\nidle reflowed", 12_000), None);
    }

    #[test]
    fn genuine_output_after_the_resize_settle_window_still_reverts() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("80x24\nidle", 0);
        detector.update("80x24\nidle", 10_000);
        detector.acknowledge("80x24\nidle", 11_000);
        detector.absorb_resize("80x24\nidle", 12_000);

        // Well past the settle window, real program output is genuine activity
        // and resumes normal detection.
        assert_eq!(detector.update("80x24\nNEW OUTPUT", 30_000), running());
    }

    #[test]
    fn acknowledge_is_a_no_op_before_the_first_update_or_when_disabled() {
        let mut fresh = ScreenIdleDetector::new(10);
        fresh.acknowledge("80x24\nidle screen", 0);
        // No baseline was seeded, so the first real update just seeds.
        assert_eq!(fresh.update("80x24\nidle screen", 0), None);

        let mut disabled = ScreenIdleDetector::new(0);
        disabled.acknowledge("80x24\nidle screen", 0);
        assert_eq!(disabled.update("80x24\nidle screen", 100_000), None);
    }
}
