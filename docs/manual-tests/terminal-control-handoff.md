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
  dashboard."* with *"Press Ctrl+T to take control and resize it to this
  terminal."* Press **Ctrl+T** (`0x14`) to take control; the terminal repaints
  immediately (it requests a fresh replay on regaining control, so an idle
  screen is never left blank).
- Dashboard/PWA (displaced) overlay: *"This session is being viewed on another
  dashboard."* with a **Take control** button.

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
"being viewed on another dashboard" dialog never flashes on screen.

> **Platform caveat.** On Windows the daemon's `local_terminal_size()` is a fixed
> `(80, 24)` stub, so terminal-size-dependent *PTY sizing* of the **local**
> terminal cannot be reliably exercised on Windows — verify the local-terminal
> size cases (TCH-2, TCH-4 local hop) on **macOS/Linux**. Identity-based
> displacement, Ctrl+T take-control, focus reclaim, the no-flash handoff, and the
> browser/PWA cases (TCH-3, TCH-5, TCH-6, TCH-7, TCH-8) work on all platforms.

Source: `rust/climon-session/src/control.rs`, `rust/climon-session/src/host.rs`,
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

## TCH-2 — Dashboard takes control; Ctrl+T reclaims, resizes, and repaints

- **Feature:** dashboard auto-take-control → local terminal displaced → Ctrl+T
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
     then press **Ctrl+T**.
- **Expected result:** After step 3 the browser becomes controller; the local
  terminal blanks and shows *"This session is being viewed on a climon
  dashboard."* with the *"Press Ctrl+T to take control…"* hint, and typing in the
  local terminal does nothing. After step 5 the local terminal takes control, the
  shared PTY resizes to the local terminal size, the local terminal **repaints
  immediately** (never left blank — even for an idle screen), and is interactive
  again. The dashboard becomes displaced and shows its Take-control overlay.
- **Platforms:** macOS, Linux (local-terminal size behaviour authoritative here;
  see the Windows caveat above). Ctrl+T reclaim + repaint verifiable on Windows.
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
  size: it blanks behind the centered *"This session is being viewed on another
  dashboard."* overlay with a **Take control** button, and it sends no resize
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
     Ctrl-C.
  3. Confirm none of that reaches the shell (the running command is unaffected).
  4. Trigger take-control: **Ctrl+T** on a displaced local terminal, or the
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
     control (e.g. press Ctrl+T in the terminal, or select it in A).
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
  terminal at B's size. The *"This session is being viewed on another
  dashboard."* overlay does **not** flash on screen during the take-control
  handshake (the overlay is deferred and cancelled the instant B gains control).
  If B genuinely stays displaced (e.g. another surface immediately grabs control),
  the overlay still appears after the short delay.
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_
