# Terminal progress indicator on the session list

Verifies that climon captures the `OSC 9;4` progress state programs emit inside
the PTY (the ConEmu/Windows-Terminal taskbar-progress sequence) and surfaces it
per-session on the dashboard: state 0 clears it (nothing), state 1 draws a
determinate bar across the bottom of the session item filled to the reported
percentage, state 2 shows an error icon, state 3 shows an animated spinner, and
state 4 shows a warning icon. The `dashboard.stateIconNoMotion` preference
freezes the spinner.

The escape is `ESC ] 9 ; 4 ; <state> ; <percent> BEL`. In a shell:
`printf '\033]9;4;<state>;<percent>\007'`.

## TPI-1 — Determinate progress draws a bottom bar

- **Feature:** OSC 9;4 state 1 → determinate bottom bar
- **Preconditions:** climon built; dashboard server running; a session started
  with `climon run bash` (or the default shell) and visible in the session list.
- **Config-matrix cell:** default config (`dashboard.stateIconNoMotion` unset/false).
- **Steps:**
  1. Open the dashboard so the session list is visible.
  2. In the session's terminal run: `printf '\033]9;4;1;25\007'`.
  3. Observe the session list item within ~1s.
  4. Run: `printf '\033]9;4;1;80\007'`.
  5. Run: `printf '\033]9;4;0;0\007'`.
- **Expected result:** After step 2 a thin bar appears across the bottom of the
  session item filled to ~25%; after step 4 it grows to ~80%; after step 5 the
  bar disappears entirely. No icon is shown for state 1.
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TPI-2 — Error, spinner, and warning icons

- **Feature:** OSC 9;4 states 2/3/4 → meta-row icons
- **Preconditions:** As TPI-1.
- **Config-matrix cell:** default config.
- **Steps:**
  1. Run: `printf '\033]9;4;3;0\007'` (indeterminate).
  2. Observe the session item; confirm the spinner rotates.
  3. Run: `printf '\033]9;4;2;0\007'` (error).
  4. Run: `printf '\033]9;4;4;0\007'` (warning).
  5. Run: `printf '\033]9;4;0;0\007'` (clear).
- **Expected result:** Step 1–2 show an animated (rotating) spinner in the item's
  status/meta row; step 3 replaces it with a red error icon; step 4 replaces it
  with an amber warning icon; step 5 removes the icon. The session status badge
  is unaffected throughout.
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TPI-3 — Indicator shows in the collapsed (compact) list

- **Feature:** Progress indicator in compact mode
- **Preconditions:** As TPI-1, with the session list collapsed to the compact
  (icon-rail) width.
- **Config-matrix cell:** default config; collapsed sidebar.
- **Steps:**
  1. Collapse the session list.
  2. Run: `printf '\033]9;4;3;0\007'` then `printf '\033]9;4;1;60\007'`.
- **Expected result:** The spinner appears in the compact item, then is replaced
  by the determinate bar across the bottom of the compact item at ~60%.
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TPI-4 — `dashboard.stateIconNoMotion` freezes the spinner

- **Feature:** Reduced-motion preference
- **Preconditions:** climon built; `$CLIMON_HOME/config.jsonc` contains
  `"dashboard": { "stateIconNoMotion": true }`; dashboard server (re)started so
  the preference is served in `/health`; browser reloaded.
- **Config-matrix cell:** `dashboard.stateIconNoMotion = true`.
- **Steps:**
  1. Run: `printf '\033]9;4;3;0\007'` (indeterminate).
  2. Observe the spinner icon.
- **Expected result:** The spinner icon is shown but does **not** rotate (it is a
  static icon). Determinate bars and error/warning icons still render normally.
  (Enabling the OS "reduce motion" setting produces the same frozen result even
  when the config flag is false.)
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TPI-5 — Remote sessions surface sanitized progress

- **Feature:** OSC 9;4 progress over the remote ingest bridge
- **Preconditions:** A remote uplink/ingest pair established (see
  [phase09-remote.md](phase09-remote.md)); a remote session visible in the
  dashboard's session list.
- **Config-matrix cell:** remotes enabled.
- **Steps:**
  1. In the remote session's terminal run: `printf '\033]9;4;1;40\007'`.
  2. Observe the remote session item in the local dashboard within ~1–2s.
  3. Run: `printf '\033]9;4;1;250\007'` (out-of-range percentage).
- **Expected result:** Step 1 shows a ~40% determinate bar on the remote item;
  step 3's out-of-range percentage is clamped to a full (100%) bar rather than
  overflowing or being dropped. Unknown/garbage states never render.
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_
