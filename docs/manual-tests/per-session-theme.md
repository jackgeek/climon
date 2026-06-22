# Per-session theme + default theme

Manual checks for per-session terminal themes and the dashboard-wide default.
The hamburger **Default theme** menu sets `dashboard.theme` (the default every
session inherits); a session can override it from the **Edit Session** / **New
Session** dialogs or the CLI `--theme` flag. Themes are identified by their
display **name** (e.g. `"Dracula"`). Values are lenient: an unrecognised name
falls back to the default in the dashboard. An empty/cleared session theme means
"inherit the default". The dashboard chrome and terminal always follow the
**active** session's effective theme.

## PST-1 — CLI `--theme` sets a session's theme

- **Feature:** Per-session theme — CLI flag
- **Preconditions:** `climon server` running; dashboard open.
- **Config-matrix cell:** Browser = desktop; default theme = **Default** (dark).
- **Steps:**
  1. Run `climon --theme "Dracula" bash` in a terminal.
  2. In the dashboard, click the new session to open its terminal.
- **Expected result:** The session's terminal renders with the **Dracula**
  palette, regardless of the dashboard default. Its session metadata JSON in
  `$CLIMON_HOME/sessions/<id>.json` contains `"theme": "Dracula"`.
- **Platforms:** macOS, Linux, Windows.
- **Result:** _date / tester / platform / pass-fail / notes_

## PST-2 — Edit Session sets and persists a theme

- **Feature:** Per-session theme — Edit Session dialog
- **Preconditions:** Dashboard open with at least one live session that has no
  theme override.
- **Config-matrix cell:** Browser = desktop.
- **Steps:**
  1. Hover the session row and click **Edit**.
  2. In the **Theme** picker, type to filter and choose **Solarized Dark**.
  3. Save.
  4. Full-reload the page and re-open the session.
- **Expected result:** On save the active session's terminal recolours to
  **Solarized Dark**. After reload the override persists (still Solarized Dark);
  the session JSON contains `"theme": "Solarized Dark"`.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## PST-3 — New Session dialog picks a theme

- **Feature:** Per-session theme — New Session dialog
- **Preconditions:** Dashboard open with one live session to spawn from (or the
  empty-state **[+]**).
- **Config-matrix cell:** Browser = desktop.
- **Steps:**
  1. Click **[+]** to open the New Session dialog.
  2. Choose **Monokai Soda** in the **Theme** picker and enter a command.
  3. Create the session, then open it.
- **Expected result:** The newly created session opens with the **Monokai Soda**
  palette; its JSON contains `"theme": "Monokai Soda"`.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## PST-4 — "Inherit default" clears a session override

- **Feature:** Per-session theme — clear/inherit
- **Preconditions:** A session that currently has a theme override (e.g. from
  PST-2); dashboard default is a different theme.
- **Config-matrix cell:** Browser = desktop.
- **Steps:**
  1. Edit that session and choose **Inherit default** in the Theme picker.
  2. Save.
  3. Reload the page and re-open the session.
- **Expected result:** The session immediately follows the dashboard default
  again. After reload the override is still cleared; the session JSON has **no**
  `theme` field.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## PST-5 — Changing the default re-themes inheriting sessions live

- **Feature:** Default theme — live inheritance
- **Preconditions:** At least two sessions open: one with **Inherit default** and
  one with an explicit override (e.g. Dracula).
- **Config-matrix cell:** Browser = desktop.
- **Steps:**
  1. Open ☰ → **Default theme** → **Gruvbox Dark**.
  2. Open each session in turn.
- **Expected result:** The inheriting session now renders **Gruvbox Dark**; the
  overridden session is **unchanged** (still Dracula). `config.jsonc` contains
  `dashboard.theme = "Gruvbox Dark"`.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## PST-6 — Chrome base follows the active session (light vs dark)

- **Feature:** Per-session theme — Fluent chrome base
- **Preconditions:** Two sessions — one with a dark theme (e.g. Dracula) and one
  with a light theme (e.g. GitHub).
- **Config-matrix cell:** Browser = desktop.
- **Steps:**
  1. Open the dark-themed session and note the dashboard chrome.
  2. Switch to the light-themed session.
- **Expected result:** Selecting the light-themed session flips the dashboard
  chrome to the Fluent **light** base; switching back to the dark-themed session
  returns it to the **dark** base. Only the Fluent base swaps.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## PST-7 — Unknown theme name falls back gracefully

- **Feature:** Per-session theme — lenient validation
- **Preconditions:** `climon server` running; dashboard open.
- **Config-matrix cell:** Browser = desktop.
- **Steps:**
  1. Run `climon --theme "totally-bogus-theme" bash`.
  2. Open the session in the dashboard.
- **Expected result:** No error from the CLI; the session is created with
  `"theme": "totally-bogus-theme"` in its JSON, and the dashboard renders it with
  the **Default** palette (graceful fallback, no crash or blank terminal).
- **Platforms:** macOS, Linux, Windows.
- **Result:** _date / tester / platform / pass-fail / notes_

## PST-8 — Remote session carries its theme

- **Feature:** Per-session theme — remote sessions
- **Preconditions:** A remote devbox connected over a dev tunnel (or WSL↔Windows
  bridge) with at least one remote session.
- **Config-matrix cell:** Remote = dev tunnel / WSL bridge.
- **Steps:**
  1. On the remote machine, run `climon --theme "Nord" bash`.
  2. In the local dashboard, open the remote session.
- **Expected result:** The remote session opens with the **Nord** palette in the
  local dashboard (the per-session theme is materialised across the bridge).
- **Platforms:** macOS/Linux host + remote devbox; Windows + WSL.
- **Result:** _date / tester / platform / pass-fail / notes_
