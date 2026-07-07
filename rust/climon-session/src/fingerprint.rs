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

impl HeadlessGrid {
    /// Creates a grid of `cols` x `rows` (each floored at 1).
    pub fn new(cols: u16, rows: u16) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        HeadlessGrid {
            parser: vt100::Parser::new(rows, cols, 0),
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
        self.parser.screen_mut().set_size(rows, cols);
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
        out.extend_from_slice(b"\x1b[H\x1b[2J\x1b[m");
        for (i, row) in rows.iter().enumerate() {
            if i > 0 {
                out.extend_from_slice(b"\r\n");
            }
            out.extend_from_slice(b"\x1b[2K");
            out.extend_from_slice(row);
        }
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
        self.parser.screen().cursor_position().0
    }
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
    fn cursor_row_tracks_the_current_output_row() {
        let mut grid = HeadlessGrid::new(20, 4);
        assert_eq!(grid.cursor_row(), 0);
        // Two newlines advance the cursor to the third row (index 2).
        grid.write(b"line one\r\nline two\r\n> ");
        assert_eq!(grid.cursor_row(), 2);
    }
}
