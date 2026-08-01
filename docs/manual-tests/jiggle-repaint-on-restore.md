# Restore repaint and same-size jiggle

Verifies that when the local terminal reclaims control from a larger browser,
climon returns the shared PTY to the local grid and the wrapped command repaints
its authoritative screen (in addition to climon's shadow-grid repaint). When a
dashboard/PWA takes control at the same PTY size, climon still jiggles the PTY
size — one column narrower and one row away, then back — so frame-caching TUIs
such as `copilot` (Ink) redraw instead of reusing a stale frame.

Source: `rust/climon-session/src/host.rs` (`LocalRestoreDecision::Repaint` arm,
`jiggle_rows`).

## MT-JIGGLE-01 — Full-screen app redraws its true state on restore

**Feature:** Restore repaint on local reclaim
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
- The local terminal is restored to its own grid: first the clean shadow
  repaint appears, then the app's own redraw lands on top within a moment
  (e.g. htop's live rows / vim's buffer are fully and correctly painted, with
  no stale/blank regions and correct colors). A direct resize back to the local
  grid is sufficient; a separate jiggle is not required on this larger-browser
  reclaim path.

**Platforms:** macOS, Linux, Windows.

| Version | Platform | Date | Tester | Result | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## MT-JIGGLE-02 — Frame-caching TUI (copilot) redraws on reclaim

**Feature:** Restore repaint on local reclaim
**Config-matrix cell:** default config; local terminal + one browser viewer.

**Preconditions:**
- A freshly built/installed `climon` client (the jiggle only applies to sessions
  launched from the new binary).
- The dashboard server running and reachable in a browser.

**Steps:**
1. Launch `climon run -- copilot` (any Ink-based full-screen TUI works).
2. Open the session in a browser viewer, take control from the dashboard, and
   resize the browser terminal **larger** than the local terminal so the local
   terminal is displaced.
3. In the local terminal, press **Space** to reclaim control.

**Expected result:**
- `copilot` fully repaints its true current state on reclaim (no stale or
  half-painted screen) once the PTY returns to the local grid. A separate
  jiggle is not required on this larger-browser reclaim path.

**Platforms:** macOS, Linux, Windows.

| Version | Platform | Date | Tester | Result | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## MT-JIGGLE-03 — Dashboard takes control at the same size

**Feature:** Jiggle on non-local same-size take-control
**Config-matrix cell:** default config; local terminal + one browser viewer at the same grid size.

**Preconditions:**
- A freshly built/installed `climon` client.
- The dashboard server running and reachable in a browser.

**Steps:**
1. Launch `climon run -- copilot` (or another frame-caching TUI).
2. Open the session in a browser viewer sized so its grid matches the current
   PTY size (no resize on connect).
3. Take control from the dashboard **without** resizing the browser terminal.

**Expected result:**
- `copilot` repaints its authoritative state in the dashboard viewer even though
  the grid size did not change (the same-size take-control triggers the jiggle).

**Platforms:** macOS, Linux, Windows.

| Version | Platform | Date | Tester | Result | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
