//! Pure local-terminal view state: the in-process local terminal's
//! displaced/suppressed/restoring lifecycle, modeled as an explicit protocol
//! of actions instead of the legacy host's ambient `Instant`-polled fields.
//!
//! The legacy host (`crate::host::legacy`) still drives its own
//! `HostState` fields directly, but shares every pure decision/helper defined
//! here — there is exactly one implementation of the displaced/suppressed
//! rules, the take-control-key decision, the restore-decision, the exit-time
//! restore bytes, and the repaint jiggle, whether it is exercised through
//! `LocalViewState` (below) or through the legacy host's own bookkeeping.
//!
//! `LocalViewState` additionally makes the local console *write* explicit and
//! two-phase: `ScheduleRestore`/`WriteRestore` never optimistically resume
//! output. Output stays suppressed until the coordinator reports the actual
//! console write outcome via [`LocalViewState::console_write_completed`] or
//! [`LocalViewState::console_write_failed`], so a failed/late write can never
//! be mistaken for a successful repaint.
//!
// Consumed by the aggregate actor state (`engine::state`) and the legacy host,
// which share every pure decision/helper here; the one protocol variant not yet
// emitted carries a local allowance.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::engine::effect::OperationId;
use crate::fingerprint::render_screen_from_replay;
use crate::replay::{build_mouse_private_mode_restore_suffix, TRACKED_MOUSE_PRIVATE_MODES};

/// How long the local terminal stays suppressed after a browser viewer shrinks
/// back to (or under) the local size before the restore watcher repaints it from
/// the parsed grid's current screen. This delay lets the PTY's resize-repaint
/// burst (notably Windows ConPTY's clear-and-repaint, delivered asynchronously
/// on the reader thread after the resize call) drain first, so the clean grid
/// repaint lands last and the local terminal is not left blank or corrupted. The
/// screen is rendered when the watcher fires, so it reflects the latest output.
pub(crate) const LOCAL_RESTORE_DELAY: Duration = Duration::from_millis(250);

/// The key that reclaims control to the in-process local terminal while it is
/// displaced: the space bar (0x20). Ctrl+T was avoided because host terminal
/// emulators and browsers commonly intercept it (new tab / "go to symbol") so it
/// never reaches climon. Space is only treated as take-control while displaced;
/// once the local terminal controls the grid, Space is ordinary input and is
/// forwarded to the PTY (see [`local_stdin_action`]).
pub(crate) const LOCAL_TAKE_CONTROL_KEY: u8 = 0x20;
const MAX_WIN32_INPUT_SEQUENCE: usize = 80;

/// The bytes to write to the in-process local terminal to restore its screen
/// when the session exits, or `None` when no restore is needed.
///
/// A restore is needed exactly when an interactive local terminal is attached
/// and currently suppressed — i.e. it is displaced, showing the take-control
/// notice because a dashboard/PWA held control when the command exited. Without
/// this the terminal is stranded on the "Press Space to take control." notice
/// instead of the command's final screen/scrollback; there is no live output or
/// restore-watcher tick left to repaint it, because the daemon is tearing down.
/// Rebuilds a host-sized viewport from the final scrollback (mirroring the
/// restore-watcher `Repaint` path) so the last screen lands cleanly over the
/// cleared notice. Extracted as a pure function so the exit-time restore is
/// unit-testable without a live PTY/`HostState`.
pub(crate) fn local_exit_restore_bytes(
    local_attached: bool,
    local_output_suppressed: bool,
    snapshot: &[u8],
    host_cols: u16,
    host_rows: u16,
    mouse_mode_state: &HashMap<String, bool>,
) -> Option<Vec<u8>> {
    if !(local_attached && local_output_suppressed) {
        return None;
    }
    let mut out =
        build_mouse_private_mode_restore_suffix(mouse_mode_state, TRACKED_MOUSE_PRIVATE_MODES);
    out.extend_from_slice(&render_screen_from_replay(
        snapshot,
        host_cols.max(1),
        host_rows.max(1),
    ));
    Some(out)
}

/// What the restore watcher should do on a given tick. Extracted as a pure
/// decision (see [`local_restore_decision`]) so the fix — never resuming the
/// local terminal while the PTY is still overgrown — is unit-testable without a
/// live PTY/`HostState`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LocalRestoreDecision {
    /// No restore is pending, or the deferral has not elapsed yet.
    NotDue,
    /// The deferral elapsed but the PTY is still larger than the local console
    /// (a viewer re-grew during the delay): stay suppressed and clear the
    /// pending restore so the next genuine shrink reschedules it.
    SkipOvergrown,
    /// The deferral elapsed and the PTY now fits the local console: repaint the
    /// local screen from the grid and resume live output.
    Repaint,
}

/// Pure decision for the restore watcher. Resuming the local terminal while the
/// PTY is still overgrown is the Windows corruption root cause: ConPTY positions
/// its live output absolutely for the taller grid (e.g. `\e[34;1H` for a 57-row
/// PTY), which stacks lines / overwrites the prompt on the shorter real console.
pub(crate) fn local_restore_decision(
    restore_at: Option<Instant>,
    now: Instant,
    overgrown: bool,
) -> LocalRestoreDecision {
    match restore_at {
        Some(at) if now >= at => {
            if overgrown {
                LocalRestoreDecision::SkipOvergrown
            } else {
                LocalRestoreDecision::Repaint
            }
        }
        _ => LocalRestoreDecision::NotDue,
    }
}

