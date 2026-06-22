# Dashboard preferences (shared theme picker + key-bar pin)

Manual checks for the generic, config-backed dashboard preferences mechanism and
its first two consumers: the xterm **theme picker** and the **key-bar pin**.
Preferences are written through `POST /api/dashboard/preferences` (same-origin
guarded, allowlist-validated) and read back from `/health`, so they persist in
`$CLIMON_HOME/config.jsonc` and are shared across browsers/devices.

## DP-1 — Theme selection repaints the terminal immediately

- **Feature:** Dashboard preferences — theme picker
- **Preconditions:** Dashboard open with at least one live session attached.
- **Config-matrix cell:** Browser = desktop Chrome/Firefox/Safari.
- **Steps:**
  1. Open the hamburger (☰) menu and open the **Theme** submenu.
  2. Choose **Dracula**.
- **Expected result:** The terminal recolours to Dracula immediately, with no
  page reload. The check mark moves to **Dracula**.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## DP-2 — A light theme switches the Fluent chrome base

- **Feature:** Dashboard preferences — theme picker
- **Preconditions:** Dashboard open; current theme is a dark theme (e.g.
  **Default**).
- **Config-matrix cell:** Browser = desktop.
- **Steps:**
  1. Open ☰ → **Theme** → **Github** (a light theme).
  2. Observe the dashboard chrome (sidebar, menus, headers).
  3. Open ☰ → **Theme** → **Default**.
- **Expected result:** Selecting **Github** switches the dashboard chrome to the
  Fluent **light** base; selecting **Default** returns it to the Fluent **dark**
  base. Only the Fluent base swaps — no other climon colours change.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## DP-3 — Theme persists across reload

- **Feature:** Dashboard preferences — persistence
- **Preconditions:** Dashboard open.
- **Config-matrix cell:** Browser = desktop.
- **Steps:**
  1. Open ☰ → **Theme** → **Gruvbox Dark**.
  2. Reload the page (full reload).
- **Expected result:** The dashboard loads with **Gruvbox Dark** already active
  (the check mark is on Gruvbox Dark). `config.jsonc` contains
  `dashboard.theme = "gruvbox-dark"`.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## DP-4 — Theme is shared across browsers/devices

- **Feature:** Dashboard preferences — shared config
- **Preconditions:** Dashboard reachable from two browsers (A and B) against the
  same server.
- **Config-matrix cell:** Browser A + Browser B (or device A + device B).
- **Steps:**
  1. In browser A, open ☰ → **Theme** → **Monokai Soda**.
  2. In browser B, load (or reload) the dashboard.
- **Expected result:** Browser B loads with **Monokai Soda** active, because the
  server (`/health`) is the source of truth.
- **Platforms:** Desktop + second browser/device.
- **Result:** _date / tester / platform / pass-fail / notes_

## DP-5 — Key-bar pin persists to config and is shared

- **Feature:** Dashboard preferences — key-bar pin
- **Preconditions:** Dashboard open in a mobile viewport (≤ 768px) with a live
  session; a second browser/device available.
- **Config-matrix cell:** Browser = mobile; viewport ≤ 768px.
- **Steps:**
  1. Open ☰ and tap **Pin key bar**.
  2. Reload the page.
  3. Open the dashboard in a second browser/device (mobile viewport).
- **Expected result:** The pin survives reload and the menu reads **Unpin key
  bar**; the second browser also shows the pinned state. `config.jsonc` contains
  `dashboard.keyBarPinned = true`.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## DP-6 — Remote tunnel viewer can change a preference

- **Feature:** Dashboard preferences — same-origin write over tunnel
- **Preconditions:** A dev-tunnel (Tunnel Link) session is active; open the
  dashboard via the tunnel URL.
- **Config-matrix cell:** Remote = dev tunnel; Browser = any.
- **Steps:**
  1. Over the tunnel URL, open ☰ → **Theme** → **Solarized Dark**.
  2. (Optional) Watch the network panel for `POST /api/dashboard/preferences`.
- **Expected result:** The write succeeds (HTTP 200), the terminal repaints, and
  the value persists in `config.jsonc`. A cross-origin request (different Origin
  host) would be rejected with 403.
- **Platforms:** Desktop/mobile over a dev tunnel.
- **Result:** _date / tester / platform / pass-fail / notes_

## DP-7 — Legacy key-bar pin migrates once

- **Feature:** Dashboard preferences — legacy migration
- **Preconditions:** `config.jsonc` has no `dashboard.keyBarPinned`. In the
  browser dev-tools console, seed the legacy value before loading:
  `localStorage.setItem("climon.keyBarPinned", "true")` and ensure
  `localStorage.getItem("climon.pref.migrated.keyBarPinned")` is `null`.
- **Config-matrix cell:** Browser = any.
- **Steps:**
  1. Load the dashboard once.
  2. Inspect `config.jsonc` and `localStorage`.
  3. Reload the page again.
- **Expected result:** After the first load, `config.jsonc` gains
  `dashboard.keyBarPinned = true`, the legacy `climon.keyBarPinned` key is
  removed, and `climon.pref.migrated.keyBarPinned` is set to `"true"`. The second
  load does not re-run the migration (no duplicate write).
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## DP-8 — Full theme picker: grouped, searchable, with fallback

- **Feature:** Dashboard preferences — full theme picker
- **Preconditions:** Dashboard open with at least one live session attached.
- **Config-matrix cell:** Browser = desktop Chrome/Firefox/Safari.
- **Steps:**
  1. Open ☰ → **Theme**.
  2. Confirm **Default** is pinned at the top, followed by a **Dark** group and a
     **Light** group, each listing many themes (the picker exposes all bundled
     `xterm-theme` options).
  3. Type `solar` into the **Search themes…** box.
  4. Clear the search box, then type `zzzznotathemewxyz`.
  5. Select a **Light** group theme (e.g. **Solarized Light**), then reload.
  6. (Optional) Edit `config.jsonc` to set `dashboard.theme = "not-a-real-theme"`
     and reload the dashboard.
- **Expected result:**
  - Step 2: Default on top; Dark and Light groups each populated; the popover
    scrolls without overflowing the viewport.
  - Step 3: the list filters case-insensitively to matching themes (e.g.
    Solarized Dark / Solarized Light); empty groups disappear; **Escape** still
    closes the menu while the search box is focused.
  - Step 4: a disabled **No themes found** row is shown and no group remains.
  - Step 5: the chosen light theme is active after reload (chrome on the Fluent
    light base); `config.jsonc` holds its kebab id (e.g. `solarized-light`).
  - Step 6: an unknown id is rejected on write and falls back to **Default** on
    load — no crash, no blank terminal.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_
