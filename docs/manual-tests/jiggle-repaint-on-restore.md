# Jiggle-repaint on local restore

Verifies that when the local terminal regains control after being displaced by a
larger browser/PWA surface, climon jiggles the PTY size so the wrapped command
repaints its authoritative screen (in addition to climon's shadow-grid repaint).

Source: `rust/climon-session/src/host.rs` (`LocalRestoreDecision::Repaint` arm,
`jiggle_rows`).

## MT-JIGGLE-01 — Full-screen app redraws its true state on restore

**Feature:** Jiggle-repaint on local restore
**Config-matrix cell:** default config; local terminal + one browser viewer.

**Preconditions:**
- A freshly built/installed `climon` client (jiggle behavior only takes effect
  for sessions launched from the new binary — each session's daemon runs the
  binary it was launched from).
- The dashboard server running and reachable in a browser.

**Steps:**
1. Launch a session running a full-screen TUI, e.g. `climon run -- htop`
   (or `top`, `vim`, `less` on a long file).
2. Open the session in a browser viewer and take control from the dashboard,
   then resize the browser terminal **larger** than the local terminal so the
   local terminal is displaced (it shows the "Press Space to take control."
   notice).
3. In the local terminal, press **Space** to reclaim control (or shrink the
   browser viewer back to the local size and disconnect it).

**Expected result:**
- The local terminal is restored: first the clean shadow repaint appears, then
  the app's own redraw lands on top within a moment (e.g. htop's live rows /
  vim's buffer are fully and correctly painted, with no stale/blank regions and
  correct colors). There is at most a brief one-row flicker during the jiggle.

**Platforms:** macOS, Linux, Windows.

| Version | Platform | Date | Tester | Result | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
