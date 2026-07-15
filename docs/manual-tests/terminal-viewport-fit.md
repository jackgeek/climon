# Terminal viewport fit

Manual checks that the dashboard terminal fits its pane instead of staying locked
at the daemon's host grid. Regression coverage for the `@xterm/addon-fit` /
`@xterm/xterm` version mismatch, where `FitAddon.proposeDimensions()` threw on the
removed `_core.viewport` internal and `fit()` became a silent no-op.

## TVF-1 — Terminal grows to fill a taller pane

- **Feature:** Terminal viewport fit
- **Preconditions:** Dashboard open in a desktop browser. A live session whose
  host grid is short (e.g. an 80×24 host), selected and attached.
- **Config-matrix cell:** Browser = desktop; viewport taller than the host grid.
- **Steps:**
  1. Select the live session and open its terminal.
  2. Enlarge the browser window (or maximize the terminal) so the terminal pane
     is clearly taller than 24 rows.
- **Expected result:** The terminal re-fits and shows more rows than the host
  grid (fills the pane); it does not stay stuck at the original 24 rows. No raw
  escape text (e.g. `[NN;NNh`) is rendered at the top of the screen.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## TVF-2 — Tall host grid does not overflow the viewport

- **Feature:** Terminal viewport fit
- **Preconditions:** Dashboard open in a desktop browser. A live session whose
  host grid is tall (e.g. a 186×52 host terminal), selected and attached.
- **Config-matrix cell:** Browser = desktop; browser viewport shorter than the
  host grid.
- **Steps:**
  1. Select the tall-host session and open its terminal.
  2. Shrink the browser window so it is shorter than the host grid would need.
  3. Observe the terminal against the page/viewport bounds.
- **Expected result:** The terminal re-fits to the shorter pane (fewer rows) and
  stays within the browser viewport — it does not overflow past the bottom of the
  page. The daemon PTY resizes to match the fitted size (default Fill mode).
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_
