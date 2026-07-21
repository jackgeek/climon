# Terminal control handoff (shared PTY, one controller)

Verifies climon's control-handoff model: one live PTY is shared between multiple
**surfaces** — the attached local terminal, the browser dashboard, and the
installed PWA. Each surface attaches with a **stable, unique** `viewerId` and a
`kind` (`terminal`, `dashboard`, or `pwa`) and reports its own viewport with
`Resize` frames. The daemon tracks exactly one **controller**; the shared PTY
grid always equals the controller's size (no clamping). Fallback priority (used
only when no manual choice is in effect) is `pwa` (3) > `dashboard` (2) >
`terminal` (1), ties broken by most-recently-connected. The daemon broadcasts a
`Control` frame `{controllerId, cols, rows}` on every change.

**Displacement is decided by controller identity, not size — on every surface,
including the in-process local terminal.** A surface is the controller when the
daemon's broadcast `controllerId` equals its own `viewerId`; **every other
surface is displaced**, regardless of relative size. A displaced surface blanks
behind a centered notice, is fully non-interactive, and (on the local terminal)
swallows every keystroke except take-control. When a surface takes control, the
PTY is resized to it, so a controller always fits. (On Windows the retained
ConPTY overgrown-repaint deferral is only a restore-time rendering safety, not
the displaced trigger.)

- Local terminal (displaced) message: *"This session is being viewed on a climon
  dashboard."* with *"Press Space to take control."* Press **Space** (`0x20`) to
  take control; the terminal repaints immediately and resizes to fit the local
  terminal (it requests a fresh replay on regaining control, so an idle
  screen is never left blank). Space is the take-control key *only while
  displaced* — once the local terminal controls the grid, Space is ordinary
  shell input. (Ctrl+T is avoided because host terminals and browsers commonly
  intercept it, e.g. "new tab" / "go to symbol", so it never reaches climon.)
- Dashboard/PWA (displaced) overlay: *"This session is being viewed
  elsewhere."* with a **Take control** button (browsers cannot reliably capture
  a keyboard chord like Ctrl+T, so the dashboard uses a button, not a key).

**No session-list take-control/maximize button.** Control is taken by *actively
choosing* a session: clicking a session in the desktop session list, or tapping
**Open terminal** in the mobile/PWA view, automatically takes control (an
`armTakeControl` that flushes once the surface is attached). The desktop
**Open terminal** button remains for opening the maximized terminal view.

**Focus reclaims control.** When a dashboard/PWA window regains focus or becomes
visible again (alt-tab, tab switch, unlocking a phone, resuming the PWA), it
automatically takes control of the session it is showing. This is edge-triggered
by the browser `focus`/`visibilitychange` events — it fires only on the
transition and is skipped when the surface already holds control, so it never
fights another surface while the user is away from this window.

**No handoff flash.** The displaced *gating* (a surface stops reporting its size)
updates immediately, but the displaced *overlay* is revealed only after a short
delay (`DISPLACED_OVERLAY_DELAY_MS`). A fast take-control handshake (open, focus,
or button) cancels the pending overlay the moment control is (re)gained, so the
"being viewed elsewhere" dialog never flashes on screen.

> **Platform caveat.** On Windows the daemon's `local_terminal_size()` is a fixed
> `(80, 24)` stub, so terminal-size-dependent *PTY sizing* of the **local**
> terminal cannot be reliably exercised on Windows — verify the local-terminal
> size cases (TCH-2, TCH-4 local hop) on **macOS/Linux**. Identity-based
> displacement, Space take-control, focus reclaim, the no-flash handoff, and the
> browser/PWA cases (TCH-3, TCH-5, TCH-6, TCH-7, TCH-8) work on all platforms.

Source: `rust/climon-session/src/control.rs`, `rust/climon-session/src/fingerprint.rs`,
`rust/climon-session/src/host.rs`, `rust/climon-session/src/replay.rs`,
`rust/climon-cli/src/client.rs`, `rust/climon-proto/src/frame.rs`,
`src/web/control-state.ts`, `src/web/components/TerminalView.tsx`,
`src/web/components/SessionItem.tsx`, `src/web/App.tsx`.

## TCH-1 — Terminal-only: local terminal is controller and interactive

