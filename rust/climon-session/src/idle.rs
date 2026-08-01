//! PTY output inactivity detector.
//!
//! Pure (no timers, no I/O): the host calls [`OutputIdleDetector::record_output`]
//! on every non-empty PTY reader chunk and [`OutputIdleDetector::poll`] on a
//! fixed timer tick. A session "needs attention" when no PTY output has been
//! recorded for `idle_seconds`.

/// A transition emitted by [`OutputIdleDetector::poll`] or
/// [`OutputIdleDetector::record_output`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleTransition {
    /// Whether the session now needs attention.
    pub needs_attention: bool,
    /// Human-readable reason, set only when flagging attention.
    pub reason: Option<String>,
}

/// Detects attention from PTY *output* inactivity rather than a sampled screen
/// fingerprint. Pure (no timers, no I/O): the host calls [`record_output`] on
/// every non-empty PTY reader chunk and [`poll`] on a fixed timer tick.
///
/// [`record_output`]: OutputIdleDetector::record_output
/// [`poll`]: OutputIdleDetector::poll
pub struct OutputIdleDetector {
    idle_ms: i64,
    last_output_at: i64,
    flagged: bool,
    acknowledged: bool,
}

impl OutputIdleDetector {
    /// Creates a detector that flags attention after `idle_seconds` without a
    /// PTY output chunk. A value `<= 0` disables detection.
    pub fn new(idle_seconds: i64) -> Self {
        OutputIdleDetector {
            idle_ms: idle_seconds.saturating_mul(1000),
            last_output_at: 0,
            flagged: false,
            acknowledged: false,
        }
    }

    /// Whether the detector currently has the session flagged as needing
    /// attention. Diagnostic accessor used by the host's status logging.
    pub fn is_flagged(&self) -> bool {
        self.flagged
    }

    /// Whether the session has been user-acknowledged. Diagnostic accessor
    /// used by the host's status logging.
    pub fn is_acknowledged(&self) -> bool {
        self.acknowledged
    }

    /// The monotonic timestamp (ms) of the last recorded PTY output chunk (0
    /// before the first chunk). Diagnostic accessor used by the host's status
    /// logging.
    pub fn last_output_at(&self) -> i64 {
        self.last_output_at
    }

    /// Called on a fixed timer tick with the current time (ms). Flags
    /// attention once `idle_ms` has elapsed since the last recorded output.
    /// Returns `None` when disabled, already flagged, or already
    /// acknowledged.
    pub fn poll(&mut self, now: i64) -> Option<IdleTransition> {
        if self.idle_ms <= 0 || self.flagged || self.acknowledged {
            return None;
        }
        if now - self.last_output_at >= self.idle_ms {
            self.flagged = true;
            return Some(IdleTransition {
                needs_attention: true,
                reason: Some(format!("No terminal output for {}s", self.idle_ms / 1000)),
            });
        }
        None
    }

    /// Called on every non-empty PTY output chunk with the current time (ms).
    /// Resets the output clock and clears `flagged`/`acknowledged`. Returns a
    /// running transition iff either was active. No-op (returns `None`) when
    /// disabled.
    pub fn record_output(&mut self, now: i64) -> Option<IdleTransition> {
        if self.idle_ms <= 0 {
            return None;
        }
        let was_active = self.flagged || self.acknowledged;
        self.last_output_at = now;
        self.flagged = false;
        self.acknowledged = false;
        if was_active {
            return Some(IdleTransition {
                needs_attention: false,
                reason: None,
            });
        }
        None
    }

    /// Records a user acknowledgement of the current, outstanding attention.
    /// Clears `flagged` so a later output chunk cannot emit a stale revert,
    /// and marks the session acknowledged so it does not re-flag until output
    /// resumes. No-op when disabled.
    pub fn acknowledge(&mut self) {
        if self.idle_ms <= 0 {
            return;
        }
        self.flagged = false;
        self.acknowledged = true;
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
    fn flags_once_idle_ms_has_elapsed_since_the_epoch() {
        let mut detector = OutputIdleDetector::new(10);
        assert_eq!(detector.poll(0), None);
        assert_eq!(detector.poll(9_999), None);
        assert_eq!(
            detector.poll(10_000),
            attention("No terminal output for 10s")
        );
        // Does not fire twice while still idle.
        assert_eq!(detector.poll(11_000), None);
    }

    #[test]
    fn recording_output_resets_the_idle_clock() {
        let mut detector = OutputIdleDetector::new(10);
        detector.record_output(5_000);
        assert_eq!(detector.last_output_at(), 5_000);
        assert_eq!(detector.poll(14_999), None);
        assert_eq!(
            detector.poll(15_000),
            attention("No terminal output for 10s")
        );
    }

    #[test]
    fn recording_output_after_flagging_clears_it_and_reports_running() {
        let mut detector = OutputIdleDetector::new(10);
        assert_eq!(
            detector.poll(10_000),
            attention("No terminal output for 10s")
        );
        assert_eq!(detector.record_output(10_500), running());
        assert!(!detector.is_flagged());
        // A further idle window re-flags from the new baseline.
        assert_eq!(detector.poll(20_499), None);
        assert_eq!(
            detector.poll(20_500),
            attention("No terminal output for 10s")
        );
    }

    #[test]
    fn acknowledgement_suppresses_re_flagging_until_output_resumes() {
        let mut detector = OutputIdleDetector::new(10);
        assert_eq!(
            detector.poll(10_000),
            attention("No terminal output for 10s")
        );
        detector.acknowledge();
        assert!(detector.is_acknowledged());
        // No re-flag while acknowledged, however long it stays idle.
        assert_eq!(detector.poll(50_000), None);
        assert_eq!(detector.poll(100_000), None);
        // Output resumes: clears the acknowledgement and reports running.
        assert_eq!(detector.record_output(100_500), running());
        assert!(!detector.is_acknowledged());
        assert!(!detector.is_flagged());
        // A fresh idle window re-flags.
        assert_eq!(
            detector.poll(110_500),
            attention("No terminal output for 10s")
        );
    }

    #[test]
    fn is_disabled_when_idle_seconds_is_zero() {
        let mut detector = OutputIdleDetector::new(0);
        assert_eq!(detector.poll(0), None);
        assert_eq!(detector.poll(1_000_000), None);
        assert_eq!(detector.record_output(1_000_000), None);
        detector.acknowledge();
        assert!(!detector.is_acknowledged());
        assert!(!detector.is_flagged());
    }
}