/// What to do with a chunk of in-process local-terminal stdin. Extracted as a
/// pure decision so the take-control-while-displaced rule is unit-testable
/// without a live PTY/`HostState`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LocalStdinAction {
    /// The local terminal is displaced and the chunk contained the take-control
    /// key (Space): reclaim control back to the local terminal and swallow the
    /// input.
    TakeControl,
    /// The local terminal is displaced (output suppressed by another
    /// controller): swallow the input so the command stays non-interactive.
    Swallow,
    /// The local terminal holds control: forward the input unchanged to the PTY.
    Forward,
}

/// Pure decision for in-process local stdin. While displaced, the take-control
/// key (Space) reclaims control and every other key is swallowed (the monitored
/// command is non-interactive). While controlling, all input is forwarded --
/// including Space, which must reach the shell as normal input.
pub(crate) fn local_stdin_action(has_take_control: bool, suppressed: bool) -> LocalStdinAction {
    if suppressed {
        if has_take_control {
            LocalStdinAction::TakeControl
        } else {
            LocalStdinAction::Swallow
        }
    } else {
        LocalStdinAction::Forward
    }
}

/// Recognizes either a literal Space byte or the Win32 input-mode key-down
/// record Windows Terminal emits after ConPTY requests `DECSET ?9001`.
fn contains_take_control_key(pending: &mut Vec<u8>, bytes: &[u8]) -> bool {
    let mut input = std::mem::take(pending);
    input.extend_from_slice(bytes);
    if input.contains(&LOCAL_TAKE_CONTROL_KEY) {
        return true;
    }

    let mut offset = 0;
    while offset < input.len() {
        if input[offset] == b'\x1b' {
            if offset + 1 == input.len() {
                pending.extend_from_slice(&input[offset..]);
                break;
            }
            if input[offset + 1] != b'[' {
                offset += 1;
                continue;
            }
            let params_start = offset + 2;
            let Some(relative_end) = input[params_start..].iter().position(|byte| *byte == b'_')
            else {
                let suffix = &input[offset..];
                if suffix.len() <= MAX_WIN32_INPUT_SEQUENCE
                    && suffix[2..]
                        .iter()
                        .all(|byte| byte.is_ascii_digit() || *byte == b';')
                {
                    pending.extend_from_slice(suffix);
                    break;
                }
                offset = params_start;
                continue;
            };
            let end = params_start + relative_end;
            let params = &input[params_start..end];
            if !params
                .iter()
                .all(|byte| byte.is_ascii_digit() || *byte == b';')
            {
                offset = params_start;
                continue;
            }
            if is_win32_space_key_down(params) {
                pending.clear();
                return true;
            }
            offset = end + 1;
        } else {
            offset += 1;
        }
    }
    false
}

fn is_win32_space_key_down(params: &[u8]) -> bool {
    let mut values = [0u32; 6];
    values[5] = 1;
    let mut count = 0;
    for (index, param) in params.split(|byte| *byte == b';').enumerate() {
        if index >= values.len() {
            return false;
        }
        count += 1;
        if param.is_empty() {
            continue;
        }
        let mut value = 0u32;
        for byte in param {
            if !byte.is_ascii_digit() {
                return false;
            }
            value = match value
                .checked_mul(10)
                .and_then(|current| current.checked_add(u32::from(byte - b'0')))
            {
                Some(value) => value,
                None => return false,
            };
        }
        values[index] = value;
    }

    count >= 4
        && values[0] == u32::from(LOCAL_TAKE_CONTROL_KEY)
        && values[2] == u32::from(LOCAL_TAKE_CONTROL_KEY)
        && values[3] == 1
}

/// Pure decision: is the in-process local terminal displaced? Identity-based,
/// mirroring the dashboard/attach-client surfaces — the local terminal is
/// displaced whenever some *other* surface (not `"local"`) is the controller,
/// regardless of relative size. With no controller yet (session start) the
/// local terminal owns the grid, so it is not displaced.
pub(crate) fn local_displaced_by_controller(controller_id: Option<&str>) -> bool {
    matches!(controller_id, Some(id) if id != "local")
}

/// The intermediate PTY height for a restore jiggle: one row away from `rows`,
/// so the resize is always a real (non-deduped) change that forces the wrapped
/// command to repaint. Steps down normally, but up when `rows <= 1` because
/// `PtyResizer::resize` clamps to `>= 1` and the de-dupe would otherwise swallow
/// a no-op resize. `jiggle_size` pairs this with a one-column shrink so both
/// dimensions change.
pub(crate) fn jiggle_rows(rows: u16) -> u16 {
    if rows > 1 {
        rows - 1
    } else {
        rows + 1
    }
}

/// The intermediate PTY size for a restore jiggle: one column narrower (never
/// wider, so the PTY never transiently overgrows the real local console — the
/// Windows ConPTY corruption guard) and one row away (via `jiggle_rows`).
/// Changing *both* dimensions guarantees a real `winsize` difference the wrapped
/// command detects, and the column change busts the frame cache of TUIs (e.g.
/// Ink/`copilot`) that skip a redraw when the new frame is byte-identical to the
/// last. Columns clamp at `1`; rows always change, so the result never equals
/// the input.
pub(crate) fn jiggle_size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.saturating_sub(1).max(1), jiggle_rows(rows))
}