- **Feature:** default controller on attach; no other surface connected
- **Preconditions:** climon built; no dashboard viewing the session.
- **Config-matrix cell:** default config.
- **Steps:**
  1. Start an attached session from a normal interactive console, e.g.
     `climon bash`.
  2. Do not open the session in any dashboard/PWA.
  3. Type commands and interact normally.
- **Expected result:** The local terminal is the controller: the PTY is sized to
  the terminal, output renders normally, and all input reaches the shell. No
  displaced notice ever appears.
- **Platforms:** macOS, Linux (authoritative); Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-2 — Dashboard takes control; Space reclaims, resizes, and repaints

- **Feature:** dashboard auto-take-control → local terminal displaced → Space
  take-control resizes PTY to the terminal and repaints
- **Preconditions:** climon built; a running `climon server` dashboard.
- **Config-matrix cell:** default config; browser cell.
- **Steps:**
  1. Start an attached session from a local console (e.g. `climon bash`).
  2. Open the session in a browser window of a **different** size (larger or
     smaller — displacement is identity-based, so size does not matter).
  3. In the dashboard, click the session in the list (or open its terminal) so
     the browser takes control.
  4. Observe the local terminal.
  5. In the local terminal, leave a static screen (e.g. an idle shell prompt),
     then press **Space**.
- **Expected result:** After step 3 the browser becomes controller; the local
  terminal blanks and shows *"This session is being viewed on a climon
  dashboard."* with the *"Press Space to take control…"* hint, and typing in the
  local terminal does nothing. After step 5 the local terminal takes control, the
  shared PTY resizes to the local terminal size, the local terminal **repaints
  immediately** (never left blank — even for an idle screen), and is interactive
  again (verify a subsequent Space now types a normal space in the shell). The
  dashboard becomes displaced and shows its Take-control overlay.
- **Platforms:** macOS, Linux (local-terminal size behaviour authoritative here;
  see the Windows caveat above). Space reclaim + repaint verifiable on Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-3 — Non-controller dashboard/PWA is displaced with a Take control button

- **Feature:** identity-based displacement overlay + Take control button
- **Preconditions:** dashboard server running; the same session open in two
  surfaces (e.g. a desktop browser and a PWA/phone-sized viewer).
- **Config-matrix cell:** browser cell (Chromium/Firefox/WebKit); mobile viewport.
- **Steps:**
  1. Open the session in surface A and take control (click the session / open its
     terminal).
  2. Open the same session in surface B (any size).
  3. Observe surface B without taking control.
  4. On surface B, click **Take control** in the overlay.
- **Expected result:** In step 3 surface B is **displaced** regardless of its
  size: it blanks behind the centered *"This session is being viewed
  elsewhere."* overlay with a **Take control** button, and it sends no resize
  frames (no fighting/flicker on either surface). In step 4 surface B takes
  control, the shared terminal resizes to B's viewport, and surface A becomes
  displaced.
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-4 — Controller disconnect falls back by priority

- **Feature:** disconnect fallback = highest `kind` priority (`pwa` > `dashboard`
  > `terminal`), ties by most-recently-connected
- **Preconditions:** a session with more than one surface connected.
- **Config-matrix cell:** default config; browser cell.
- **Steps:**
  1. Attach a local terminal (`terminal`) and open the session in a dashboard
     (`dashboard`) and a PWA (`pwa`).
  2. Take control with the **PWA** (open its terminal).
  3. Close/disconnect the PWA.
  4. Observe which surface becomes controller and the resulting sizes.
  5. Now disconnect the dashboard too (leaving only the local terminal).
- **Expected result:** After step 3 the PWA is gone, so control falls back to the
  highest-priority remaining surface — the **dashboard** — and the shared PTY
  resizes to the dashboard's viewport (a new `Control` frame is broadcast); the
  dashboard repaints. After step 5 control falls back to the local **terminal**,
  the PTY resizes to it, and the terminal repaints (never left blank).
- **Platforms:** macOS, Linux (local-terminal hop authoritative); Windows for the
  PWA→dashboard hop.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-5 — Displaced surface is fully non-interactive except Take control

- **Feature:** displaced input gate (all keystrokes swallowed; only take-control
  acts)
