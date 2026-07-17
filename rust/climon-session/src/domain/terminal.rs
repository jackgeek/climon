//! Pure terminal model: scrollback shadow, headless idle-fingerprint grid,
//! mouse private-mode tracking, and OSC title/progress capture — wired
//! together in the exact mutation order the legacy reader thread uses
//! (`crate::host::legacy::spawn_reader_thread`), but with no I/O of its own.
//!
// Consumed by the aggregate actor state assembled in a later task (Task 8);
// some accessors below are unused within this crate until then.
#![allow(dead_code)]

use std::collections::HashMap;

use climon_proto::frame::{encode_frame, FrameType};
use climon_proto::meta::TerminalProgress;

use crate::fingerprint::{render_screen_from_replay, HeadlessGrid};
use crate::replay::{
    build_mouse_private_mode_replay_suffix, build_mouse_private_mode_restore_suffix,
    track_mouse_private_modes_from_output, TRACKED_MOUSE_PRIVATE_MODES,
};
use crate::title_capture::capture_terminal_output;

/// Result of feeding one chunk of PTY output through [`TerminalModel::apply_output`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalUpdate {
    /// The unmodified output re-encoded as a passthrough `FrameType::Output` frame.
    pub(crate) output_frame: Vec<u8>,
    /// Whether the captured terminal title changed as a result of this chunk.
    pub(crate) title_changed: bool,
    /// Whether the captured terminal progress changed as a result of this chunk.
    pub(crate) progress_changed: bool,
}

/// Pure terminal-domain state: the scrollback shadow, the headless
/// idle-fingerprint grid, mouse private-mode tracking, and OSC title/progress
/// capture. Every byte of PTY output is passed through unmodified; this model
/// only *observes* it.
pub(crate) struct TerminalModel {
    scrollback: climon_pty::Scrollback,
    grid: HeadlessGrid,
    mouse_mode_state: HashMap<String, bool>,
    mouse_mode_remainder: String,
    terminal_title_remainder: String,
    captured_terminal_title: Option<String>,
    captured_progress: Option<Option<TerminalProgress>>,
}

impl TerminalModel {
    /// Creates a terminal model with a `cols`x`rows` idle grid and a
    /// scrollback shadow capped at `scrollback_cap` bytes.
    pub(crate) fn new(cols: u16, rows: u16, scrollback_cap: usize) -> Self {
        TerminalModel {
            scrollback: climon_pty::Scrollback::new(scrollback_cap),
            grid: HeadlessGrid::new(cols, rows),
            mouse_mode_state: HashMap::new(),
            mouse_mode_remainder: String::new(),
            terminal_title_remainder: String::new(),
            captured_terminal_title: None,
            captured_progress: None,
        }
    }

    /// Feeds one chunk of raw PTY output through the model, mirroring the
    /// legacy reader thread's mutation order: mouse private-mode tracking,
    /// then OSC title/progress capture, then scrollback append, then grid
    /// write. Returns the passthrough output frame plus whether the captured
    /// title/progress changed.
    pub(crate) fn apply_output(&mut self, data: &[u8]) -> TerminalUpdate {
        let remainder = std::mem::take(&mut self.mouse_mode_remainder);
        self.mouse_mode_remainder = track_mouse_private_modes_from_output(
            &mut self.mouse_mode_state,
            data,
            &remainder,
            TRACKED_MOUSE_PRIVATE_MODES,
        );

        let title_remainder = std::mem::take(&mut self.terminal_title_remainder);
        let title_before = self.captured_terminal_title.clone();
        let progress_before = self.captured_progress;
        let mut captured_title = self.captured_terminal_title.take();
        let mut captured_progress = self.captured_progress.take();
        self.terminal_title_remainder = capture_terminal_output(
            &mut captured_title,
            &mut captured_progress,
            data,
            &title_remainder,
        );
        self.captured_terminal_title = captured_title;
        self.captured_progress = captured_progress;

        self.scrollback.append(data);
        self.grid.write(data);

        TerminalUpdate {
            output_frame: encode_frame(FrameType::Output, data),
            title_changed: title_before != self.captured_terminal_title,
            progress_changed: progress_before != self.captured_progress,
        }
    }