/// Which leg of a two-leg repaint jiggle runs next. Leg 1 (`Away`) drives the
/// PTY to `jiggle_size`; Leg 2 (`Back`) returns it to the current live size. The
/// legs run on consecutive restore-thread ticks so the ~25 ms gap between them
/// is observable (a shorter gap coalesces and the app never samples the
/// intermediate size).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum JiggleLeg {
    Away,
    Back,
}

impl JiggleLeg {
    pub(crate) fn next(self) -> Option<JiggleLeg> {
        match self {
            JiggleLeg::Away => Some(JiggleLeg::Back),
            JiggleLeg::Back => None,
        }
    }
}

/// A side effect requested by [`LocalViewState`]'s pure transitions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LocalViewAction {
    /// Nothing to do.
    Noop,
    /// Render the take-control notice at the local console's current size.
    ShowNotice { cols: u16, rows: u16 },
    /// Schedule a deferred restore timer. `generation` must be echoed back to
    /// [`LocalViewState::restore_timer_fired`] so a stale firing (superseded by
    /// a later cancel/reschedule) is ignored.
    ScheduleRestore { generation: u64, delay: Duration },
    /// Cancel a previously scheduled restore timer for `generation`.
    CancelRestore { generation: u64 },
    /// Write `bytes` to the local console. Output stays suppressed until this
    /// write's outcome is reported back via
    /// [`LocalViewState::console_write_completed`] or
    /// [`LocalViewState::console_write_failed`].
    WriteRestore {
        operation_id: OperationId,
        bytes: Vec<u8>,
    },
    /// Reclaim control back to the local terminal (Space pressed while
    /// displaced).
    TakeControl,
    /// Forward these bytes to the pty's stdin unchanged.
    ForwardInput(Vec<u8>),
    /// Swallow this input chunk (the local terminal is displaced/suppressed).
    SwallowInput,
    /// A console write failed while a restore was in flight: the local
    /// terminal's screen state can no longer be trusted. Reserved for the
    /// coordinator; the state machine currently degrades via
    /// [`LocalViewState::console_write_failed`] rather than emitting this.
    #[allow(dead_code)]
    Degraded,
}

/// Pure state for the in-process local terminal's displaced/suppressed/
/// restoring lifecycle. Every method takes any inputs it needs (controller
/// identity, sizes, timer/write outcomes) as parameters and returns the
/// [`LocalViewAction`](s) the caller must perform; this type never touches the
/// pty, the console, or the clock itself.
///
/// The restore protocol is explicit and two-phase: a [`LocalViewAction::WriteRestore`]
/// leaves output suppressed until a matching
/// [`Self::console_write_completed`] or [`Self::console_write_failed`] call
/// resolves it, so a delayed or failed write can never be mistaken for a
/// successful repaint (unlike the legacy host, which unsuppresses immediately
/// after issuing the write).
#[derive(Debug)]
pub(crate) struct LocalViewState {
    attached: bool,
    host_cols: u16,
    host_rows: u16,
    output_suppressed: bool,
    notice_size: Option<(u16, u16)>,
    restore_generation: u64,
    restore_pending: bool,
    pending_console_write: Option<OperationId>,
    pending_jiggle: Option<JiggleLeg>,
    pending_win32_input: Vec<u8>,
    degraded: bool,
}

impl LocalViewState {
    /// Creates local-view state for an interactive local terminal attached at
    /// `cols`x`rows` (clamped to at least 1x1). The local terminal starts
    /// unsuppressed: it owns the grid until a controller change displaces it.
    pub(crate) fn attached(cols: u16, rows: u16) -> Self {
        Self::new(true, cols, rows)
    }

    /// Creates local-view state for a headless session (no interactive local
    /// terminal). Every transition is a no-op: there is no local screen to
    /// pause, notice, or restore.
    pub(crate) fn headless(cols: u16, rows: u16) -> Self {
        Self::new(false, cols, rows)
    }

    fn new(attached: bool, cols: u16, rows: u16) -> Self {
        Self {
            attached,
            host_cols: cols.max(1),
            host_rows: rows.max(1),
            output_suppressed: false,
            notice_size: None,
            restore_generation: 0,
            restore_pending: false,
            pending_console_write: None,
            pending_jiggle: None,
            pending_win32_input: Vec::new(),
            degraded: false,
        }
    }

    /// Reports that `controller_id` now controls the shared pty grid.
    /// `applied_cols`/`applied_rows` are accepted for symmetry with the
    /// coordinator's other control-change reporting but are not used here:
    /// displacement is identity-based (any non-`"local"` controller
    /// displaces), never size-based. The Windows ConPTY overgrown-repaint
    /// guard is applied later, at restore time (see
    /// [`Self::restore_timer_fired`]'s `still_overgrown` parameter), not here.
    ///
    /// No-op when headless or already [`Self::degraded`].
    pub(crate) fn controller_changed(
        &mut self,
        controller_id: &str,
        _applied_cols: u16,
        _applied_rows: u16,
    ) -> Vec<LocalViewAction> {
        if !self.attached || self.degraded {
            return Vec::new();
        }
        let mut actions = Vec::new();
        if local_displaced_by_controller(Some(controller_id)) {
            if self.restore_pending {
                actions.push(LocalViewAction::CancelRestore {
                    generation: self.restore_generation,
                });
                self.restore_generation += 1;
                self.restore_pending = false;
            }
            // If a console write was in flight (queued or possibly already
            // painted by `restore_timer_fired`'s `WriteRestore`), this new
            // controller invalidates it: the physical terminal may end up
            // showing the restored screen even though state now says
            // displaced. Force the notice to be re-rendered so the FIFO
            // ordering (`WriteRestore` then `ShowNotice`) reasserts the
            // correct screen regardless of the idempotency guard below.
            let invalidated_in_flight_write = self.pending_console_write.take().is_some();
            self.pending_jiggle = None;
            self.show_notice(&mut actions, invalidated_in_flight_write);
        } else if self.output_suppressed && !self.restore_pending {
            self.schedule_restore(&mut actions);
        }
        actions
    }

