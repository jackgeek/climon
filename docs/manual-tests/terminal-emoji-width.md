# Terminal emoji / wide-character width fidelity

Manual checks for the dashboard terminal rendering emoji and other wide
(two-cell) characters at the correct width. The browser terminal loads the
xterm.js Unicode 11 addon plus a small custom Unicode provider that promotes
emoji-presentation (VS16) sequences and joins skin-tone modifiers, so those
grapheme clusters advance the cursor by two cells — matching what the PTY
application drew. Without it, xterm's default Unicode v6 widths count many emoji
as one cell, the cursor desyncs from the glyph, and following text
overwrites/"eats" spaces and leaves ghost glyphs.

Covered: plain wide emoji (`😀`), VS16 on a narrow base (`❤️ ⚠️ ▶️`), keycaps
(`1️⃣`), and skin-tone emoji (`👍🏽`). Not covered (intentionally): ZWJ sequences
such as families/professions (`👨‍👩‍👧‍👦`, `👩‍💻`) — those stay per-codepoint and
may still misalign.

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

## TEW-3 — VS16, keycap and skin-tone emoji occupy two cells

- **Feature:** Terminal emoji / wide-character width fidelity
- **Preconditions:** As TEW-1.
- **Config-matrix cell:** Browser = desktop Chrome/Firefox/Safari.
- **Steps:**
  1. Print markers around the tricky grapheme clusters so misalignment is
     obvious, e.g.:

     ```sh
     printf 'A \xe2\x9d\xa4\xef\xb8\x8f B \xe2\x9a\xa0\xef\xb8\x8f C \xe2\x96\xb6\xef\xb8\x8f D\n'   # VS16: ❤️ ⚠️ ▶️
     printf 'A 1\xef\xb8\x8f\xe2\x83\xa3 B \xf0\x9f\x91\x8d\xf0\x9f\x8f\xbd C\n'                     # keycap 1️⃣ and skin-tone 👍🏽
     ```
  2. Observe the rendered lines.
- **Expected result:** Each of `❤️ ⚠️ ▶️ 1️⃣ 👍🏽` occupies two cells; the markers
  (`B C D`) stay evenly spaced with no swallowed space or ghost glyph.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_