    /// Builds the replay payload: the raw scrollback snapshot plus the mouse
    /// private-mode re-assertion suffix, in `TRACKED_MOUSE_PRIVATE_MODES`
    /// order.
    pub(crate) fn replay_snapshot(&self) -> Vec<u8> {
        let mut snapshot = self.scrollback.snapshot();
        let suffix = build_mouse_private_mode_replay_suffix(
            &self.mouse_mode_state,
            TRACKED_MOUSE_PRIVATE_MODES,
        );
        if !suffix.is_empty() {
            snapshot.extend_from_slice(&suffix);
        }
        snapshot
    }

    /// Returns the raw scrollback snapshot with no mouse-mode replay suffix.
    pub(crate) fn scrollback_snapshot(&self) -> Vec<u8> {
        self.scrollback.snapshot()
    }

    /// Resizes the idle-fingerprint grid (each dimension floored at 1).
    pub(crate) fn resize(&mut self, cols: u16, rows: u16) {
        self.grid.resize(cols, rows);
    }

    /// Samples the current idle-fingerprint grid.
    pub(crate) fn fingerprint(&self) -> String {
        self.grid.fingerprint()
    }

    /// Returns one trailing-trimmed string per visible row.
    pub(crate) fn visible_lines(&self) -> Vec<String> {
        self.grid.visible_lines()
    }

    /// Row index (0-based) the cursor currently sits on in the idle grid.
    pub(crate) fn cursor_row(&self) -> u16 {
        self.grid.cursor_row()
    }

    /// Rebuilds a screen at `cols`x`rows` from the raw scrollback shadow and
    /// emits a self-contained viewport repaint. Used for local-terminal
    /// restore, since the idle grid may have been narrowed by a dashboard.
    pub(crate) fn render_host_screen(&self, cols: u16, rows: u16) -> Vec<u8> {
        render_screen_from_replay(&self.scrollback.snapshot(), cols, rows)
    }

    /// The last captured terminal title, if any OSC 0/2 title sequence has
    /// been observed.
    pub(crate) fn captured_title(&self) -> Option<&str> {
        self.captured_terminal_title.as_deref()
    }

    /// The last captured terminal progress state. Outer `None` means no OSC
    /// 9;4 sequence has ever been observed; `Some(None)` means it was
    /// explicitly cleared.
    pub(crate) fn captured_progress(&self) -> Option<Option<TerminalProgress>> {
        self.captured_progress
    }

    /// Whether `mode` (e.g. `"1000"`) is currently enabled.
    pub(crate) fn mouse_mode_enabled(&self, mode: &str) -> bool {
        self.mouse_mode_state.get(mode) == Some(&true)
    }

    /// Builds a local-terminal mode synchronization sequence: clears every
    /// tracked mouse mode, then re-enables the modes currently active on the
    /// PTY.
    pub(crate) fn mouse_restore_suffix(&self) -> Vec<u8> {
        build_mouse_private_mode_restore_suffix(&self.mouse_mode_state, TRACKED_MOUSE_PRIVATE_MODES)
    }
}

#[cfg(test)]
mod tests {
    use climon_proto::frame::{FrameDecoder, FrameType};

    use super::TerminalModel;

    #[test]
    fn output_updates_replay_grid_modes_and_passthrough_frame() {
        let mut terminal = TerminalModel::new(80, 24, 256 * 1024);
        let update = terminal.apply_output(b"\x1b]0;build\x07hello\x1b[?1000h");
        let decoded = FrameDecoder::new().push(&update.output_frame);
        assert_eq!(decoded[0].frame_type, FrameType::Output);
        assert_eq!(decoded[0].payload, b"\x1b]0;build\x07hello\x1b[?1000h");
        assert!(terminal.replay_snapshot().windows(5).any(|w| w == b"hello"));
        assert_eq!(terminal.captured_title(), Some("build"));
        assert!(terminal.mouse_mode_enabled("1000"));
    }

