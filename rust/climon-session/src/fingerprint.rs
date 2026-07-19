//! Headless VT-grid fingerprint for static-screen idle detection.
//!
//! PTY output is mirrored into a [`vt100`] parser grid; once a second the
//! [`HeadlessGrid::fingerprint`] is sampled and fed to the pure
//! [`crate::idle::ScreenIdleDetector`]. The fingerprint is `{cols}x{rows}\n` plus
//! one trailing-trimmed line per visible row, mirroring the TS daemon's
//! `@xterm/headless` sampling.
//!
//! **The fingerprint is internal state — never sent over the wire — so it does
//! not need byte-parity with xterm.js.** It only has to be stable when content
//! is stable and change when visible content changes. We therefore use `vt100`
//! (MIT) rather than attempting to replicate xterm.js cell rendering.

/// A headless terminal grid producing idle-detection fingerprints.
pub struct HeadlessGrid {
    parser: vt100::Parser,
    cols: u16,
    rows: u16,
}

/// vt100 0.16.2's `Grid::col_wrap` underflows `prev_pos.row -= scrolled` when
/// the grid is a single row tall (its default scroll region bottom is row 0),
/// which in release wraps to a bogus index and panics on
/// `drawing_row_mut(..).unwrap()`. The backing parser is therefore always given
/// at least this many rows; the logical `rows` still drives fingerprint/line
/// sampling so external behaviour is unchanged for real terminal sizes.
const MIN_PARSER_ROWS: u16 = 2;