    /// Reports that the local console itself resized (e.g. `SIGWINCH`) to
    /// `cols`x`rows`. The host size is recorded unconditionally (mirroring the
    /// legacy host, which tracks it even headless); the remaining behavior —
    /// re-centering the notice or scheduling a restore — only applies while
    /// attached and not degraded.
    pub(crate) fn local_resized(
        &mut self,
        cols: u16,
        rows: u16,
        controller_id: Option<&str>,
    ) -> Vec<LocalViewAction> {
        self.host_cols = cols.max(1);
        self.host_rows = rows.max(1);
        if !self.attached || self.degraded {
            return Vec::new();
        }
        let mut actions = Vec::new();
        if local_displaced_by_controller(controller_id) {
            self.show_notice(&mut actions, false);
        } else if controller_id == Some("local") && self.output_suppressed && !self.restore_pending
        {
            self.schedule_restore(&mut actions);
        }
        actions
    }

    /// Pushes [`LocalViewAction::ShowNotice`] at the current host size. When
    /// `force` is `false`, the idempotency guard skips re-rendering a notice
    /// already showing at that exact size (keeping a steady displaced state
    /// from re-rendering every tick). `force` bypasses that guard so a caller
    /// can reassert the notice even when the state fields alone wouldn't
    /// otherwise trigger a render — e.g. when redisplacement invalidates a
    /// [`LocalViewAction::WriteRestore`] that was queued or already painted.
    fn show_notice(&mut self, actions: &mut Vec<LocalViewAction>, force: bool) {
        let notice_size = self.host_size();
        let needs_render =
            force || !self.output_suppressed || self.notice_size != Some(notice_size);
        if needs_render {
            actions.push(LocalViewAction::ShowNotice {
                cols: notice_size.0,
                rows: notice_size.1,
            });
            self.output_suppressed = true;
            self.notice_size = Some(notice_size);
        }
    }

    /// Advances the restore generation and pushes
    /// [`LocalViewAction::ScheduleRestore`] for it.
    fn schedule_restore(&mut self, actions: &mut Vec<LocalViewAction>) {
        self.restore_generation += 1;
        self.restore_pending = true;
        actions.push(LocalViewAction::ScheduleRestore {
            generation: self.restore_generation,
            delay: LOCAL_RESTORE_DELAY,
        });
    }

    /// A previously scheduled restore timer fired for `generation`, with
    /// `still_overgrown` reporting whether the shared pty still exceeds the
    /// local console (the coordinator computes this from the current applied
    /// size, mirroring the legacy host's `local_terminal_exceeded`).
    ///
    /// A stale (superseded) or unmatched generation is ignored ([`LocalViewAction::Noop`]).
    /// If the pty is still overgrown, the pending restore is cleared (staying
    /// suppressed) so the next genuine shrink reschedules it. Otherwise the
    /// restore is due: see [`Self::restore_due`].
    pub(crate) fn restore_timer_fired(
        &mut self,
        generation: u64,
        still_overgrown: bool,
        operation_id: OperationId,
        repaint: Vec<u8>,
    ) -> LocalViewAction {
        if !self.restore_pending || generation != self.restore_generation {
            return LocalViewAction::Noop;
        }
        if still_overgrown {
            self.restore_pending = false;
            return LocalViewAction::Noop;
        }
        self.restore_due(operation_id, repaint)
    }

    /// The accepted (non-overgrown) restore path: clears the pending-restore
    /// flag, records `operation_id` as the in-flight console write, and
    /// returns the [`LocalViewAction::WriteRestore`] to perform. Output stays
    /// suppressed until that write is resolved via
    /// [`Self::console_write_completed`] or [`Self::console_write_failed`].
    pub(crate) fn restore_due(
        &mut self,
        operation_id: OperationId,
        repaint: Vec<u8>,
    ) -> LocalViewAction {
        self.restore_pending = false;
        self.pending_console_write = Some(operation_id);
        LocalViewAction::WriteRestore {
            operation_id,
            bytes: repaint,
        }
    }

    /// Reports that the console write for `operation_id` completed
    /// successfully. If it matches the in-flight write, clears it, resumes
    /// output, clears the notice, and schedules the two-leg repaint jiggle's
    /// first leg; returns `true`. A stale/unmatched `operation_id` (e.g. from a
    /// write superseded by a later re-displacement) is ignored, returning
    /// `false`.
    pub(crate) fn console_write_completed(&mut self, operation_id: OperationId) -> bool {
        if self.pending_console_write != Some(operation_id) {
            return false;
        }
        self.pending_console_write = None;
        self.output_suppressed = false;
        self.notice_size = None;
        self.pending_jiggle = Some(JiggleLeg::Away);
        self.pending_win32_input.clear();
        true
    }

    /// Reports that the console write for `operation_id` failed. If it matches
    /// the in-flight write, clears it, marks this view degraded (no further
    /// writes are attempted), clears any pending restore/jiggle, and returns
    /// `true`; output remains suppressed since the screen state can no longer
    /// be trusted. A stale/unmatched `operation_id` is ignored, returning
    /// `false`.
    pub(crate) fn console_write_failed(&mut self, operation_id: OperationId) -> bool {
        if self.pending_console_write != Some(operation_id) {
            return false;
        }
        self.pending_console_write = None;
        self.degraded = true;
        self.restore_pending = false;
        self.pending_jiggle = None;
        true
    }

