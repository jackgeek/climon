# Terminal fade-in on (re)attach

Verifies that the browser xterm starts invisible over the active theme's
background and fades in only after an attach's replay/reflow **and the daemon's
take-control jiggle** have settled (a short reveal delay), so the visible
jiggle/reflow (introduced with the PR #122 repaint work) is masked instead of
shown to the viewer.

Source: `src/web/components/TerminalView.tsx` (`contentVisible` state, the
`styles.hidden` class, `scheduleContentReveal` / `CONTENT_REVEAL_SETTLE_MS`,
and the `& .xterm { opacity/transition }` rules).

## MT-FADE-01 — Fade-in on session switch masks the reflow

**Feature:** Terminal fade-in on (re)attach
**Config-matrix cell:** default config; dark terminal theme.

**Preconditions:**
- The dashboard server running and reachable in a browser.
- At least two live sessions producing full-screen output (e.g. `htop`, `vim`).

**Steps:**
1. Open the dashboard with a dark terminal theme selected.
2. Select session A, wait for it to render.
3. Switch to session B, then back to A a few times.

**Expected result:**
- On each switch the terminal area first shows the solid theme background
  (no flash of an unsettled/resizing grid), then — after a brief settle that
  lets the reflow/jiggle finish — the terminal content fades in smoothly over
  ~220ms. The reflow/jiggle is never visible: content only appears once it is
  already in its final, settled position.

**Platforms:** Desktop browser, mobile browser, installed PWA.

| Version | Platform | Date | Tester | Result | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## MT-FADE-02 — Mask colour matches the theme (light + dark)

**Feature:** Terminal fade-in on (re)attach (theme-background mask)
**Config-matrix cell:** default config; toggled between a light and a dark theme.

**Preconditions:**
- The dashboard server running and reachable in a browser.
- One live session.

**Steps:**
1. Select a **dark** theme; select the session and watch the attach.
2. Select a **light** theme; re-select the session and watch the attach.

**Expected result:**
- During the pre-fade (hidden) phase the terminal area shows the active theme's
  own background colour — effectively black-ish for a dark theme and white-ish
  for a light theme — with no white flash on a dark theme or black flash on a
  light theme. Content fades in over that background.

**Platforms:** Desktop browser, mobile browser, installed PWA.

| Version | Platform | Date | Tester | Result | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## MT-FADE-03 — Reconnect and tab re-show fade in, and never stick hidden

**Feature:** Terminal fade-in on reconnect / visibility change
**Config-matrix cell:** default config; single live session.

**Preconditions:**
- The dashboard server running and reachable in a browser.
- One live session open in the terminal.

**Steps:**
1. Switch to another browser tab/app for a few seconds, then return to the
   dashboard tab.
2. Restart the dashboard server (or briefly drop connectivity) to force a
   reconnect, then let it reconnect.

**Expected result:**
- Returning to the tab and completing a reconnect each show the theme
  background briefly then fade the content in. The terminal never remains stuck
  invisible (blank theme background) after a disconnect — if a reconnect fails
  the last content is revealed while the reconnect overlay covers interaction.

**Platforms:** Desktop browser, mobile browser, installed PWA.

| Version | Platform | Date | Tester | Result | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
