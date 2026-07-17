//! Pure daemon lifecycle model: the phase progression from PTY start through
//! exit finalization to a stopped daemon, expressed as explicit states and
//! ordered finalization steps rather than ad hoc booleans and inline
//! teardown code (`crate::host::legacy::run` lines ~905-1000).
//!
// Consumed by the aggregate actor state assembled in a later task (Task 8);
// some accessors below are unused within this crate until then.
#![allow(dead_code)]

use std::collections::VecDeque;

use climon_proto::meta::{PriorityReason, SessionMetaPatch, SessionStatus};

use crate::engine::effect::OperationId;

/// Coarse daemon lifecycle phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecyclePhase {
    /// The pty is being spawned; not yet confirmed running.
    Starting,
    /// The pty is running and interactive.
    Running,
    /// Exit has been requested/observed; finalization steps are about to be
    /// (or are being) loaded. This phase is transient: [`LifecycleState::begin_exit`]
    /// moves straight through it into [`LifecyclePhase::Finalizing`].
    Draining,
    /// Finalization steps are pending or in flight, in strict order.
    Finalizing,
    /// All finalization steps have completed; the daemon may exit.
    Stopped,
}

/// One ordered step of exit finalization, mirroring the legacy teardown
/// sequence: persist the final scrollback, patch terminal status metadata,
/// send exit frames to clients, restore the local screen, then close
/// clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FinalizationStep {
    PersistScrollback,
    PatchTerminalStatus,
    SendExitFrames,
    RestoreLocalScreen,
    CloseClients,
}

/// The exact, ordered finalization sequence run after a pty exit or an
/// unrecoverable core failure.
const FINALIZATION_ORDER: [FinalizationStep; 5] = [
    FinalizationStep::PersistScrollback,
    FinalizationStep::PatchTerminalStatus,
    FinalizationStep::SendExitFrames,
    FinalizationStep::RestoreLocalScreen,
    FinalizationStep::CloseClients,
];

/// Outcome of completing a finalization step's in-flight operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StepCompletion {
    /// The in-flight step matched and was popped; finalization advanced.
    Completed,
    /// No in-flight operation matched the given id; ignored.
    Stale,
    /// An operation id matched, but the recorded step was no longer the
    /// front of the queue. Defensive: should not occur in practice since
    /// only one step is ever in flight at a time.
    OutOfOrder,
}

/// Pure daemon lifecycle state: the current phase, the exit code (once
/// known), the ordered finalization steps still to run, which step (if any)
/// has an in-flight operation, and the first unrecoverable core-failure
/// error (if exit was triggered by one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LifecycleState {
    phase: LifecyclePhase,
    exit_code: Option<i32>,
    pending_steps: VecDeque<FinalizationStep>,
    in_flight: Option<(FinalizationStep, OperationId)>,
    core_failure: Option<String>,
}

impl LifecycleState {
    /// Creates lifecycle state with the pty not yet confirmed running.
    pub(crate) fn starting() -> Self {
        Self {
            phase: LifecyclePhase::Starting,
            exit_code: None,
            pending_steps: VecDeque::new(),
            in_flight: None,
            core_failure: None,
        }
    }

    /// Creates lifecycle state already in the running phase.
    pub(crate) fn running() -> Self {
        let mut state = Self::starting();
        state.phase = LifecyclePhase::Running;
        state
    }

    /// Confirms the pty is running. Only valid from `Starting`; returns
    /// `false` (no-op) from any other phase.
    pub(crate) fn mark_running(&mut self) -> bool {
        if self.phase == LifecyclePhase::Starting {
            self.phase = LifecyclePhase::Running;
            true
        } else {
            false
        }
    }

    /// Begins exit finalization with the given process exit code. Only the
    /// first call (from `Starting` or `Running`) takes effect: it records
    /// the exit code, moves through `Draining` into `Finalizing`, and loads
    /// the exact ordered finalization steps. Later calls (once already
    /// `Draining`, `Finalizing`, or `Stopped`) are rejected, preserving the
    /// first exit code.
    pub(crate) fn begin_exit(&mut self, code: i32) -> bool {
        if matches!(
            self.phase,
            LifecyclePhase::Starting | LifecyclePhase::Running
        ) {
            self.exit_code = Some(code);
            self.phase = LifecyclePhase::Draining;
            self.phase = LifecyclePhase::Finalizing;
            self.pending_steps = FINALIZATION_ORDER.into_iter().collect();
            self.in_flight = None;
            true
        } else {
            false
        }
    }