impl HeadlessGrid {
    /// Creates a grid of `cols` x `rows` (each floored at 1).
    pub fn new(cols: u16, rows: u16) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        HeadlessGrid {
            parser: vt100::Parser::new(rows.max(MIN_PARSER_ROWS), cols, 0),
            cols,
            rows,
        }
    }

    /// Feeds PTY output into the grid.
    pub fn write(&mut self, data: &[u8]) {
        self.parser.process(data);
    }

    /// Resizes the grid (each dimension floored at 1).
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        self.cols = cols;
        self.rows = rows;
        self.parser
            .screen_mut()
            .set_size(rows.max(MIN_PARSER_ROWS), cols);
    }

    /// Renders the current visible screen as self-contained escape codes
    /// suitable for repainting a raw terminal after the local output was paused.
    ///
    /// Two Windows-specific hazards drive the implementation:
    ///
    /// 1. We must NOT replay the raw PTY scrollback: on Windows ConPTY that byte
    ///    stream is a sequence of absolute-positioned screen diffs that stack on
    ///    top of each other (corrupt/blank) when replayed in bulk to a cleared
    ///    console.
    /// 2. We must NOT use absolute cursor positioning (as `vt100`'s
    ///    `contents_formatted` does — it skips blank rows with `\e[<n>;1H`
    ///    jumps). If the real console's window is even slightly shorter than the
    ///    grid, the sequential `\r\n` writes scroll the window and those absolute
    ///    jumps then land on the wrong physical row, overwriting earlier lines.
    ///
    /// So this emits a purely sequential repaint — home, clear, then each visible
    /// row (including interior blank rows) separated only by `\r\n`, with trailing
    /// blank rows trimmed so the cursor naturally ends after the last content row
    /// (the shell prompt). This mirrors how normal live output reaches the
    /// terminal and is robust to a console height mismatch (content scrolls
    /// naturally instead of misaligning).
    pub fn render_screen(&self) -> Vec<u8> {
        let screen = self.parser.screen();
        let mut rows: Vec<Vec<u8>> = screen.rows_formatted(0, self.cols).collect();
        while rows.len() > 1 && rows.last().map(|r| r.is_empty()).unwrap_or(false) {
            rows.pop();
        }
        let mut out = Vec::new();
        // Clear the visible viewport before replaying. The displaced notice uses
        // the same home/reset/erase operations; without them a reclaim replay can
        // leave the notice painted behind a sparse screen on Windows Terminal.
        // NEVER `\e[2J`: on Windows Terminal (and others) it clears scrollback.
        out.extend_from_slice(b"\x1b[H\x1b[m\x1b[J");
        for (i, row) in rows.iter().enumerate() {
            if i > 0 {
                out.extend_from_slice(b"\r\n");
            }
            // Reset SGR *before* the erase so the erased cells are painted with
            // the default background (kills the vt100 last-cell attribute bleed);
            // the row content then re-establishes whatever attributes it needs.
            out.extend_from_slice(b"\x1b[m\x1b[2K");
            out.extend_from_slice(row);
        }
        // Clear from the cursor to the end of the visible screen so stale rows
        // below the current content are removed. `\e[J` (erase-below) does NOT
        // touch scrollback, unlike `\e[2J`.
        out.extend_from_slice(b"\x1b[m\x1b[J");
        out
    }

    /// Samples the current screen as `{cols}x{rows}\n<trimmed rows>`.
    pub fn fingerprint(&self) -> String {
        let screen = self.parser.screen();
        let mut out = format!("{}x{}", self.cols, self.rows);
        for row in 0..self.rows {
            out.push('\n');
            let mut line = String::new();
            for col in 0..self.cols {
                if let Some(cell) = screen.cell(row, col) {
                    let contents = cell.contents();
                    if contents.is_empty() {
                        line.push(' ');
                    } else {
                        line.push_str(contents);
                    }
                }
            }
            out.push_str(line.trim_end());
        }
        out
    }

    /// Returns the current visible screen as one trailing-trimmed string per
    /// row (top to bottom), with no dimension header. Used by the smart-
    /// notification snippet extractor.
    pub fn visible_lines(&self) -> Vec<String> {
        let screen = self.parser.screen();
        let mut out = Vec::with_capacity(self.rows as usize);
        for row in 0..self.rows {
            let mut line = String::new();
            for col in 0..self.cols {
                if let Some(cell) = screen.cell(row, col) {
                    let contents = cell.contents();
                    if contents.is_empty() {
                        line.push(' ');
                    } else {
                        line.push_str(contents);
                    }
                }
            }
            out.push(line.trim_end().to_string());
        }
        out
    }

    /// Row index (0-based, top of the visible grid) the cursor currently sits on.
    /// The smart-notification extractor uses this to ignore the input composer and
    /// any help/status bar rendered at or below it, since the agent's response
    /// sits above the cursor.
    pub fn cursor_row(&self) -> u16 {
        // The backing parser may carry more rows than the logical grid (see
        // `MIN_PARSER_ROWS`); clamp so the cursor row stays within the logical
        // dimensions. This is a no-op for real (>= 2 row) terminal sizes.
        self.parser
            .screen()
            .cursor_position()
            .0
            .min(self.rows.saturating_sub(1))
    }
}

