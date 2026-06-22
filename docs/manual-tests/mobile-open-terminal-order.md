# Mobile active-session layout order

Manual checks for the mobile stacked layout of the active session item, where the
**Open terminal** button sits between the session title and the status/client
metadata.

## MOTO-1 — Open terminal sits above the status/client meta on mobile

- **Feature:** Mobile active-session layout order
- **Preconditions:** Dashboard open in a mobile viewport (≤ 768px wide, e.g.
  device emulation or a real phone). At least one live session, selected so it is
  the active session.
- **Config-matrix cell:** Browser = mobile Safari/Chrome; viewport ≤ 768px.
- **Steps:**
  1. Tap a live session in the list so it becomes active.
  2. Observe the stacked layout of the active session row.
- **Expected result:** From top to bottom the row shows: the session
  title/command, then the full-width **Open terminal** button, then the status
  badge and client label on the bottom row.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## MOTO-2 — Desktop layout is unchanged

- **Feature:** Mobile active-session layout order
- **Preconditions:** Dashboard open in a desktop viewport (> 768px wide). At
  least one live session.
- **Config-matrix cell:** Browser = desktop; viewport > 768px.
- **Steps:**
  1. Select a live session so it becomes active.
  2. Observe the session row layout.
- **Expected result:** The status badge and client label appear directly under
  the session title as before, and the **Open terminal** button is not shown in
  the row (the desktop maximize control is unaffected).
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_