    /// Records an unrecoverable core failure and begins exit with code `1`.
    /// Only takes effect before exit has begun; the first error wins. If
    /// exit has already begun (including from a prior core failure), this
    /// does not overwrite the exit code or error and returns `false`.
    pub(crate) fn begin_core_failure(&mut self, error: String) -> bool {
        if matches!(
            self.phase,
            LifecyclePhase::Starting | LifecyclePhase::Running
        ) {
            self.core_failure = Some(error);
            self.begin_exit(1)
        } else {
            false
        }
    }

    /// The pending finalization steps, in order, including the currently
    /// in-flight step (if any) at the front.
    pub(crate) fn pending_steps(&self) -> Vec<FinalizationStep> {
        self.pending_steps.iter().copied().collect()
    }

    /// The next step to start: the front of the queue, but only while
    /// `Finalizing` and no step is currently in flight.
    pub(crate) fn next_step(&self) -> Option<FinalizationStep> {
        if self.phase == LifecyclePhase::Finalizing && self.in_flight.is_none() {
            self.pending_steps.front().copied()
        } else {
            None
        }
    }

    /// Starts `step` with correlating `op`, only when `step` is the front of
    /// the queue and no step is currently in flight.
    pub(crate) fn start_step(&mut self, step: FinalizationStep, op: OperationId) -> bool {
        if self.phase != LifecyclePhase::Finalizing || self.in_flight.is_some() {
            return false;
        }
        if self.pending_steps.front() != Some(&step) {
            return false;
        }
        self.in_flight = Some((step, op));
        true
    }

    /// Completes the in-flight operation identified by `op`. Pops the
    /// completed step and advances to `Stopped` once the queue is empty.
    pub(crate) fn complete_step(&mut self, op: OperationId) -> StepCompletion {
        match self.in_flight {
            Some((step, in_flight_op)) if in_flight_op == op => {
                if self.pending_steps.front() == Some(&step) {
                    self.pending_steps.pop_front();
                    self.in_flight = None;
                    if self.pending_steps.is_empty() {
                        self.phase = LifecyclePhase::Stopped;
                    }
                    StepCompletion::Completed
                } else {
                    StepCompletion::OutOfOrder
                }
            }
            _ => StepCompletion::Stale,
        }
    }

    /// Completes an optional step that has no side-effecting operation to
    /// wait on (`RestoreLocalScreen`, `CloseClients`). Only valid when
    /// `step` is the front of the queue and no step is in flight; any other
    /// step (e.g. `PersistScrollback`) is rejected.
    pub(crate) fn complete_without_effect(&mut self, step: FinalizationStep) -> bool {
        if !matches!(
            step,
            FinalizationStep::RestoreLocalScreen | FinalizationStep::CloseClients
        ) {
            return false;
        }
        if self.in_flight.is_some() {
            return false;
        }
        if self.pending_steps.front() != Some(&step) {
            return false;
        }
        self.pending_steps.pop_front();
        if self.pending_steps.is_empty() {
            self.phase = LifecyclePhase::Stopped;
        }
        true
    }

    pub(crate) fn phase(&self) -> LifecyclePhase {
        self.phase
    }

    pub(crate) fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    pub(crate) fn core_failure(&self) -> Option<&str> {
        self.core_failure.as_deref()
    }

    pub(crate) fn in_flight(&self) -> Option<(FinalizationStep, OperationId)> {
        self.in_flight
    }

    /// The terminal `(status, priority_reason)` pair once an exit code is
    /// known: `Completed`/`Completed` for a zero exit code, `Failed`/`Failed`
    /// otherwise. `None` before [`Self::begin_exit`] (or
    /// [`Self::begin_core_failure`]) has run.
    pub(crate) fn terminal_status(&self) -> Option<(SessionStatus, PriorityReason)> {
        let code = self.exit_code?;
        if code == 0 {
            Some((SessionStatus::Completed, PriorityReason::Completed))
        } else {
            Some((SessionStatus::Failed, PriorityReason::Failed))
        }
    }

