# Pin key bar (mobile)

Manual checks for the mobile-only "Pin key bar" hamburger-menu option and the
centralised mobile-view detection it relies on.

## PKB-1 — Pinning keeps the chooser bar visible on mobile

- **Feature:** Pin key bar
- **Preconditions:** Dashboard open in a mobile viewport (≤ 768px wide, e.g.
  device emulation or a real phone). At least one live session.
- **Config-matrix cell:** Browser = mobile Safari/Chrome; viewport ≤ 768px.
- **Steps:**
  1. Open the hamburger (☰) menu. Confirm a **Pin key bar** item is present.
  2. Tap **Pin key bar**.
  3. Maximize a live session.
- **Expected result:** The chooser bar (PageDown / Keyboard / Font size /
  PageUp) is visible at the bottom immediately, without an edge swipe. Tapping
  the terminal area above it does NOT dismiss it.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## PKB-2 — Sub-view tap returns to the chooser (not closed)

- **Feature:** Pin key bar
- **Preconditions:** PKB-1 set up (pinned + maximized, chooser visible).
- **Config-matrix cell:** Browser = mobile; viewport ≤ 768px.
- **Steps:**
  1. From the pinned chooser bar, tap **Keyboard** (or **Font size**).
  2. Tap the terminal area above the panel (the backdrop).
- **Expected result:** The panel returns to the chooser bar; it is never fully
  dismissed while pinned.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## PKB-3 — Preference persists across reload

- **Feature:** Pin key bar
- **Preconditions:** Mobile viewport, **Pin key bar** enabled.
- **Config-matrix cell:** Browser = mobile; viewport ≤ 768px.
- **Steps:**
  1. With pinning enabled, reload the page.
  2. Maximize a live session.
- **Expected result:** The chooser bar is pinned again after reload. The menu
  item reads **Unpin key bar**.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## PKB-4 — Option is absent on desktop

- **Feature:** Pin key bar
- **Preconditions:** Dashboard open in a desktop viewport (> 768px wide).
- **Config-matrix cell:** Browser = desktop; viewport > 768px.
- **Steps:**
  1. Open the hamburger (☰) menu.
- **Expected result:** There is no **Pin key bar** / **Unpin key bar** item, and
  no chooser bar is pinned in the desktop layout.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## PKB-5 — Key bar is pinned by default on a fresh install

- **Feature:** Pin key bar
- **Preconditions:** No prior `dashboard.keyBarPinned` value set (fresh
  `$CLIMON_HOME` config and cleared browser localStorage). Mobile viewport
  (≤ 768px wide). At least one live session.
- **Config-matrix cell:** Browser = mobile; viewport ≤ 768px; default config.
- **Steps:**
  1. Ensure `dashboard.keyBarPinned` is unset in config (default applies).
  2. Open the dashboard and maximize a live session.
  3. Open the hamburger (☰) menu.
- **Expected result:** The chooser bar is pinned/visible without any prior
  action, and the menu item reads **Unpin key bar** (i.e. pinning is on by
  default).
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_
