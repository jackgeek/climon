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
}