    /// The terminal metadata patch, mirroring the legacy exit patch fields
    /// exactly (`crate::host::legacy::run`'s exit teardown and spawn-failure
    /// patches): `status`, `priority_reason`, `completed_at`, `exit_code`,
    /// `last_activity_at` set to `wall_time`, plus `error` carrying the core
    /// failure message when one occurred. `None` before exit has begun.
    pub(crate) fn terminal_patch(&self, wall_time: &str) -> Option<SessionMetaPatch> {
        let (status, priority_reason) = self.terminal_status()?;
        Some(SessionMetaPatch {
            status: Some(status),
            priority_reason: Some(priority_reason),
            completed_at: Some(wall_time.to_string()),
            exit_code: self.exit_code,
            last_activity_at: Some(wall_time.to_string()),
            error: self.core_failure.clone(),
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use climon_proto::meta::{PriorityReason, SessionStatus};

    use super::{FinalizationStep, LifecyclePhase, LifecycleState, StepCompletion};
    use crate::engine::effect::OperationId;

    #[test]
    fn pty_exit_finalizes_scrollback_metadata_clients_then_local_restore() {
        let mut state = LifecycleState::running();
        assert!(state.begin_exit(3));
        assert_eq!(
            state.pending_steps(),
            &[
                FinalizationStep::PersistScrollback,
                FinalizationStep::PatchTerminalStatus,
                FinalizationStep::SendExitFrames,
                FinalizationStep::RestoreLocalScreen,
                FinalizationStep::CloseClients,
            ]
        );
        assert!(!state.begin_exit(9));
        assert_eq!(state.exit_code(), Some(3));
    }

    #[test]
    fn duplicate_exit_is_idempotent_and_first_code_wins() {
        let mut state = LifecycleState::running();
        assert!(state.begin_exit(3));
        assert!(!state.begin_exit(9));
        assert!(!state.begin_exit(0));
        assert_eq!(state.exit_code(), Some(3));
        assert_eq!(state.phase(), LifecyclePhase::Finalizing);
    }

    #[test]
    fn zero_exit_code_reports_completed_status_and_patch() {
        let mut state = LifecycleState::running();
        assert!(state.begin_exit(0));
        assert_eq!(
            state.terminal_status(),
            Some((SessionStatus::Completed, PriorityReason::Completed))
        );
        let patch = state.terminal_patch("2024-01-01T00:00:00.000Z").unwrap();
        assert_eq!(patch.status, Some(SessionStatus::Completed));
        assert_eq!(patch.priority_reason, Some(PriorityReason::Completed));
        assert_eq!(
            patch.completed_at,
            Some("2024-01-01T00:00:00.000Z".to_string())
        );
        assert_eq!(patch.exit_code, Some(0));
        assert_eq!(
            patch.last_activity_at,
            Some("2024-01-01T00:00:00.000Z".to_string())
        );
        assert_eq!(patch.error, None);
    }

    #[test]
    fn nonzero_exit_code_reports_failed_status_and_patch() {
        let mut state = LifecycleState::running();
        assert!(state.begin_exit(7));
        assert_eq!(
            state.terminal_status(),
            Some((SessionStatus::Failed, PriorityReason::Failed))
        );
        let patch = state.terminal_patch("2024-01-01T00:00:00.000Z").unwrap();
        assert_eq!(patch.status, Some(SessionStatus::Failed));
        assert_eq!(patch.priority_reason, Some(PriorityReason::Failed));
        assert_eq!(patch.exit_code, Some(7));
    }

    #[test]
    fn terminal_status_and_patch_are_none_before_exit_begins() {
        let state = LifecycleState::running();
        assert_eq!(state.terminal_status(), None);
        assert_eq!(state.terminal_patch("2024-01-01T00:00:00.000Z"), None);
    }

    #[test]
    fn only_the_front_step_can_start_second_is_rejected() {
        let mut state = LifecycleState::running();
        state.begin_exit(0);
        assert!(state.start_step(FinalizationStep::PersistScrollback, OperationId(1)));
        // The front step is now in flight; a second, non-front step must be
        // rejected even though it is a legitimate queued step.
        assert!(!state.start_step(FinalizationStep::PatchTerminalStatus, OperationId(2)));
        // Re-starting the same (already in-flight) front step is also rejected.
        assert!(!state.start_step(FinalizationStep::PersistScrollback, OperationId(3)));
        assert_eq!(
            state.in_flight(),
            Some((FinalizationStep::PersistScrollback, OperationId(1)))
        );
    }

    #[test]
    fn stale_operation_completion_is_ignored_without_state_change() {
        let mut state = LifecycleState::running();
        state.begin_exit(0);
        state.start_step(FinalizationStep::PersistScrollback, OperationId(1));
        assert_eq!(state.complete_step(OperationId(999)), StepCompletion::Stale);
        // Nothing changed: the original operation is still in flight and the
        // step has not been popped from the queue.
        assert_eq!(
            state.in_flight(),
            Some((FinalizationStep::PersistScrollback, OperationId(1)))
        );
        assert_eq!(state.pending_steps().len(), 5);
    }

    #[test]
    fn successful_completions_advance_exact_order_and_finish_stopped() {
        let mut state = LifecycleState::running();
        state.begin_exit(0);

        for (index, step) in [
            FinalizationStep::PersistScrollback,
            FinalizationStep::PatchTerminalStatus,
            FinalizationStep::SendExitFrames,
            FinalizationStep::RestoreLocalScreen,
            FinalizationStep::CloseClients,
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(state.next_step(), Some(step));
            let op = OperationId(index as u64);
            assert!(state.start_step(step, op));
            assert_eq!(state.next_step(), None, "no next step while in flight");
            assert_eq!(state.complete_step(op), StepCompletion::Completed);
        }

        assert_eq!(state.phase(), LifecyclePhase::Stopped);
        assert!(state.pending_steps().is_empty());
        assert_eq!(state.next_step(), None);
    }

    #[test]
    fn optional_restore_can_complete_without_effect_persistence_cannot() {
        let mut state = LifecycleState::running();
        state.begin_exit(0);
        // Persistence is not one of the optional no-effect steps.
        assert!(!state.complete_without_effect(FinalizationStep::PersistScrollback));
        assert_eq!(state.pending_steps().len(), 5);

        state.start_step(FinalizationStep::PersistScrollback, OperationId(1));
        state.complete_step(OperationId(1));
        state.start_step(FinalizationStep::PatchTerminalStatus, OperationId(2));
        state.complete_step(OperationId(2));
        state.start_step(FinalizationStep::SendExitFrames, OperationId(3));
        state.complete_step(OperationId(3));

        // RestoreLocalScreen is now the front step; it can complete without
        // an in-flight operation (there is nothing to await when no local
        // terminal is attached).
        assert!(state.complete_without_effect(FinalizationStep::RestoreLocalScreen));
        assert_eq!(state.next_step(), Some(FinalizationStep::CloseClients));

        assert!(state.complete_without_effect(FinalizationStep::CloseClients));
        assert_eq!(state.phase(), LifecyclePhase::Stopped);
    }

    #[test]
    fn core_failure_uses_exit_code_one_and_the_error_and_is_idempotent() {
        let mut state = LifecycleState::running();
        assert!(state.begin_core_failure("spawn failed".to_string()));
        assert_eq!(state.exit_code(), Some(1));
        assert_eq!(state.core_failure(), Some("spawn failed"));

        // A second core failure call is rejected; the first error wins.
        assert!(!state.begin_core_failure("different failure".to_string()));
        assert_eq!(state.core_failure(), Some("spawn failed"));
        assert_eq!(state.exit_code(), Some(1));

        let patch = state.terminal_patch("2024-01-01T00:00:00.000Z").unwrap();
        assert_eq!(patch.status, Some(SessionStatus::Failed));
        assert_eq!(patch.priority_reason, Some(PriorityReason::Failed));
        assert_eq!(patch.exit_code, Some(1));
        assert_eq!(patch.error, Some("spawn failed".to_string()));
    }

    #[test]
    fn mark_running_only_succeeds_from_starting() {
        let mut starting = LifecycleState::starting();
        assert_eq!(starting.phase(), LifecyclePhase::Starting);
        assert!(starting.mark_running());
        assert_eq!(starting.phase(), LifecyclePhase::Running);
        // Already running: a second call is a no-op.
        assert!(!starting.mark_running());

        let mut finalizing = LifecycleState::running();
        finalizing.begin_exit(0);
        assert!(!finalizing.mark_running());
        assert_eq!(finalizing.phase(), LifecyclePhase::Finalizing);
    }

    #[test]
    fn core_failure_after_real_exit_does_not_replace_it() {
        let mut state = LifecycleState::running();
        assert!(state.begin_exit(3));
        assert!(!state.begin_core_failure("late failure".to_string()));
        assert_eq!(state.exit_code(), Some(3));
        assert_eq!(state.core_failure(), None);
    }

    #[test]
    fn exit_after_core_failure_does_not_replace_code_one() {
        let mut state = LifecycleState::running();
        assert!(state.begin_core_failure("spawn failed".to_string()));
        assert!(!state.begin_exit(5));
        assert_eq!(state.exit_code(), Some(1));
        assert_eq!(state.core_failure(), Some("spawn failed"));
    }
}
