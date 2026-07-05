# Terminal selection / copy (touch)

Manual checks for the terminal keybar **Select** button: a touch-only action that
captures the terminal's full scrollback buffer into a read-only, monospaced
textarea so the text can be copied with the platform's native tools. A "Strip
scrollbars & decorations" toggle replaces block/box-drawing glyphs (scrollbars,
borders) with spaces to keep column alignment while cleaning up the copy. Copy
itself uses native selection (long-press / Select all → OS Copy) — no in-app
clipboard button.

## TSM-1 — Select button is touch-only

- **Feature:** Terminal selection / copy
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

## TSM-2 — Capturing the full scrollback into the textarea

- **Feature:** Terminal selection / copy
- **Preconditions:** As TSM-1 on a touch device, with enough output to have
  scrolled the terminal (several screens of history).
- **Config-matrix cell:** Browser = mobile Safari/Chrome; touch-primary.
- **Steps:**
  1. Tap the **Select** button in the chooser.
  2. Observe the full-viewport overlay that appears.
  3. Scroll the textarea up and down.
- **Expected result:** A full-viewport overlay opens with a read-only textarea
  that fills the whole viewport (minus the strip toggle + action buttons) and
  opens **scrolled to the bottom** (newest output), matching the terminal.
  Scrolling the textarea up reveals earlier history. The font is monospaced and
  the original column formatting is preserved (long lines scroll horizontally
  rather than wrapping). Tapping the textarea does **not** submit anything to the
  terminal.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## TSM-3 — Copying text with native tools

- **Feature:** Terminal selection / copy
- **Preconditions:** As TSM-2, overlay open.
- **Config-matrix cell:** Browser = mobile Safari/Chrome; touch-primary.
- **Steps:**
  1. Tap **Select all** (or long-press in the textarea and choose Select All).
  2. Tap **Copy** in the OS selection toolbar.
  3. Paste into another field/app to verify.
- **Expected result:** Select all highlights the whole capture without opening
  the soft keyboard (the textarea is read-only). The OS **Copy** action places
  the text on the clipboard. Long-press selection of a sub-range also works.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## TSM-4 — Strip scrollbars & decorations toggle

- **Feature:** Terminal selection / copy
- **Preconditions:** A tool that paints a right-edge scrollbar or box borders is
  running in the session (e.g. Copilot CLI, or any TUI drawing │ ▌ █ ░).
- **Config-matrix cell:** Browser = mobile Safari/Chrome; touch-primary.
- **Steps:**
  1. Tap **Select** to capture the text (toggle initially off).
  2. Note the block/box-drawing glyphs in the captured text.
  3. Enable **Strip scrollbars & decorations**.
  4. Compare the text; disable the toggle again.
- **Expected result:** With the toggle on, block/box-drawing/geometric glyphs
  (U+2500–U+25FF) are replaced with spaces so the surrounding columns stay
  aligned, and trailing whitespace is trimmed — the scrollbar/border noise is
  gone while the rest of the layout is preserved. Toggling off restores the raw
  captured text. Copy reflects whichever state is shown.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## TSM-5 — Closing the overlay

- **Feature:** Terminal selection / copy
- **Preconditions:** As TSM-2, overlay open.
- **Config-matrix cell:** Browser = mobile Safari/Chrome; touch-primary.
- **Steps:**
  1. Tap **Close**.
  2. Observe the terminal and keybar.
- **Expected result:** The overlay closes, the terminal is visible again, and
  the keybar returns to its chooser (or closed) state. Re-opening **Select**
  re-captures the current scrollback afresh (with the strip toggle applied to
  the new capture).
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_