    #[test]
    fn split_osc_title_across_chunks_updates_title_only_after_terminator() {
        let mut terminal = TerminalModel::new(80, 24, 4096);
        let first = terminal.apply_output(b"\x1b]0;spl");
        assert_eq!(terminal.captured_title(), None);
        assert!(!first.title_changed);
        let second = terminal.apply_output(b"it\x07");
        assert_eq!(terminal.captured_title(), Some("split"));
        assert!(second.title_changed);
    }

    #[test]
    fn split_mouse_private_mode_control_across_chunks_is_tracked() {
        let mut terminal = TerminalModel::new(80, 24, 4096);
        terminal.apply_output(b"\x1b[?10");
        assert!(!terminal.mouse_mode_enabled("1000"));
        terminal.apply_output(b"00h");
        assert!(terminal.mouse_mode_enabled("1000"));
    }

    #[test]
    fn replay_appends_enabled_mouse_modes_in_deterministic_tracked_order() {
        let mut terminal = TerminalModel::new(80, 24, 4096);
        terminal.apply_output(b"body\x1b[?1006h\x1b[?1000h\x1b[?1002h");
        let replay = terminal.replay_snapshot();
        assert!(replay.starts_with(b"body\x1b[?1006h\x1b[?1000h\x1b[?1002h"));
        let suffix = &replay[b"body\x1b[?1006h\x1b[?1000h\x1b[?1002h".len()..];
        assert_eq!(suffix, b"\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    }

    #[test]
    fn scrollback_snapshot_excludes_replay_suffix() {
        let mut terminal = TerminalModel::new(80, 24, 4096);
        terminal.apply_output(b"body\x1b[?1000h");
        assert_eq!(terminal.scrollback_snapshot(), b"body\x1b[?1000h");
        assert_ne!(terminal.scrollback_snapshot(), terminal.replay_snapshot());
    }

    #[test]
    fn resize_changes_fingerprint_header_and_clamps_zero_to_one() {
        let mut terminal = TerminalModel::new(80, 24, 4096);
        assert!(terminal.fingerprint().starts_with("80x24\n"));
        terminal.resize(120, 30);
        assert!(terminal.fingerprint().starts_with("120x30\n"));
        terminal.resize(0, 0);
        assert!(terminal.fingerprint().starts_with("1x1\n"));
    }

    #[test]
    fn captured_progress_reports_active_osc_9_4_and_clear_state() {
        let mut terminal = TerminalModel::new(80, 24, 4096);
        assert_eq!(terminal.captured_progress(), None);
        let update = terminal.apply_output(b"\x1b]9;4;1;40\x07");
        assert!(update.progress_changed);
        assert_eq!(
            terminal.captured_progress(),
            Some(Some(climon_proto::meta::TerminalProgress {
                state: climon_proto::meta::ProgressState::Normal,
                value: Some(40),
            }))
        );
        let cleared = terminal.apply_output(b"\x1b]9;4;0\x07");
        assert!(cleared.progress_changed);
        assert_eq!(terminal.captured_progress(), Some(None));
    }

    #[test]
    fn render_host_screen_uses_raw_replay_at_requested_host_dimensions() {
        let mut terminal = TerminalModel::new(20, 4, 4096);
        terminal.apply_output(b"left side wide content that keeps going RIGHT_EDGE");
        terminal.resize(10, 4);
        let repaint = String::from_utf8_lossy(&terminal.render_host_screen(60, 4)).to_string();
        assert!(repaint.contains("RIGHT_EDGE"));
        assert!(!repaint.contains("\x1b[2J"));
    }

    #[test]
    fn title_changed_and_progress_changed_are_false_when_values_repeat() {
        let mut terminal = TerminalModel::new(80, 24, 4096);
        terminal.apply_output(b"\x1b]0;same\x07\x1b]9;4;1;10\x07");
        let repeated = terminal.apply_output(b"\x1b]0;same\x07\x1b]9;4;1;10\x07");
        assert!(!repeated.title_changed);
        assert!(!repeated.progress_changed);
    }
}