- **Preconditions:** a session with one surface displaced by another controller.
- **Config-matrix cell:** default config; browser cell.
- **Steps:**
  1. Make a surface displaced (e.g. a local terminal while a dashboard controls,
     per TCH-2; or a second dashboard that has not taken control, per TCH-3).
  2. On the displaced surface, type ordinary characters, Enter, arrow keys, and
     Ctrl-C (on a displaced local terminal, avoid Space for this step since Space
     is the take-control key while displaced).
  3. Confirm none of that reaches the shell (the running command is unaffected).
  4. Trigger take-control: **Space** on a displaced local terminal, or the
     **Take control** button on a displaced dashboard/PWA.
- **Expected result:** While displaced, every keystroke is swallowed and nothing
  reaches the PTY — the session is fully non-interactive on that surface. Only the
  take-control action works; after it, the surface becomes controller, the PTY
  resizes to it, it repaints, and it becomes interactive.
- **Platforms:** macOS, Linux (local-terminal variant); Windows (dashboard/PWA
  variant).
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-6 — Multiple dashboards each have a unique identity; no fighting

- **Feature:** unique per-surface `viewerId` + identity-based displacement (only
  the named controller drives the grid; every other surface stays inert)
- **Preconditions:** the same session open in two or more separate browser
  tabs/windows ("A", "B", ...) of any sizes, plus (optionally) an attached local
  terminal.
- **Config-matrix cell:** browser cell. Include an **http:// LAN-IP** origin (a
  non-secure context) to exercise the `crypto.randomUUID` fallback.
- **Steps:**
  1. Open dashboards A and B (and optionally a local terminal).
  2. Take control in A (click the session / open its terminal). Confirm A
     controls and B is displaced.
  3. Take control in B. Confirm B controls and A is displaced.
  4. Leave all surfaces idle for ~30s and watch for resize churn.
  5. Repeat over an http:// LAN-IP dashboard origin.
- **Expected result:** Each surface has a distinct identity, so exactly one is the
  controller at a time and the others are displaced and inert. Handing control
  A→B→A resizes cleanly with a single `Control` broadcast per change. **No
  continuous stream of resize events** occurs while idle (no fighting between
  surfaces or between a dashboard and the local terminal). The http:// LAN-IP
  origin behaves identically (the viewer id is generated via the
  `getRandomValues`/time fallback, not `crypto.randomUUID`).
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-7 — Focus reclaims control for the returning dashboard/PWA

- **Feature:** edge-triggered `focus`/`visibilitychange` auto-take-control for
  the currently-shown session (skipped when already the controller)
- **Preconditions:** the same session open in a local terminal (or another
  dashboard) **and** a dashboard/PWA window "B" that is not currently focused.
- **Config-matrix cell:** browser cell; also exercise a phone PWA.
- **Steps:**
  1. Open the session in surface A (local terminal or dashboard) and let it
     control (e.g. press Space in the displaced terminal, or select it in A).
  2. In window B, open the same session but leave B unfocused / in the
     background (switch to another window or tab; on a phone, lock or background
     the PWA). Confirm B is displaced (overlay).
  3. Bring B back to the foreground (alt-tab to it, switch back to its tab,
     unlock the phone / resume the PWA).
  4. Without clicking anything else in B, observe control.
  5. Repeat bringing B to the foreground several times while it already controls.
- **Expected result:** In step 3 B automatically takes control the moment it
  regains focus/visibility — its overlay clears, the shared PTY resizes to B, and
  B becomes interactive — **without** any extra click. In step 5, because B is
  already the controller, refocusing it does nothing (no redundant resize churn,
  no flicker). While B was unfocused (step 2) it never stole control from A.
- **Platforms:** macOS, Linux, Windows; phone PWA.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-8 — No handoff flash when taking control

- **Feature:** deferred displaced overlay (`DISPLACED_OVERLAY_DELAY_MS`) cancelled
  on control (re)gain
- **Preconditions:** dashboard server running; a session controlled by another
  surface so opening it here first arrives as displaced.
- **Config-matrix cell:** browser cell; mobile viewport.
- **Steps:**
  1. Have surface A control the session.
  2. In surface B, open/select the same session (which auto-takes control) — or
     bring B to focus per TCH-7 — and watch the terminal area closely.
  3. Repeat several times, including on a slower device / throttled CPU.