    /// Decides what to do with a chunk of in-process local-terminal stdin: see
    /// [`local_stdin_action`]. `TakeControl`/`SwallowInput` cover the displaced
    /// case; a controlling local terminal gets its bytes forwarded unchanged.
    pub(crate) fn local_input(&mut self, bytes: &[u8]) -> LocalViewAction {
        if !self.output_suppressed {
            self.pending_win32_input.clear();
            return LocalViewAction::ForwardInput(bytes.to_vec());
        }
        let has_take_control = contains_take_control_key(&mut self.pending_win32_input, bytes);
        match local_stdin_action(has_take_control, self.output_suppressed) {
            LocalStdinAction::TakeControl => LocalViewAction::TakeControl,
            LocalStdinAction::Swallow => LocalViewAction::SwallowInput,
            LocalStdinAction::Forward => LocalViewAction::ForwardInput(bytes.to_vec()),
        }
    }

    /// Schedules a two-leg repaint jiggle (Leg 1 next). Coalesces: a request
    /// while a jiggle is already in progress is a no-op, so overlapping
    /// restore/take-control events cannot stack extra resizes.
    pub(crate) fn request_jiggle(&mut self) {
        if self.pending_jiggle.is_none() {
            self.pending_jiggle = Some(JiggleLeg::Away);
        }
    }

    /// Consumes and advances the pending jiggle leg, returning the pty size
    /// for that leg computed from the current applied `cols`x`rows` (Leg 1:
    /// [`jiggle_size`]; Leg 2: the unchanged applied size). Returns `None` when
    /// no jiggle is pending.
    pub(crate) fn next_jiggle(
        &mut self,
        applied_cols: u16,
        applied_rows: u16,
    ) -> Option<(u16, u16)> {
        let leg = self.pending_jiggle?;
        let size = match leg {
            JiggleLeg::Away => jiggle_size(applied_cols, applied_rows),
            JiggleLeg::Back => (applied_cols, applied_rows),
        };
        self.pending_jiggle = leg.next();
        Some(size)
    }

    /// Whether local console output is currently paused (displaced, or a
    /// restore write is in flight).
    pub(crate) fn output_suppressed(&self) -> bool {
        self.output_suppressed
    }

    /// Whether a two-leg repaint jiggle has a leg still to run.
    pub(crate) fn jiggle_pending(&self) -> bool {
        self.pending_jiggle.is_some()
    }

    /// Whether a console write has failed, permanently disabling further local
    /// output for this view.
    pub(crate) fn degraded(&self) -> bool {
        self.degraded
    }

    /// The local console's current (clamped) size.
    pub(crate) fn host_size(&self) -> (u16, u16) {
        (self.host_cols, self.host_rows)
    }

    /// The current restore generation (advances on every schedule/cancel).
    pub(crate) fn restore_generation(&self) -> u64 {
        self.restore_generation
    }
}

#[cfg(test)]
mod tests {
    use super::{LocalViewAction, LocalViewState, LOCAL_RESTORE_DELAY};
    use crate::engine::effect::OperationId;

    #[test]
    fn restore_stays_suppressed_until_matching_console_completion() {
        let mut state = LocalViewState::attached(80, 24);
        state.controller_changed("dash", 100, 30);
        state.controller_changed("local", 80, 24);
        let action = state.restore_due(OperationId(9), b"repaint".to_vec());
        assert_eq!(
            action,
            LocalViewAction::WriteRestore {
                operation_id: OperationId(9),
                bytes: b"repaint".to_vec()
            }
        );
        assert!(state.output_suppressed());
        assert!(!state.console_write_completed(OperationId(8)));
        assert!(state.output_suppressed());
        assert!(state.console_write_completed(OperationId(9)));
        assert!(!state.output_suppressed());
        assert!(state.jiggle_pending());
    }

    #[test]
    fn displaced_transition_shows_notice_once_and_again_on_local_resize() {
        let mut state = LocalViewState::attached(80, 24);
        let first = state.controller_changed("dash", 100, 30);
        assert_eq!(
            first,
            vec![LocalViewAction::ShowNotice { cols: 80, rows: 24 }]
        );
        assert!(state.output_suppressed());

        // Repeating the same displacement at the same host size must not
        // re-render the notice.
        let repeat = state.controller_changed("dash", 100, 30);
        assert!(repeat.is_empty());

        // Resizing the local console while still displaced must re-center the
        // notice at the new size.
        let resized = state.local_resized(100, 40, Some("dash"));
        assert_eq!(
            resized,
            vec![LocalViewAction::ShowNotice {
                cols: 100,
                rows: 40
            }]
        );
        assert_eq!(state.host_size(), (100, 40));
    }

    #[test]
    fn local_controller_schedules_restore_with_generation() {
        let mut state = LocalViewState::attached(80, 24);
        state.controller_changed("dash", 100, 30);
        let actions = state.controller_changed("local", 80, 24);
        assert_eq!(
            actions,
            vec![LocalViewAction::ScheduleRestore {
                generation: 1,
                delay: LOCAL_RESTORE_DELAY,
            }]
        );
        assert_eq!(state.restore_generation(), 1);
    }

