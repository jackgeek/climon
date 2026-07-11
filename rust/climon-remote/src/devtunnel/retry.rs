//! Deterministic retry/backoff policy for devtunnel operations. Port of
//! `src/devtunnel/retry.ts`.
//!
//! The policy is pure: `now_ms` and the jitter factor are injected by callers so
//! scheduling is fully deterministic in tests. With `jitter = 0.5` the backoff
//! multiplier is exactly `1.0`, yielding the `1000/2000/4000/…/30000` sequence.

use std::time::{Duration, UNIX_EPOCH};

use climon_store::paths::iso8601_millis_utc;

use super::types::{DevtunnelFailure, DevtunnelRetryClass, DevtunnelRetryState};

/// Exponential-backoff retry controller matching the Bun `DevtunnelRetryController`.
pub struct RetryController {
    attempt: u32,
    base_ms: u64,
    cap_ms: u64,
}

impl Default for RetryController {
    fn default() -> Self {
        Self {
            attempt: 0,
            base_ms: 1000,
            cap_ms: 30000,
        }
    }
}

impl RetryController {
    /// A controller with the default `base_ms = 1000` / `cap_ms = 30000` bounds.
    pub fn new() -> Self {
        Self::default()
    }

    /// A controller with explicit backoff bounds.
    pub fn with_bounds(base_ms: u64, cap_ms: u64) -> Self {
        Self {
            attempt: 0,
            base_ms,
            cap_ms,
        }
    }

    /// Records a failure. Non-transient failures pause without scheduling a
    /// retry; transient failures advance the attempt counter and return the next
    /// retry timestamp derived from `now_ms`, the capped backoff, and the jitter.
    pub fn fail(
        &mut self,
        failure: &DevtunnelFailure,
        now_ms: u64,
        jitter: f64,
    ) -> DevtunnelRetryState {
        if failure.retry_class != DevtunnelRetryClass::Transient {
            return DevtunnelRetryState {
                attempt: self.attempt,
                next_retry_at: None,
                paused: true,
            };
        }
        self.attempt += 1;
        let factor = if self.attempt > 63 {
            u64::MAX
        } else {
            1u64 << (self.attempt - 1)
        };
        let raw = self.cap_ms.min(self.base_ms.saturating_mul(factor));
        let jittered = (raw as f64 * (0.8 + jitter * 0.4)).round() as u64;
        let delay = match failure.retry_after_ms {
            Some(retry_after) => jittered.max(retry_after),
            None => jittered,
        };
        DevtunnelRetryState {
            attempt: self.attempt,
            next_retry_at: Some(iso_from_ms(now_ms.saturating_add(delay))),
            paused: false,
        }
    }

    /// Resets the controller after a successful operation.
    pub fn success(&mut self) -> DevtunnelRetryState {
        self.attempt = 0;
        DevtunnelRetryState {
            attempt: 0,
            next_retry_at: None,
            paused: false,
        }
    }

    /// Clears a paused state without touching the attempt counter.
    pub fn resume(&mut self) -> DevtunnelRetryState {
        DevtunnelRetryState {
            attempt: self.attempt,
            next_retry_at: None,
            paused: false,
        }
    }
}

/// Formats epoch milliseconds as a JS-`toISOString()`-compatible UTC string.
fn iso_from_ms(ms: u64) -> String {
    iso8601_millis_utc(UNIX_EPOCH + Duration::from_millis(ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devtunnel::types::{
        DevtunnelErrorCode, DevtunnelFailure, DevtunnelOperation, DevtunnelRetryClass,
    };

    fn failure(retry_class: DevtunnelRetryClass, retry_after_ms: Option<u64>) -> DevtunnelFailure {
        DevtunnelFailure {
            code: DevtunnelErrorCode::Unknown,
            operation: DevtunnelOperation::HostTunnel,
            summary: String::new(),
            remediation: String::new(),
            technical_detail: String::new(),
            occurred_at: "2026-07-11T13:00:00.000Z".to_string(),
            retry_class,
            retryable: true,
            retry_after_ms,
            status: None,
        }
    }

    fn iso(ms: u64) -> String {
        super::iso_from_ms(ms)
    }

    #[test]
    fn transient_failures_follow_capped_backoff_sequence() {
        let mut controller = RetryController::new();
        let now_ms = 1_000_000u64;
        let expected = [1000u64, 2000, 4000, 8000, 16000, 30000, 30000];
        for (index, delay) in expected.iter().enumerate() {
            let state =
                controller.fail(&failure(DevtunnelRetryClass::Transient, None), now_ms, 0.5);
            assert_eq!(state.attempt, (index as u32) + 1, "attempt at step {index}");
            assert!(!state.paused, "should not pause on transient");
            assert_eq!(
                state.next_retry_at,
                Some(iso(now_ms + delay)),
                "delay at step {index}"
            );
        }
    }

    #[test]
    fn retry_after_floor_is_respected() {
        let mut controller = RetryController::new();
        let now_ms = 5_000u64;
        let state = controller.fail(
            &failure(DevtunnelRetryClass::Transient, Some(9000)),
            now_ms,
            0.5,
        );
        assert_eq!(state.next_retry_at, Some(iso(now_ms + 9000)));
    }

    #[test]
    fn actionable_failure_pauses_without_scheduling() {
        let mut controller = RetryController::new();
        let state = controller.fail(&failure(DevtunnelRetryClass::Actionable, None), 0, 0.5);
        assert!(state.paused);
        assert_eq!(state.attempt, 0);
        assert_eq!(state.next_retry_at, None);
    }

    #[test]
    fn resume_clears_pause_without_touching_attempt() {
        let mut controller = RetryController::new();
        controller.fail(&failure(DevtunnelRetryClass::Transient, None), 0, 0.5);
        controller.fail(&failure(DevtunnelRetryClass::Permanent, None), 0, 0.5);
        let state = controller.resume();
        assert!(!state.paused);
        assert_eq!(state.attempt, 1);
    }

    #[test]
    fn success_resets_attempt_and_pause() {
        let mut controller = RetryController::new();
        controller.fail(&failure(DevtunnelRetryClass::Transient, None), 0, 0.5);
        controller.fail(&failure(DevtunnelRetryClass::Transient, None), 0, 0.5);
        let state = controller.success();
        assert_eq!(state.attempt, 0);
        assert!(!state.paused);
    }
}