- **Expected result:** B transitions straight from its previous view to the live
  terminal at B's size. The *"This session is being viewed elsewhere."* overlay
  does **not** flash on screen during the take-control
  handshake (the overlay is deferred and cancelled the instant B gains control).
  If B genuinely stays displaced (e.g. another surface immediately grabs control),
  the overlay still appears after the short delay.
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-9 — Controlling PWA does not resize-storm or corrupt

- **Feature:** the controller only re-fits on the displaced→controlling
  transition (`shouldRefitOnControlFrame`) and dedupes identical resize reports
  (`shouldSendResize`), so it never re-fits in response to the grid changes it
  itself caused — the fix for the mobile-PWA resize feedback loop
- **Preconditions:** dashboard server running; a session controlled by the PWA
  while the local terminal and any desktop dashboard sit displaced (showing their
  notice / Take control button).
- **Config-matrix cell:** mobile PWA cell (also verify a desktop browser).
- **Steps:**
  1. Start `climon bash` locally, then open the session in the phone PWA and let
     the PWA take control (the local terminal shows its displaced notice).
  2. Optionally also open the session in a desktop browser and confirm it sits
     displaced with a **Take control** button (do not touch it).
  3. With the PWA as sole controller, leave it idle for ~30s, then interact:
     scroll, show/hide the on-screen keyboard, rotate the device.
  4. Watch for repeated resizing / screen corruption on both the PWA and the
     desktop dashboard.
- **Expected result:** The PWA renders the terminal at its own size and stays
  stable. There is **no** continuous stream of resizes and **no** screen
  corruption while idle. Genuine viewport changes (keyboard, rotation) produce at
  most one resize each and then settle; identical re-fits are suppressed. The
  desktop dashboard and local terminal remain quietly displaced throughout (they
  do not flicker or fight the PWA).
- **Platforms:** phone PWA (authoritative); desktop browser.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-10 — Reclaim preserves scrollback history, colors, and right-edge cells

- **Feature:** clean restore on reclaim. The displaced notice and the take-control
  repaint clear only the visible viewport (never `\e[2J`) and reset SGR before every
  erase, so reclaiming preserves scrollback above the viewport and leaves no color
  bleed (`render_local_displaced` + `HeadlessGrid::render_screen`). The reclaim
  repaint itself is **not** taken from the controller-sized idle grid — that grid
  may have been narrowed by a smaller dashboard controller, and resizing a
  `vt100::Screen` narrower permanently discards the cells beyond the new right
  edge, so simply widening it back later cannot recover them. Instead the local
  restore watcher rebuilds a **fresh grid at the local terminal's own host
  dimensions** from the bounded raw PTY replay buffer and renders that
  (`render_screen_from_replay` in `rust/climon-session/src/fingerprint.rs`), so a
  narrower dashboard controller can never permanently clip content the local
  terminal is wide enough to show.
- **Preconditions:** climon rebuilt from this branch and a **new** session started
  (the daemon runs the binary it was launched from); a running `climon server`
  dashboard.
- **Config-matrix cell:** default config; browser cell. Verify on Windows Terminal
  (primary) and spot-check conhost.
- **Steps:**
  1. Start an attached session (e.g. `climon bash`) and run a command that emits
     colored output and scrolls well past one screen, e.g.
     `for i in $(seq 1 200); do printf '\e[44mline %s\e[0m\n' "$i"; done`
     (PowerShell: `1..200 | % { Write-Host $_ -ForegroundColor Blue }`).
  2. Scroll back in the local terminal and confirm the earlier lines are visible.
  3. In a terminal at least 80 columns wide, print a static wide line with a
     right-edge marker, e.g.
     `printf 'left side%*sRIGHT_EDGE\n' 60 ""` (pad so `RIGHT_EDGE` lands near
     column 70–80), and confirm it is fully visible, unclipped, in the local
     terminal.
  4. Open the session in a browser and resize that browser window/dashboard pane
     **narrower** than the local terminal (e.g. under 60 columns), then take
     control from the dashboard so the local terminal is displaced (shows the
     *"being viewed on a climon dashboard"* notice; output pauses).
  5. In the local terminal, press **Space** to reclaim control.
