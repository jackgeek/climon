//! Screen idle detector. 1:1 port of `src/daemon/idle-detector.ts`.
//!
//! Pure (no timers, no I/O): callers supply a screen fingerprint and the current
//! time in milliseconds and it returns the transition to emit — or `None` when
//! nothing changes. A session "needs attention" when its fingerprint has not
//! changed for `idle_seconds`.

/// A transition emitted by [`ScreenIdleDetector::update`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleTransition {
    /// Whether the session now needs attention.
    pub needs_attention: bool,
    /// Human-readable reason, set only when flagging attention.
    pub reason: Option<String>,
}

/// Tracks a stream of screen fingerprints over time and decides when a session
/// transitions into or out of the "needs attention" state.
pub struct ScreenIdleDetector {
    idle_ms: i64,
    last_fingerprint: Option<String>,
    last_change_at: i64,
    flagged: bool,
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
        }
    }

    /// Feeds a fingerprint sampled at `now` (ms). Returns the transition, if any.
    pub fn update(&mut self, fingerprint: &str, now: i64) -> Option<IdleTransition> {
        if self.idle_ms <= 0 {
            return None;
        }

        if self.last_fingerprint.is_none() {
            self.last_fingerprint = Some(fingerprint.to_string());
            self.last_change_at = now;
            return None;
        }

        if self.last_fingerprint.as_deref() != Some(fingerprint) {
            self.last_fingerprint = Some(fingerprint.to_string());
            self.last_change_at = now;
            if self.flagged {
                self.flagged = false;
                return Some(IdleTransition {
                    needs_attention: false,
                    reason: None,
                });
            }
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

    /// Re-baselines the tracked fingerprint after a viewer resize reflows the
    /// screen. A resize is not program activity, so `flagged` and the idle
    /// countdown are preserved. No-op when disabled or before the first update.
    pub fn absorb_resize(&mut self, fingerprint: &str) {
        if self.idle_ms <= 0 || self.last_fingerprint.is_none() {
            return;
        }
        self.last_fingerprint = Some(fingerprint.to_string());
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

        detector.absorb_resize("120x30\nidle screen reflowed");
        assert_eq!(
            detector.update("120x30\nidle screen reflowed", 11_000),
            None
        );

        assert_eq!(detector.update("120x30\nNEW OUTPUT", 12_000), running());
    }

    #[test]
    fn absorbing_a_resize_before_flagging_preserves_the_idle_countdown() {
        let mut detector = ScreenIdleDetector::new(10);
        detector.update("80x24\nidle screen", 0);
        detector.absorb_resize("120x30\nidle screen reflowed");
        assert_eq!(
            detector.update("120x30\nidle screen reflowed", 10_000),
            attention("Screen idle for 10s")
        );
    }
}