    #[test]
    fn redisplacement_cancels_pending_restore_and_clears_jiggle() {
        let mut state = LocalViewState::attached(80, 24);
        state.controller_changed("dash", 100, 30);
        let scheduled = state.controller_changed("local", 80, 24);
        assert_eq!(
            scheduled,
            vec![LocalViewAction::ScheduleRestore {
                generation: 1,
                delay: LOCAL_RESTORE_DELAY,
            }]
        );
        state.request_jiggle();
        assert!(state.jiggle_pending());

        // A second surface takes control before the restore fires: cancel it
        // and drop any in-flight jiggle. The take-control notice is already
        // showing at the same size, so it is not re-rendered.
        let cancelled = state.controller_changed("pwa", 90, 28);
        assert_eq!(
            cancelled,
            vec![LocalViewAction::CancelRestore { generation: 1 }]
        );
        assert_eq!(state.restore_generation(), 2);
        assert!(state.output_suppressed());
        assert!(!state.jiggle_pending());
    }

    #[test]
    fn local_resize_schedules_restore_when_suppressed_and_local_is_controller() {
        let mut state = LocalViewState::attached(80, 24);
        state.controller_changed("dash", 100, 30);
        // The controller flips to local out-of-band (the coordinator's
        // ControlState is the source of truth for identity); a local resize
        // must still notice the fit and schedule the deferred restore.
        let actions = state.local_resized(80, 24, Some("local"));
        assert_eq!(
            actions,
            vec![LocalViewAction::ScheduleRestore {
                generation: 1,
                delay: LOCAL_RESTORE_DELAY,
            }]
        );
    }

    #[test]
    fn redisplacement_during_console_restore_reasserts_notice_after_repaint() {
        let mut state = LocalViewState::attached(80, 24);
        state.controller_changed("dash", 100, 30);
        let scheduled = state.controller_changed("local", 80, 24);
        assert_eq!(
            scheduled,
            vec![LocalViewAction::ScheduleRestore {
                generation: 1,
                delay: LOCAL_RESTORE_DELAY,
            }]
        );

        let fired = state.restore_timer_fired(1, false, OperationId(9), b"repaint".to_vec());
        assert_eq!(
            fired,
            LocalViewAction::WriteRestore {
                operation_id: OperationId(9),
                bytes: b"repaint".to_vec()
            }
        );

        // A new non-local controller takes over while the restore write from
        // above is still in flight. The queued/possibly-already-painted
        // WriteRestore can no longer be trusted, so the notice must be
        // re-rendered even though the notice size hasn't changed and output
        // was already suppressed - otherwise the physical terminal could be
        // left showing the restored screen while state says displaced.
        let redisplaced = state.controller_changed("pwa", 80, 24);
        assert_eq!(
            redisplaced,
            vec![LocalViewAction::ShowNotice { cols: 80, rows: 24 }]
        );

        assert!(state.output_suppressed());
        assert!(!state.console_write_completed(OperationId(9)));
        assert!(!state.jiggle_pending());
    }

    #[test]
    fn stale_generation_is_ignored() {
        let mut state = LocalViewState::attached(80, 24);
        state.controller_changed("dash", 100, 30);
        state.controller_changed("local", 80, 24);
        assert_eq!(state.restore_generation(), 1);

        let stale = state.restore_timer_fired(0, false, OperationId(1), b"stale".to_vec());
        assert_eq!(stale, LocalViewAction::Noop);
        // Staleness must not disturb the still-pending current generation.
        assert!(state.output_suppressed());

        let fresh = state.restore_timer_fired(1, false, OperationId(2), b"fresh".to_vec());
        assert_eq!(
            fresh,
            LocalViewAction::WriteRestore {
                operation_id: OperationId(2),
                bytes: b"fresh".to_vec()
            }
        );
    }

    #[test]
    fn overgrown_due_restore_remains_suppressed() {
        let mut state = LocalViewState::attached(80, 24);
        state.controller_changed("dash", 100, 30);
        state.controller_changed("local", 80, 24);

        let action = state.restore_timer_fired(1, true, OperationId(5), b"repaint".to_vec());
        assert_eq!(action, LocalViewAction::Noop);
        assert!(state.output_suppressed());
        assert!(!state.jiggle_pending());

        // The next genuine shrink reschedules a fresh restore.
        let rescheduled = state.controller_changed("local", 80, 24);
        assert_eq!(
            rescheduled,
            vec![LocalViewAction::ScheduleRestore {
                generation: 2,
                delay: LOCAL_RESTORE_DELAY,
            }]
        );
    }

    #[test]
    fn matching_console_failure_degrades_and_stale_failure_is_ignored() {
        let mut state = LocalViewState::attached(80, 24);
        state.controller_changed("dash", 100, 30);
        state.controller_changed("local", 80, 24);
        let action = state.restore_due(OperationId(3), b"repaint".to_vec());
        assert_eq!(
            action,
            LocalViewAction::WriteRestore {
                operation_id: OperationId(3),
                bytes: b"repaint".to_vec()
            }
        );

        assert!(!state.console_write_failed(OperationId(4)));
        assert!(!state.degraded());

        assert!(state.console_write_failed(OperationId(3)));
        assert!(state.degraded());
        assert!(state.output_suppressed());
        assert!(!state.jiggle_pending());
    }

