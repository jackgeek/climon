# Terminal emoji / wide-character width fidelity

Manual checks for the dashboard terminal rendering emoji and other wide
(two-cell) characters at the correct width. The browser terminal loads the
xterm.js Unicode 11 addon and activates version `11`, so wide emoji advance the
cursor by two cells — matching what the PTY application drew. Without it, xterm's
default Unicode v6 widths count many emoji as one cell, the cursor desyncs from
the glyph, and following text overwrites/"eats" spaces and leaves ghost glyphs.

## TEW-1 — Wide emoji keep their spacing (no eaten spaces)

- **Feature:** Terminal emoji / wide-character width fidelity
- **Preconditions:** Dashboard open with a live session selected and attached.
- **Config-matrix cell:** Browser = desktop Chrome/Firefox/Safari.
- **Steps:**
  1. In the attached session's shell, print alternating markers and wide emoji so
     misalignment is obvious, e.g.:

     ```sh
     printf 'A \xf0\x9f\x98\x80 B \xf0\x9f\x98\x81 C \xf0\x9f\x98\x82 D \xf0\x9f\xa4\xa3 E\n'
     printf 'star \xe2\xad\x90\xef\xb8\x8f check \xe2\x9c\x85 rocket \xf0\x9f\x9a\x80 fire \xf0\x9f\x94\xa5\n'
     ```
  2. Observe the rendered line in the dashboard terminal.
- **Expected result:** Each emoji occupies two cells; the trailing markers
  (`B C D E`) stay evenly spaced and no space is swallowed. No ghost/overlapping
  glyphs appear, and the line matches what the same command shows in a
  correctly-configured native terminal.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## TEW-2 — A screen full of emoji does not corrupt neighbouring rows

- **Feature:** Terminal emoji / wide-character width fidelity
- **Preconditions:** As TEW-1.
- **Config-matrix cell:** Browser = desktop Chrome/Firefox/Safari.
- **Steps:**
  1. Print several dense back-to-back emoji rows, e.g.
     `printf '\xf0\x9f\x98\x80%.0s' {1..12}; echo` repeated a few times.
  2. Scroll the output and observe adjacent rows.
- **Expected result:** Rows stay independent — no glyphs from one row bleed into
  the row above or below, and clearing/redrawing (scrolling) leaves no residual
  cells.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_
