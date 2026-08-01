# Two-finger terminal wheel gesture

Manual checks for the dashboard terminal's touch-primary two-finger wheel
gesture: normal scrollback, mouse-aware TUIs, inversion, momentum, and the
menu/CLI preference that flips it.

Common preconditions: one live session with enough output to scroll, and a
touch-primary browser/device (`(pointer: coarse) and (hover: none)`) unless a
case says otherwise. For cases that mention a physical wheel, use a touch device
with an attached mouse/trackpad or equivalent wheel input.

## TFW-1 — Normal scrollback follows the natural direction

- **Feature:** Two-finger terminal wheel gesture — plain scrollback
- **Preconditions:** Live session with scrollback; terminal is not in a
  mouse-aware TUI.
- **Config-matrix cell:** Touch-primary browser; default inversion off.
- **Steps:**
  1. Open the session terminal and place it near the bottom of the scrollback.
  2. Perform a two-finger vertical swipe down.
  3. Perform a two-finger vertical swipe up.
- **Expected result:** Step 2 moves the terminal toward older output; step 3
  moves it back toward newer output. The browser does not page the dashboard
  instead.
- **Platforms:** iPadOS Safari, Android Chrome, touch-capable desktop browser in
  tablet/touch mode.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-2 — Mouse-aware TUI receives wheel input instead of outer scrollback

- **Feature:** Two-finger terminal wheel gesture — mouse-aware apps
- **Preconditions:** Live session running a mouse-aware TUI (for example `vim`
  with `:set mouse=a`, or another app that visibly reacts to wheel events).
- **Config-matrix cell:** Touch-primary browser; TUI mouse mode enabled.
- **Steps:**
  1. Open the mouse-aware TUI in the dashboard terminal.
  2. Perform a two-finger vertical swipe down and then up.
- **Expected result:** The TUI consumes the wheel gesture and changes its own
  view/state; climon's outer scrollback does not move instead.
- **Platforms:** iPadOS Safari, Android Chrome, touch-capable desktop browser in
  tablet/touch mode.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-3 — One-finger swipe stays native

- **Feature:** Two-finger terminal wheel gesture — non-participant gestures
- **Preconditions:** Live session visible in the dashboard terminal.
- **Config-matrix cell:** Touch-primary browser.
- **Steps:**
  1. Put one finger on the terminal area.
  2. Swipe vertically with one finger.
  3. Compare the terminal to the same screen before the swipe.
- **Expected result:** The one-finger swipe does not trigger the synthetic
  terminal wheel gesture. The terminal content does not move; whatever native
  one-finger behaviour the browser already had remains unchanged.
- **Platforms:** iPadOS Safari, Android Chrome, touch-capable desktop browser in
  tablet/touch mode.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-4 — Horizontal, diagonal, pinch, one-finger, and three-finger gestures are rejected

- **Feature:** Two-finger terminal wheel gesture — gesture filtering
- **Preconditions:** Live session with visible scrollback and a clear marker so
  movement is easy to spot.
- **Config-matrix cell:** Touch-primary browser.
- **Steps:**
  1. Perform a horizontal two-finger swipe.
  2. Perform a diagonal two-finger swipe.
  3. Perform a pinch gesture.
  4. Perform a one-finger swipe.
  5. Perform a three-finger swipe.
- **Expected result:** None of those gestures is accepted as terminal wheel
  input. The terminal stays on the same scroll position, and the dashboard does
  not treat them as the two-finger wheel gesture.
- **Platforms:** iPadOS Safari, Android Chrome, touch-capable desktop browser in
  tablet/touch mode.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-5 — Momentum decays after release and a new touch stops it

- **Feature:** Two-finger terminal wheel gesture — momentum
- **Preconditions:** Live session with plenty of scrollback.
- **Config-matrix cell:** Touch-primary browser; default inversion off.
- **Steps:**
  1. Perform a quick two-finger flick so the terminal starts moving with
     momentum.
  2. Release both fingers and watch the continued scrolling.
  3. While the momentum is still moving, put two fingers back down and start a
     fresh gesture.
