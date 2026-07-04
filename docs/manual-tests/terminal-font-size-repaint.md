# Terminal font-size repaint

Manual checks for repainting the dashboard terminal viewport when the font size
changes. Increasing (or decreasing) the font reflows the xterm grid to a new
cell size; the viewport must repaint cleanly as soon as the size changes rather
than staying corrupted until the terminal is focused.

## TFSR-1 — Increasing the font size does not corrupt the viewport

- **Feature:** Terminal font-size repaint
- **Preconditions:** Dashboard open with a live session selected and attached, so
  the terminal shows scrollback content (run e.g. `ls -la` a few times to fill
  the viewport). The terminal pane is **not** focused (click elsewhere first).
- **Config-matrix cell:** Browser = desktop Chrome/Firefox/Safari.
- **Steps:**
  1. Without focusing the terminal, increase the font size using the terminal
     bar font-size control (or `Ctrl` `+`).
  2. Observe the terminal viewport immediately after the size changes, before
     clicking into the terminal.
- **Expected result:** The viewport reflows to the larger cell size and repaints
  cleanly right away — no stale/overlapping glyphs, garbled rows, or leftover
  artifacts. Focusing the terminal afterwards does not change what is shown (it
  was already correct).
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFSR-2 — Decreasing the font size repaints cleanly

- **Feature:** Terminal font-size repaint
- **Preconditions:** As TFSR-1, with the font already enlarged so there is room
  to shrink it.
- **Config-matrix cell:** Browser = desktop Chrome/Firefox/Safari.
- **Steps:**
  1. Without focusing the terminal, decrease the font size using the terminal
     bar control (or `Ctrl` `-`).
  2. Observe the viewport immediately after the size changes.
- **Expected result:** The grid reflows to the smaller cell size and the whole
  viewport repaints cleanly with no residual glyphs from the previous size.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_