- **Expected result:** After ~250 ms the local terminal returns to the session's
  current state at its own (wider) size. Scrollback above the viewport is
  intact — scrolling up still shows the pre-displace lines. No background/
  foreground color bleeds into the erased rows or the shell prompt. The prompt is
  left on the last content row. The wide line's right-hand `RIGHT_EDGE` marker is
  still fully visible after reclaim — it must **not** be clipped or blank just
  because the dashboard controller that briefly held control was narrower than
  the local terminal.
- **Platforms:** macOS, Linux, Windows (Windows Terminal authoritative for the
  scrollback/`\e[2J` semantics; also spot-check conhost).
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-11 — Desktop dashboard does not resize-spiral when it takes control

- **Feature:** focusing the terminal repaints stale glyphs but never refits, so
  xterm's focus churn (it re-focuses its helper textarea whenever the grid is
  refreshed/resized) cannot re-fire `focusin` → `refit` → resize in an unbounded
  loop. The focus/`onFocusCapture` path calls `repaintActiveTerminal` (repaint
  only); the refresh+refit helper is reserved for the post-replay settle.
  Regression fix for the desktop control-handoff resize spiral (~40 ms cadence,
  columns drifting).
- **Preconditions:** dashboard server running (restart it after building so the
  in-memory `app.js` is rebuilt from source); a running local `climon bash`.
- **Config-matrix cell:** default config; desktop browser cell (single tab).
- **Steps:**
  1. Start an attached session (`climon bash`) from a desktop console.
  2. Open the dashboard in **one** desktop browser tab (close any other dashboard
     tabs/PWAs so no stale viewer surfaces fight for control).
  3. Open DevTools → Network/Console, then click the session in the sidebar so the
     dashboard takes control (the local terminal shows its displaced notice).
  4. Leave the terminal idle and focused for ~30 s; then click into the terminal
     and type. Watch the terminal width and the `resize` WebSocket frames.
- **Expected result:** On taking control the dashboard sizes the terminal once to
  its viewport and then **settles**. There is **no** stream of `resize` frames at
  a ~40 ms cadence, **no** monotonic column shrink, and the terminal does **not**
  overflow off the right edge. Focusing/clicking the terminal repaints it (no
  stale glyphs) without emitting a resize. The local terminal stays quietly
  displaced (no fighting).
- **Platforms:** macOS, Linux, Windows (desktop browsers).
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-12 — Reclaim synchronizes mouse tracking; teardown while displaced cannot poison the local terminal

- **Feature:** mouse tracking is state in the physical terminal emulator, not in
  climon. While local output is suppressed, a program (e.g. Copilot) can disable
  or change mouse-tracking private modes (`1000`, `1002`, `1003`, `1005`, `1006`,
  `1015`) only on the dashboards that are actually receiving output; the
  physical local terminal misses those controls and can be left in a stale
  enabled mode. `build_mouse_private_mode_restore_suffix()`
  (`rust/climon-session/src/replay.rs`) fixes reclaim by first **clearing every
  tracked mode**, then **re-enabling only the modes currently active** in
  authoritative daemon state, prefixed onto the local restore repaint. Session
  teardown runs the same clear (with no re-enables) once the PTY reader drains,
  so exiting the session while a dashboard is in control also cannot leave the
  physical local terminal stuck reporting mouse events.
- **Preconditions:** climon rebuilt from this branch and a **new** session
  started (the daemon runs the binary it was launched from); a running
  `climon server` dashboard; a program that enables mouse tracking (e.g.
  Copilot, or any full-screen TUI/mouse-reporting app) available in the shell.
- **Config-matrix cell:** default config; two-dashboard browser cell.
- **Steps (reclaim path):**
  1. Start an attached session (e.g. `climon bash`).
  2. Run the mouse-tracking program (e.g. start Copilot) so it enables mouse
     reporting in the shared PTY.
  3. Open the session in two separate dashboard browser tabs/windows
     (dashboard1 and dashboard2).
  4. Take control from dashboard1, then take control from dashboard2 (control
     now moves dashboard1 → dashboard2 while the local terminal stays
     displaced throughout).
  5. While dashboard2 controls, exit the mouse-tracking program (e.g. quit
     Copilot) so the shell returns to a normal prompt.
  6. In the local terminal, press **Space** to reclaim control.
  7. Move the mouse over the local terminal and try an ordinary click-drag
     text selection.
- **Expected result:** After reclaim there is **no** visible mouse-report
  garbage (no stray escape-looking text) printed as you move the mouse, and
  ordinary click-drag text selection in the local terminal works normally, as
  if mouse tracking had never been enabled remotely.