- **Expected result:** After release, scrolling continues briefly and slows down
  naturally. A new touch sequence stops the old momentum immediately; the view
  continues from the current position without a jump.
- **Platforms:** iPadOS Safari, Android Chrome, touch-capable desktop browser in
  tablet/touch mode.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-6 — Inversion changes only the synthetic touch gesture

- **Feature:** Two-finger terminal wheel gesture — inversion preference
- **Preconditions:** Live session with scrollback; a physical mouse or
  trackpad/wheel is available on the same device.
- **Config-matrix cell:** Touch-primary browser; `dashboard.touchWheelInverted`
  toggled on.
- **Steps:**
  1. Set **Invert two-finger scrolling** on (or run `climon config
     dashboard.touchWheelInverted true`).
  2. Perform a two-finger vertical swipe down and up.
  3. Use the physical mouse/trackpad wheel down and up.
  4. Set inversion back off and repeat step 2.
- **Expected result:** The two-finger gesture reverses only while the setting is
  on. The physical mouse/trackpad wheel direction does not change.
- **Platforms:** iPadOS Safari, Android Chrome, touch-capable desktop browser in
  tablet/touch mode with a physical wheel available.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-7 — Inversion persists across reloads and devices

- **Feature:** Two-finger terminal wheel gesture — shared preference storage
- **Preconditions:** Two browsers/devices on the same climon dashboard/config.
- **Config-matrix cell:** Touch-primary browser A + browser/device B.
- **Steps:**
  1. In browser/device A, enable **Invert two-finger scrolling** (or set
     `dashboard.touchWheelInverted` with the CLI).
  2. Reload browser/device A.
  3. Load or reload the dashboard in browser/device B.
  4. Inspect `$CLIMON_HOME/config.jsonc`.
- **Expected result:** The setting survives reload, is shared by the other
  browser/device, and is written as `dashboard.touchWheelInverted` in
  `config.jsonc`.
- **Platforms:** iPadOS Safari, Android Chrome, touch-capable desktop browser in
  tablet/touch mode.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-8 — The menu item appears on touch-primary layouts only

- **Feature:** Two-finger terminal wheel gesture — menu availability
- **Preconditions:** Dashboard open with a live session.
- **Config-matrix cell:** Touch-primary browser wide and narrow; non-touch
  desktop browser.
- **Steps:**
  1. On a wide touch-primary browser, open the hamburger menu.
  2. Narrow the same browser below the mobile breakpoint and open the menu
     again.
  3. Open the same dashboard on a desktop browser with a fine pointer and hover
     support, then open the menu.
- **Expected result:** The **Invert two-finger scrolling** item appears on both
  touch-primary layouts (wide and narrow). It does not appear on a non-touch
  desktop browser at any width.
- **Platforms:** iPadOS Safari, Android Chrome, macOS/Windows/Linux desktop
  Chrome/Firefox/Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-9 — Count changes, touchcancel, and backgrounding stop momentum without a jump

- **Feature:** Two-finger terminal wheel gesture — interruption handling
- **Preconditions:** Live session with long scrollback; touch-primary browser.
- **Config-matrix cell:** Touch-primary browser; default inversion off.
- **Steps:**
  1. Start a momentum scroll with a quick two-finger flick.
  2. While it is still moving, lift one finger early so the touch count changes
     away from two.
  3. Repeat the flick, then background the page or switch away so the browser
     cancels the touch sequence.
  4. Return to the dashboard and inspect the terminal position.
- **Expected result:** Each interruption stops the fling at the current
  position without a visible jump. The scroll position stays where it stopped;
  the return to the app does not replay the old momentum.
- **Platforms:** iPadOS Safari, Android Chrome, touch-capable desktop browser in
  tablet/touch mode.
- **Result:** _date / tester / platform / pass-fail / notes_
