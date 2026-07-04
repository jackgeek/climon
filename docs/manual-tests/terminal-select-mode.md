# Terminal selection mode (touch)

Manual checks for the terminal keybar **Select** toggle: a touch-only mode that
enables native text selection on the xterm rows and suppresses the mobile soft
keyboard, so users can drag-select terminal output and copy it via the OS
selection menu. Copying relies on the browser/OS native selection toolbar — the
app adds no Copy button.

## TSM-1 — Select toggle is touch-only

- **Feature:** Terminal selection mode
- **Preconditions:** One live session, maximized so the keybar chooser is
  visible.
- **Config-matrix cell:** Browser = mobile Safari/Chrome (touch-primary) vs.
  desktop Chrome/Firefox (mouse-primary).
- **Steps:**
  1. On a touch-primary device, reveal the keybar chooser and inspect the
     buttons.
  2. On a desktop (mouse) browser, reveal the keybar chooser and inspect the
     buttons.
- **Expected result:** The **Select** button (selection icon; accessible name
  "Select text") appears in the chooser on touch-primary devices only. It is
  absent in mouse-primary desktop browsers.
- **Platforms:** iOS Safari, Android Chrome; desktop Chrome/Firefox.
- **Result:** _date / tester / platform / pass-fail / notes_

## TSM-2 — Entering selection mode suppresses the soft keyboard

- **Feature:** Terminal selection mode
- **Preconditions:** As TSM-1 on a touch device, with a shell prompt and some
  scrollback output visible.
- **Config-matrix cell:** Browser = mobile Safari/Chrome; touch-primary.
- **Steps:**
  1. Tap the **Select** button in the chooser.
  2. Confirm the button shows an active/pressed (primary) appearance.
  3. Tap inside the terminal output area.
- **Expected result:** The soft keyboard does **not** appear when tapping the
  terminal while selection mode is active. The Select button stays visibly
  active.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## TSM-3 — Drag-select terminal text and copy via the OS menu

- **Feature:** Terminal selection mode
- **Preconditions:** As TSM-2, selection mode active.
- **Config-matrix cell:** Browser = mobile Safari/Chrome; touch-primary.
- **Steps:**
  1. Touch-and-drag across a range of terminal text (or long-press to start a
     native selection).
  2. Adjust the native selection handles to cover the desired text.
  3. Tap **Copy** in the OS selection toolbar.
  4. Paste into another field/app to verify.
- **Expected result:** Native selection handles appear over the terminal rows,
  the highlighted range matches the on-screen text, and the OS **Copy** action
  places the selected text on the clipboard. The app shows no in-app Copy
  button.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## TSM-4 — Exiting selection mode restores normal input

- **Feature:** Terminal selection mode
- **Preconditions:** As TSM-3, selection mode active with text selected.
- **Config-matrix cell:** Browser = mobile Safari/Chrome; touch-primary.
- **Steps:**
  1. Tap the **Select** button again to toggle it off (or switch to another
     chooser view such as Keyboard/Compose/Font, or close the panel).
  2. Observe the selection state and button appearance.
  3. Tap the terminal.
- **Expected result:** Selection mode turns off (button returns to the default
  outline appearance), any lingering selection is cleared, and tapping the
  terminal again focuses it and raises the soft keyboard as normal. Switching to
  another chooser view or closing the panel also exits selection mode.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_