- **Steps (exit-while-displaced path):**
  1. Repeat steps 1–4 above (mouse tracking enabled, control handed
     dashboard1 → dashboard2, local terminal displaced).
  2. While dashboard2 (or any dashboard) still controls the session, terminate
     the climon session itself (e.g. exit the shell or kill the `climon`
     process) instead of exiting only the mouse-tracking program.
  3. Move the mouse over the now-idle local terminal and try an ordinary
     click-drag text selection.
- **Expected result:** After climon exits, the local terminal is back to a
  normal terminal mode: no mouse-report garbage appears when moving the mouse,
  and ordinary click-drag text selection works. The terminal must **not**
  require a manual `reset` or restart to recover.
- **Platforms:** macOS, Linux, Windows (Windows Terminal authoritative; also
  spot-check conhost since ConPTY mediates mouse-mode escapes differently).
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-13 — Exit while displaced restores the local terminal's final screen

- **Feature:** when the monitored command exits while a dashboard/PWA controls
  the grid, the in-process local terminal is displaced and stranded on the
  *"Press Space to take control."* notice. The restore watcher has already
  stopped (it breaks on `s.exited`), so the daemon's teardown now gives control
  back to the local terminal and repaints the command's **final screen** from the
  scrollback snapshot before broadcasting `Exit` and shutting down
  (`local_exit_restore_bytes` in `rust/climon-session/src/host.rs`). The user is
  left looking at the last output/scrollback, not the take-control notice.
- **Preconditions:** climon rebuilt from this branch and a **new** session
  started (the daemon runs the binary it was launched from); a running
  `climon server` dashboard.
- **Config-matrix cell:** default config; single-dashboard browser cell.
- **Steps:**
  1. Start an attached session (e.g. `climon bash`).
  2. Run a command that leaves recognizable output on screen (e.g.
     `ls -la` or `echo FINAL-SCREEN-MARKER`).
  3. Open the session in a dashboard browser tab and take control from it, so
     the local terminal becomes displaced and shows *"This session is being
     viewed on a climon dashboard. Press Space to take control."*
  4. While the dashboard still controls, terminate the session from the
     dashboard-controlled surface or type `exit` (via the dashboard) so the
     shell/command exits.
- **Expected result:** As climon exits, the local terminal is repainted with the
  command's final screen/scrollback (e.g. the `ls -la` output or the
  `FINAL-SCREEN-MARKER` line) — **not** left showing the *"Press Space to take
  control."* notice. No manual `reset`/refresh is needed to see the last screen.
- **Platforms:** macOS, Linux (verify local-terminal sizing here per the Windows
  caveat above); spot-check Windows Terminal.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-14 — Windows browser handoff survives erase-only ConPTY resize repaint

- **Feature:** a displaced dashboard/PWA serializes its full xterm state before
  taking control. If Windows ConPTY's resize response leaves the browser blank,
  the matching attachment-generation checkpoint restores the visible screen,
  scrollback, styling, cursor, and modes at the existing replay boundary.
- **Preconditions:** Windows actor candidate built from this branch; dashboard
  server restarted from the same source; one live PowerShell session; desktop
  dashboard and installed PWA both open on that session.
- **Config-matrix cell:** Windows Terminal + actor + desktop dashboard + PWA.
- **Steps:**
  1. In the managed PowerShell, produce more than one screen of colored output,
     then leave a recognizable prompt/marker visible.
  2. Take control in the desktop dashboard and scroll upward to confirm history.
  3. Take control in the PWA without typing any command after the transfer.
  4. Confirm the PWA immediately shows the prior screen; scroll upward.
  5. Take control back in the dashboard, again without producing fresh child
     output; confirm its screen and history immediately return.
  6. Type in the newest controller and confirm the displaced surface cannot type.
  7. Press Space in the local terminal to reclaim control.
- **Expected result:** every dashboard↔PWA transfer shows the prior terminal
  immediately, including full scrollback and colors, without waiting for fresh
  PowerShell output. Only the newest controller accepts input. Local Space
  reclaim restores local-size authority.
- **Platforms:** Windows Terminal + ConPTY (authoritative).
- **Result:** _(version / date / tester / pass|fail / notes)_
