# Text staging area (mobile keybar)

Manual checks for the terminal keybar text staging area: an icon-only chooser
that opens a full-viewport multiline compose overlay whose text can be inserted
into the terminal (with or without a trailing Enter), and whose text is retained
when cancelled.

## TSA-1 — Chooser buttons are icon-only

- **Feature:** Text staging area
- **Preconditions:** Dashboard open in a mobile viewport (≤ 768px). One live
  session, maximized so the keybar chooser is visible.
- **Config-matrix cell:** Browser = mobile Safari/Chrome; viewport ≤ 768px.
- **Steps:**
  1. Maximize a live session to reveal the keybar chooser row.
  2. Inspect the Keyboard, Font size, and new compose buttons.
- **Expected result:** The Keyboard, Font size, and compose buttons show icons
  only (no text labels). Each still has an accessible name (Keyboard, Font size,
  Compose text) verifiable via the accessibility inspector.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## TSA-2 — Compose overlay fills the viewport and inserts text

- **Feature:** Text staging area
- **Preconditions:** As TSA-1, with a shell prompt visible in the session.
- **Config-matrix cell:** Browser = mobile Safari/Chrome; viewport ≤ 768px.
- **Steps:**
  1. Tap the compose (pencil) button in the keybar chooser.
  2. Confirm the overlay fills the whole viewport with a large text box, and
     that the "Exit fullscreen" button is hidden while composing.
  3. Type a single line of text, e.g. `echo one`.
  4. Tap **Insert**.
- **Expected result:** The overlay covers the entire viewport while composing
  (no Exit button showing through). After Insert, the overlay closes, the typed
  text appears at the terminal cursor with no trailing Enter appended (the line
  is left un-submitted at the prompt), and the staging box is empty next time it
  is opened. Note: Insert sends the textarea contents verbatim as a paste, so if
  the text contains embedded newlines the shell will submit each completed line
  exactly as a normal paste would; only the trailing Enter is withheld.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## TSA-3 — Insert & Run executes the text

- **Feature:** Text staging area
- **Preconditions:** As TSA-2.
- **Config-matrix cell:** Browser = mobile Safari/Chrome; viewport ≤ 768px.
- **Steps:**
  1. Open the compose overlay and type `echo hello`.
  2. Tap **Insert & Run**.
- **Expected result:** The overlay closes, `echo hello` is sent followed by
  Enter, so the command executes and `hello` is printed. The staging box is
  empty next time it is opened.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## TSA-4 — Cancel retains text and reveals the terminal

- **Feature:** Text staging area
- **Preconditions:** As TSA-2.
- **Config-matrix cell:** Browser = mobile Safari/Chrome; viewport ≤ 768px.
- **Steps:**
  1. Open the compose overlay and type `some draft text`.
  2. Tap **Cancel**.
  3. Observe the terminal.
  4. Re-open the compose overlay.
- **Expected result:** Cancel closes the overlay without sending anything, the
  terminal is visible again, and re-opening the overlay shows `some draft text`
  still present (retained across cancel).
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## TSA-5 — Insert buttons disabled when empty

- **Feature:** Text staging area
- **Preconditions:** As TSA-2, with the staging box empty.
- **Config-matrix cell:** Browser = mobile Safari/Chrome; viewport ≤ 768px.
- **Steps:**
  1. Open the compose overlay with no text entered.
  2. Inspect the Insert and Insert & Run buttons.
- **Expected result:** Both Insert and Insert & Run are disabled while the box is
  empty; Cancel remains enabled. Typing any character enables them.
- **Platforms:** iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_