    #[test]
    fn space_takes_control_only_while_suppressed_and_normal_space_is_forwarded() {
        let mut state = LocalViewState::attached(80, 24);
        assert_eq!(
            state.local_input(b" hello"),
            LocalViewAction::ForwardInput(b" hello".to_vec())
        );

        state.controller_changed("dash", 100, 30);
        assert_eq!(state.local_input(b" "), LocalViewAction::TakeControl);
        assert_eq!(state.local_input(b"x"), LocalViewAction::SwallowInput);
    }

    #[test]
    fn jiggle_runs_away_then_back_then_none() {
        let mut state = LocalViewState::attached(80, 24);
        state.request_jiggle();
        assert!(state.jiggle_pending());
        assert_eq!(state.next_jiggle(80, 24), Some((79, 23)));
        assert!(state.jiggle_pending());
        assert_eq!(state.next_jiggle(80, 24), Some((80, 24)));
        assert!(!state.jiggle_pending());
        assert_eq!(state.next_jiggle(80, 24), None);
    }

    #[test]
    fn request_jiggle_coalesces_while_pending() {
        let mut state = LocalViewState::attached(80, 24);
        state.request_jiggle();
        state.request_jiggle();
        assert_eq!(state.next_jiggle(80, 24), Some((79, 23)));
        // A duplicate request after Leg 1 already started must not restart
        // Leg 1; the pending leg is still Back.
        state.request_jiggle();
        assert_eq!(state.next_jiggle(80, 24), Some((80, 24)));
    }

    #[test]
    fn jiggle_min_size_clamps() {
        let mut state = LocalViewState::attached(1, 1);
        state.request_jiggle();
        assert_eq!(state.next_jiggle(1, 1), Some((1, 2)));
    }

    #[test]
    fn headless_never_emits_actions() {
        let mut state = LocalViewState::headless(80, 24);
        assert!(state.controller_changed("dash", 100, 30).is_empty());
        assert!(state.local_resized(100, 40, Some("dash")).is_empty());
        assert!(!state.output_suppressed());
    }
}

#[cfg(test)]
mod restore_decision_tests {
    use super::{
        jiggle_rows, jiggle_size, local_restore_decision, JiggleLeg, LocalRestoreDecision,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn not_due_when_no_restore_pending() {
        let now = Instant::now();
        assert_eq!(
            local_restore_decision(None, now, false),
            LocalRestoreDecision::NotDue
        );
        assert_eq!(
            local_restore_decision(None, now, true),
            LocalRestoreDecision::NotDue
        );
    }

    #[test]
    fn not_due_before_deferral_elapses() {
        let now = Instant::now();
        let future = now + Duration::from_millis(250);
        assert_eq!(
            local_restore_decision(Some(future), now, false),
            LocalRestoreDecision::NotDue
        );
    }

    #[test]
    fn repaints_when_due_and_not_overgrown() {
        let now = Instant::now();
        let past = now - Duration::from_millis(1);
        assert_eq!(
            local_restore_decision(Some(past), now, false),
            LocalRestoreDecision::Repaint
        );
    }

    #[test]
    fn jiggle_rows_steps_down_when_room() {
        assert_eq!(jiggle_rows(24), 23);
        assert_eq!(jiggle_rows(2), 1);
    }

    #[test]
    fn jiggle_rows_steps_up_at_minimum() {
        // rows == 1 cannot step down (resize clamps to >= 1, which would be a
        // no-op the de-dupe swallows), so step up instead to force a change.
        assert_eq!(jiggle_rows(1), 2);
    }

    #[test]
    fn jiggle_rows_is_never_equal_to_input() {
        for rows in [1u16, 2, 24, 50, 200, u16::MAX - 1] {
            assert_ne!(jiggle_rows(rows), rows);
        }
    }

    #[test]
    fn jiggle_size_shrinks_columns_and_rows() {
        assert_eq!(jiggle_size(80, 24), (79, 23));
        assert_eq!(jiggle_size(2, 2), (1, 1));
    }

    #[test]
    fn jiggle_size_clamps_columns_at_minimum() {
        // cols cannot shrink below 1; rows step up from 1. At least one dim
        // always changes, so the resize is never a no-op the de-dupe swallows.
        assert_eq!(jiggle_size(1, 1), (1, 2));
        assert_eq!(jiggle_size(1, 50), (1, 49));
    }

    #[test]
    fn jiggle_size_is_never_equal_to_input() {
        for (cols, rows) in [
            (1u16, 1u16),
            (1, 24),
            (80, 24),
            (200, 50),
            (u16::MAX, u16::MAX),
        ] {
            assert_ne!(jiggle_size(cols, rows), (cols, rows));
        }
    }

    #[test]
    fn jiggle_leg_advances_away_to_back_to_done() {
        assert_eq!(JiggleLeg::Away.next(), Some(JiggleLeg::Back));
        assert_eq!(JiggleLeg::Back.next(), None);
    }

    #[test]
    fn skips_when_due_but_still_overgrown() {
        // Regression guard for the Windows corruption: a viewer re-grew the PTY
        // during the deferral, so resuming the local terminal would expose
        // ConPTY's tall-grid absolute-positioned output to the shorter console.
        let now = Instant::now();
        let past = now - Duration::from_millis(1);
        assert_eq!(
            local_restore_decision(Some(past), now, true),
            LocalRestoreDecision::SkipOvergrown
        );
    }
}

#[cfg(test)]
mod local_stdin_tests {
    use super::{local_stdin_action, LocalStdinAction, LocalViewAction, LocalViewState};

