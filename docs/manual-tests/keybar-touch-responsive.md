# Touch keybar availability + responsive chooser labels

Manual checks for decoupling the terminal keybar from viewport width: the keybar
is offered on **touch-primary** devices (`(pointer: coarse) and (hover: none)`)
regardless of width, docking inline beneath the side-by-side terminal on wide
touch devices, while the stacked/fullscreen layout stays width-based (≤768px).
The chooser buttons also show text labels ("Keyboard", "Font size", "Composer")
when wide enough and collapse to icon-only on narrow viewports.

## KBT-1 — Wide touch device docks the keybar inline

- **Feature:** Touch keybar availability
- **Preconditions:** A wide touch device (tablet, or landscape phone with
  viewport > 768px) with one live session. Dashboard open in the normal
  side-by-side layout (sidebar + terminal), NOT fullscreen. Key bar pinned.
- **Config-matrix cell:** Browser = iPadOS Safari / Android Chrome tablet;
  viewport > 768px; primary pointer coarse.
- **Steps:**
  1. Select a live session so its terminal is visible in the main pane.
  2. Observe the bottom of the terminal pane.
- **Expected result:** The keybar (arrows, Keyboard, Font size, Composer)
  appears docked inline directly beneath the terminal; the terminal shrinks to
  make room and refits to the new size. No full-viewport backdrop dims the page,
  and no fullscreen/maximize step was required.
- **Platforms:** iPadOS Safari, Android Chrome (tablet).
- **Result:** _date / tester / platform / pass-fail / notes_

## KBT-2 — Wide touch device reveals the keybar with a swipe when unpinned

- **Feature:** Touch keybar availability
- **Preconditions:** As KBT-1 but with the key bar **unpinned**.
- **Config-matrix cell:** As KBT-1.
- **Steps:**
  1. Confirm the keybar is not docked (unpinned, so hidden by default).
  2. Swipe leftwards starting from the right edge of the screen.
  3. Interact with the terminal / dismiss to hide it again.
- **Expected result:** The right-edge swipe reveals the keybar docked inline
  beneath the terminal; it stays docked until dismissed. No fullscreen is
  entered.
- **Platforms:** iPadOS Safari, Android Chrome (tablet).
- **Result:** _date / tester / platform / pass-fail / notes_

## KBT-3 — Chooser buttons show text labels when wide, icon-only when narrow

- **Feature:** Responsive chooser labels
- **Preconditions:** A device/window where the keybar chooser is visible.
- **Config-matrix cell:** Viewport toggled across the 768px breakpoint.
- **Steps:**
  1. With a wide viewport (> 768px), inspect the Keyboard, Font size, and
     Composer chooser buttons.
  2. Narrow the viewport to ≤ 768px (or use a phone in portrait) and inspect the
     same buttons.
- **Expected result:** Above 768px the three buttons show both their icon and
  their text label ("Keyboard", "Font size", "Composer"). At ≤ 768px the labels
  are hidden (icon-only). In both states each button keeps its accessible name
  (verify Keyboard / Font size / Compose text via the accessibility inspector).
- **Platforms:** iPadOS Safari, Android Chrome, desktop Chrome (responsive mode).
- **Result:** _date / tester / platform / pass-fail / notes_

## KBT-4 — Non-touch desktop never shows the keybar

- **Feature:** Touch keybar availability
- **Preconditions:** A desktop/laptop with a fine pointer (mouse/trackpad) that
  supports hover. One live session.
- **Config-matrix cell:** Browser = desktop Chrome/Firefox/Safari; primary
  pointer fine; hover supported; any width (including narrow window).
- **Steps:**
  1. Open a live session at a wide window width.
  2. Resize the window narrow (but keep a real mouse pointer).
- **Expected result:** No keybar appears at any width on a non-touch device; the
  desktop experience is unchanged (the keybar is a touch-only affordance).
- **Platforms:** macOS/Windows/Linux desktop browsers.
- **Result:** _date / tester / platform / pass-fail / notes_

## KBT-5 — Narrow phone keeps the maximized-only fullscreen keybar flow

- **Feature:** Touch keybar availability
- **Preconditions:** A phone (viewport ≤ 768px, touch) with one live session.
- **Config-matrix cell:** Browser = iOS Safari / Android Chrome (phone);
  viewport ≤ 768px.
- **Steps:**
  1. From the stacked session list, tap "Open terminal" to maximize a session.
  2. Reveal the keybar (pinned auto-shows it; unpinned via right-edge swipe).
  3. Tap outside the keybar chooser (on the backdrop).
  4. Exit fullscreen.
- **Expected result:** On a phone the keybar only appears in the maximized
  fullscreen flow, with the tap-catching backdrop that dismisses/collapses it,
  exactly as before this change. Leaving fullscreen closes the panel; the
  stacked layout never shows a docked keybar.
- **Platforms:** iOS Safari, Android Chrome (phone).
- **Result:** _date / tester / platform / pass-fail / notes_
