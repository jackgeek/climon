# Terminal title as session subtitle

Verifies that climon no longer forces the attached terminal's title to the
session name, and instead captures the title programs inside the PTY set
(OSC 0/2) and shows it as a per-session subtitle in the dashboard.

## TTS-1 — Program-set title appears as a subtitle

- **Feature:** Terminal-title capture → dashboard subtitle
- **Preconditions:** climon built; dashboard server running; a session started
  with `climon run bash` (or `climon` default shell).
- **Config-matrix cell:** default config (no `terminal.setTitle`).
- **Steps:**
  1. Open the dashboard and select the session.
  2. In the session's terminal, run: `printf '\033]0;hello-from-pty\007'`.
  3. Observe the session list item and the terminal-view header within ~1s.
  4. Run: `printf '\033]2;second-title\007'`.
  5. Start a long-lived TUI that sets its own title (e.g. `vim`), then quit it.
- **Expected result:** After step 2 the subtitle `hello-from-pty` appears under
  the session name in the list and beside the name in the header; after step 4
  it updates to `second-title`; the TUI's title shows while running. The session
  *name* is unchanged throughout.
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TTS-2 — Renaming no longer changes the terminal title

- **Feature:** Removal of name→title behavior
- **Preconditions:** A local `climon` session attached in a terminal whose tab
  title is visible.
- **Config-matrix cell:** default config.
- **Steps:**
  1. Note the attached terminal's current tab/window title.
  2. Rename the session from the dashboard Edit dialog (or the `climon` rename
     path) to set a new name.
  3. Observe the attached terminal's title.
- **Expected result:** The attached terminal's title does NOT change to the
  session name on rename. If a program inside the PTY has set a title, that
  title remains shown by the terminal (passthrough).
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TTS-3 — Local terminal shows the program's own title (passthrough)

- **Feature:** Output passthrough unchanged
- **Preconditions:** A local attached `climon` session.
- **Config-matrix cell:** default config.
- **Steps:**
  1. In the session, run `printf '\033]0;passthrough-check\007'`.
  2. Observe the host terminal's tab/window title.
- **Expected result:** The host terminal title shows `passthrough-check`
  (climon does not strip or override the program's OSC title).
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TTS-4 — Deprecated `terminal.setTitle` still loads

- **Feature:** Config backward compatibility
- **Preconditions:** A `$CLIMON_HOME/config.jsonc` containing
  `"terminal": { "setTitle": true }` (hand-edited).
- **Config-matrix cell:** legacy-key present.
- **Steps:**
  1. Start any `climon` command that loads config (e.g. `climon ls`).
- **Expected result:** The command runs normally with no config error; the
  stale key is ignored.
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_