    #[test]
    fn space_is_forwarded_as_normal_input_when_controlling() {
        // Critical: when the local terminal holds control, Space (the
        // take-control key) is ordinary shell input and MUST be forwarded, not
        // swallowed -- otherwise the user could never type a space.
        assert_eq!(local_stdin_action(true, false), LocalStdinAction::Forward);
    }

    #[test]
    fn space_takes_control_when_displaced() {
        assert_eq!(
            local_stdin_action(true, true),
            LocalStdinAction::TakeControl
        );
    }

    #[test]
    fn displaced_input_is_swallowed() {
        assert_eq!(local_stdin_action(false, true), LocalStdinAction::Swallow);
    }

    #[test]
    fn windows_win32_input_mode_space_takes_control_when_displaced() {
        let mut state = LocalViewState::attached(103, 51);
        state.controller_changed("dashboard", 81, 30);

        assert_eq!(
            state.local_input(b"\x1b[32;57;32;1;32;1_"),
            LocalViewAction::TakeControl
        );
        assert_eq!(
            state.local_input(b"\x1b[I\x1b[32;57;32;1;32;1_"),
            LocalViewAction::TakeControl
        );
    }

    #[test]
    fn windows_win32_input_mode_nonspace_and_keyup_are_swallowed() {
        let mut state = LocalViewState::attached(103, 51);
        state.controller_changed("dashboard", 81, 30);

        assert_eq!(
            state.local_input(b"\x1b[65;30;97;1;32;1_"),
            LocalViewAction::SwallowInput
        );
        assert_eq!(
            state.local_input(b"\x1b[32;57;32;0;32;1_"),
            LocalViewAction::SwallowInput
        );
    }

    #[test]
    fn windows_win32_input_mode_is_forwarded_unchanged_while_controlling() {
        const SPACE: &[u8] = b"\x1b[32;57;32;1;32;1_";
        let mut state = LocalViewState::attached(103, 51);

        assert_eq!(
            state.local_input(SPACE),
            LocalViewAction::ForwardInput(SPACE.to_vec())
        );
    }

    #[test]
    fn windows_win32_input_mode_space_survives_every_chunk_split() {
        const SPACE: &[u8] = b"\x1b[32;57;32;1;32;1_";

        for split in 1..SPACE.len() {
            let mut state = LocalViewState::attached(103, 51);
            state.controller_changed("dashboard", 81, 30);

            assert_eq!(
                state.local_input(&SPACE[..split]),
                LocalViewAction::SwallowInput,
                "first chunk unexpectedly reclaimed at split {split}"
            );
            assert_eq!(
                state.local_input(&SPACE[split..]),
                LocalViewAction::TakeControl,
                "split Win32 Space was not recognized at split {split}"
            );
        }
    }

    #[test]
    fn ordinary_input_is_forwarded_when_controlling() {
        assert_eq!(local_stdin_action(false, false), LocalStdinAction::Forward);
    }
}

#[cfg(test)]
mod local_displaced_tests {
    use super::local_displaced_by_controller;

    #[test]
    fn not_displaced_when_local_is_controller() {
        assert!(!local_displaced_by_controller(Some("local")));
    }

    #[test]
    fn not_displaced_when_no_controller_yet() {
        assert!(!local_displaced_by_controller(None));
    }

    #[test]
    fn displaced_when_a_dashboard_controls_regardless_of_size() {
        // Identity-based: any non-local controller displaces the local terminal,
        // even a dashboard whose grid is smaller than the local console.
        assert!(local_displaced_by_controller(Some("dashboard-abc")));
        assert!(local_displaced_by_controller(Some("terminal-1234")));
    }
}

#[cfg(test)]
mod local_exit_restore_tests {
    use super::local_exit_restore_bytes;
    use std::collections::HashMap;

    #[test]
    fn no_restore_when_local_not_attached() {
        // A headless daemon has no local screen to restore.
        assert_eq!(
            local_exit_restore_bytes(false, true, b"hello", 80, 24, &HashMap::new()),
            None
        );
    }

    #[test]
    fn no_restore_when_not_suppressed() {
        // The local terminal already holds control (not displaced): its live
        // output already painted the final screen, so nothing to repaint.
        assert_eq!(
            local_exit_restore_bytes(true, false, b"hello", 80, 24, &HashMap::new()),
            None
        );
    }

    #[test]
    fn restores_final_screen_when_attached_and_displaced() {
        // The reported bug: the session exited while a dashboard controlled the
        // grid, so the local terminal is suppressed on the take-control notice.
        // On exit we must repaint the command's final screen from scrollback.
        let out =
            local_exit_restore_bytes(true, true, b"final screen output", 80, 24, &HashMap::new())
                .expect("a displaced local terminal must be repainted on exit");
        let text = String::from_utf8_lossy(&out);
        assert!(
            text.contains("final screen output"),
            "exit restore must repaint the command's final screen; got {text:?}"
        );
        assert!(
            !text.contains("Press Space to take control."),
            "exit restore must not leave the take-control notice on screen; got {text:?}"
        );
    }

    #[test]
    fn exit_restore_never_clears_scrollback() {
        // `\e[2J` clears scrollback on Windows Terminal (and others); the exit
        // restore must only ever repaint the visible viewport.
        let out =
            local_exit_restore_bytes(true, true, b"final screen output", 80, 24, &HashMap::new())
                .expect("a displaced local terminal must be repainted on exit");
        let text = String::from_utf8_lossy(&out);
        assert!(
            !text.contains("\x1b[2J"),
            "exit restore must never emit a full-screen scrollback clear; got {text:?}"
        );
    }
}