/// Rebuilds a screen at the requested size from the bounded raw PTY shadow,
/// then emits the same viewport-only repaint as [`HeadlessGrid::render_screen`].
///
/// This is used for local-terminal restore because the controller-sized idle
/// grid may have been narrowed by a dashboard, permanently discarding cells to
/// the right of that dashboard's edge. Parsing the shadow into a fresh
/// host-sized grid recovers those cells without replaying raw PTY/ConPTY diffs
/// directly to the real console.
pub(crate) fn render_screen_from_replay(replay: &[u8], cols: u16, rows: u16) -> Vec<u8> {
    let mut grid = HeadlessGrid::new(cols, rows);
    grid.write(replay);
    grid.render_screen()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_header_reflects_dimensions() {
        let grid = HeadlessGrid::new(80, 24);
        assert!(grid.fingerprint().starts_with("80x24\n"));
    }

    #[test]
    fn fingerprint_is_stable_when_content_is_stable() {
        let mut grid = HeadlessGrid::new(20, 5);
        grid.write(b"hello world");
        let a = grid.fingerprint();
        let b = grid.fingerprint();
        assert_eq!(a, b);
        assert!(a.contains("hello world"));
    }

    #[test]
    fn fingerprint_changes_when_content_changes() {
        let mut grid = HeadlessGrid::new(20, 5);
        grid.write(b"first");
        let before = grid.fingerprint();
        grid.write(b"\r\nsecond");
        let after = grid.fingerprint();
        assert_ne!(before, after);
        assert!(after.contains("second"));
    }

    #[test]
    fn resize_updates_the_header_dimensions() {
        let mut grid = HeadlessGrid::new(80, 24);
        grid.resize(120, 30);
        assert!(grid.fingerprint().starts_with("120x30\n"));
    }

    #[test]
    fn fingerprint_has_one_line_per_row_plus_header() {
        let grid = HeadlessGrid::new(10, 4);
        assert_eq!(grid.fingerprint().split('\n').count(), 1 + 4);
    }

    #[test]
    fn content_survives_shrink_then_grow_resize() {
        // Repro of the local take-control blank-screen bug: session starts large,
        // a dashboard shrinks the PTY, then the local terminal reclaims and grows
        // it back. render_screen() must still contain the prompt row -- if
        // vt100::set_size drops content across the shrink/grow, the restore
        // repaint is empty and the local terminal blanks.
        let mut grid = HeadlessGrid::new(156, 47);
        grid.write(b"PS C:\\> ");
        assert!(grid.fingerprint().contains("PS C:\\>"));

        grid.resize(154, 15); // dashboard takes control (smaller)
        grid.resize(156, 47); // local reclaims (back to host size)

        let repaint = String::from_utf8_lossy(&grid.render_screen()).to_string();
        assert!(
            repaint.contains("PS C:\\>"),
            "prompt lost across shrink/grow resize; repaint={repaint:?}"
        );
    }

    #[test]
    fn right_hand_cells_survive_shrink_then_grow_resize() {
        // Repro of the local restore clipping bug: a wide static line is visible
        // in the local terminal, a narrower dashboard takes control, then the
        // local terminal reclaims its original width. The controller-sized idle
        // grid permanently discards cells to the right of the dashboard edge, so
        // restore must rebuild a fresh host-sized grid from the raw PTY shadow.
        let replay = b"left side                                              RIGHT_EDGE";
        let mut grid = HeadlessGrid::new(80, 4);
        grid.write(replay);

        grid.resize(20, 4);
        grid.resize(80, 4);

        let repaint =
            String::from_utf8_lossy(&render_screen_from_replay(replay, 80, 4)).to_string();
        assert!(
            repaint.contains("RIGHT_EDGE"),
            "host-sized replay restore lost right-hand cells; repaint={repaint:?}"
        );
    }

    #[test]
    fn render_screen_reproduces_current_screen_when_reparsed() {
        // Drive the grid with output that uses absolute cursor moves (the kind
        // of sequence that, when replayed raw to a real console, stacks lines on
        // top of each other). `render_screen()` must emit a clean self-contained
        // repaint: feeding it into a fresh parser of the same size must yield the
        // identical visible screen.
        let mut grid = HeadlessGrid::new(20, 5);
        grid.write(b"line one\r\nline two\r\nline three");
        // Absolute reposition + overwrite, exercising non-append rendering.
        grid.write(b"\x1b[1;1Hxx");

        let repaint = grid.render_screen();

        let mut replayed = vt100::Parser::new(5, 20, 0);
        replayed.process(&repaint);

        assert_eq!(
            replayed.screen().contents(),
            grid.parser.screen().contents(),
            "grid repaint must reproduce the current screen exactly"
        );
        // Lines must remain distinct (regression guard for the Windows ConPTY
        // "missing carriage returns / stacked lines" corruption).
        let text = replayed.screen().contents();
        assert!(
            text.contains("line two"),
            "expected distinct rows, got: {text:?}"
        );
        assert!(
            text.contains("line three"),
            "expected distinct rows, got: {text:?}"
        );
        // Must NOT use absolute cursor positioning: on a real console whose
        // window is shorter than the grid, the sequential writes scroll and any
        // `\e[<row>;1H` jump then lands on the wrong physical row. Only `\e[H`
        // (home) is allowed; row-addressed `\e[<n>;1H` / `\e[<n>d` are not.
        let bytes = String::from_utf8_lossy(&repaint);
        for seq in bytes.split('\u{1b}') {
            assert!(
                !(seq.starts_with('[') && seq.contains(';') && seq.ends_with('H') && seq.len() > 2),
                "repaint must not use absolute row positioning, found: {seq:?}"
            );
        }
    }

    #[test]
    fn render_screen_resets_sgr_before_every_erase_and_never_clears_scrollback() {
        // Regression: render_screen must (a) never emit `\e[2J` (clears
        // scrollback on Windows Terminal), and (b) reset SGR *before* every
        // erase so a lingering background attribute cannot bleed into the
        // cleared cells / prompt.
        let mut grid = HeadlessGrid::new(20, 4);
        // Blue background then text, leaving the blue attribute active on the
        // last painted cell (the vt100 bleed source).
        grid.write(b"\x1b[44mline one\r\nline two");

        let out = String::from_utf8_lossy(&grid.render_screen()).to_string();

        // (a) No full-screen clear anywhere in the repaint.
        assert!(
            !out.contains("\x1b[2J"),
            "render_screen must never emit \\e[2J (nukes scrollback); got {out:?}"
        );

        // (b) Every erase (`\e[2K` erase-line or `\e[J` erase-below) must be
        // immediately preceded by an SGR reset (`\e[m`) so cleared cells use
        // the default background.
        for erase in ["\x1b[2K", "\x1b[J"] {
            let mut from = 0;
            while let Some(rel) = out[from..].find(erase) {
                let idx = from + rel;
                assert!(
                    out[..idx].ends_with("\x1b[m"),
                    "erase {erase:?} at byte {idx} not preceded by \\e[m reset in {out:?}"
                );
                from = idx + erase.len();
            }
        }

        // Content is still present.
        assert!(out.contains("line one") && out.contains("line two"));
    }

    #[test]
    fn visible_lines_returns_one_trimmed_string_per_row() {
        let mut grid = HeadlessGrid::new(20, 3);
        grid.write(b"hello world\r\nsecond line");
        let rows = grid.visible_lines();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], "hello world");
        assert_eq!(rows[1], "second line");
        assert_eq!(rows[2], "");
    }

    #[test]
    fn single_row_grid_wraps_without_panicking() {
        // Regression (release-gate DAR-08): vt100 0.16.2's `Grid::col_wrap`
        // underflows `prev_pos.row -= scrolled` on a height-1 grid (whose
        // default scroll region bottom is row 0). In release the underflow
        // wraps to a bogus row index and `drawing_row_mut(..).unwrap()` hits
        // `None` (grid.rs:689); in debug it panics as "subtract with overflow"
        // (grid.rs:683). A 1-row `HeadlessGrid` arises whenever a resize floors
        // rows to 1; sustained wide output then wraps at the right edge and
        // crashes the daemon's fingerprint-sampling task.
        let mut grid = HeadlessGrid::new(10, 1);
        grid.write(b"aaaaaaaaaaaaaaaaaaaa");
        assert!(grid.fingerprint().starts_with("10x1\n"));
    }

    #[test]
    fn resize_to_single_row_then_wrapping_output_does_not_panic() {
        // The production trigger: a viewer/host resize collapses the grid to a
        // single row (rows floored at 1), and continued high-volume wide output
        // wraps past the right edge, driving the vt100 col_wrap underflow.
        let mut grid = HeadlessGrid::new(80, 24);
        grid.write(b"hello");
        grid.resize(80, 0); // degenerate resize -> clamped to 1 row
        grid.write(
            b"this is a long line of output that comfortably exceeds eighty \
              columns and therefore has to wrap around the right edge more \
              than once to exercise the col_wrap scroll path",
        );
        assert!(grid.fingerprint().starts_with("80x1\n"));
    }

    #[test]
    fn cursor_row_tracks_the_current_output_row() {
        let mut grid = HeadlessGrid::new(20, 4);
        assert_eq!(grid.cursor_row(), 0);
        // Two newlines advance the cursor to the third row (index 2).
        grid.write(b"line one\r\nline two\r\n> ");
        assert_eq!(grid.cursor_row(), 2);
    }
}
