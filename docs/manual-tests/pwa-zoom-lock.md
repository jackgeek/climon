# PWA zoom lock & no overscroll

Manual checks for locking the dashboard PWA to a 1:1 view: pinch-zoom is
disabled and the page itself does not move (rubber-band / pull-to-refresh /
overscroll) on swipe. The terminal and session lists keep their own internal
scrolling.

## ZL-1 — Pinch-zoom is disabled

- **Feature:** PWA zoom lock
- **Preconditions:** Dashboard open on a touch device (or browser device
  emulation with touch). At least one session.
- **Config-matrix cell:** Browser = mobile Safari/Chrome (installed PWA and
  in-browser).
- **Steps:**
  1. Place two fingers on the screen and pinch outward, then inward, over the
     session list and over a maximized terminal.
- **Expected result:** The page never zooms; it stays at 1:1 scale. No content
  grows or shrinks under the pinch gesture.
- **Platforms:** iOS Safari (installed PWA + browser), Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## ZL-2 — Double-tap does not zoom

- **Feature:** PWA zoom lock
- **Preconditions:** As ZL-1.
- **Config-matrix cell:** Browser = mobile Safari/Chrome.
- **Steps:**
  1. Double-tap rapidly on the header, a session row, and the terminal area.
- **Expected result:** No double-tap zoom occurs; scale stays 1:1.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## ZL-3 — Page does not move on vertical swipe (no overscroll)

- **Feature:** PWA zoom lock
- **Preconditions:** Dashboard open on a touch device. Use both a short session
  list (nothing to scroll) and a maximized terminal.
- **Config-matrix cell:** Browser = mobile Safari/Chrome (installed PWA where
  pull-to-refresh/overscroll is most visible).
- **Steps:**
  1. Swipe up and down on the header / empty page area.
  2. Swipe up/down past the top and bottom of a scrollable session list.
  3. Swipe up/down past the top/bottom of the terminal scrollback.
- **Expected result:** The page (the whole app surface) never shifts, bounces,
  or triggers pull-to-refresh. Scrolling still works *inside* the session list
  and terminal scrollback; only the outer page is pinned.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## ZL-4 — Existing single-finger gestures still work

- **Feature:** PWA zoom lock
- **Preconditions:** Mobile viewport, a maximized live session.
- **Config-matrix cell:** Browser = mobile; viewport ≤ 768px.
- **Steps:**
  1. Perform the right-edge pull-in swipe that reveals the key bar.
  2. Tap buttons in the key bar; scroll the terminal with a single finger.
- **Expected result:** Single-finger taps, swipes, and internal scrolling are
  unaffected by the zoom/overscroll lock. The zoom lock only cancels
  multi-touch (pinch) and outer-page movement.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_
