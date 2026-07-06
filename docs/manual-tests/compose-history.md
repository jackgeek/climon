# Compose history (Back/Forward recall)

Manual checks for the composer's per-session, in-memory history: text that is
Inserted is remembered for that session, and Back/Forward buttons cycle the
textarea through previous entries. History is cleared on page reload.

## CH-1 — Insert records history and Back recalls it

- **Feature:** Compose history
- **Preconditions:** Dashboard open, one live session attached, keybar chooser
  visible.
- **Config-matrix cell:** Browser = desktop/mobile Chrome; any viewport.
- **Steps:**
  1. Open the composer, type `echo one`, tap **Insert**.
  2. Open the composer again, type `echo two`, tap **Insert**.
  3. Open the composer (empty draft) and tap **Back**.
  4. Tap **Back** again.
- **Expected result:** After step 3 the textarea shows `echo two` (most recent).
  After step 4 it shows `echo one` (older). Back is disabled once `echo one`
  (the oldest) is shown.
- **Platforms:** Desktop Chrome, iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## CH-2 — Forward returns toward the newest, then restores the draft

- **Feature:** Compose history
- **Preconditions:** As CH-1, with `echo one` then `echo two` already inserted.
- **Config-matrix cell:** Browser = desktop/mobile Chrome; any viewport.
- **Steps:**
  1. Open the composer and type `echo three` (do not insert).
  2. Tap **Back** twice to reach `echo one`.
  3. Tap **Forward** once, then again, then a third time.
- **Expected result:** After the two Backs the textarea shows `echo one`. Forward
  shows `echo two`, then `echo three` (the live draft is restored) — at which
  point Forward is disabled again. Back is enabled whenever an older entry
  exists.
- **Platforms:** Desktop Chrome, iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## CH-3 — Buttons visible-but-disabled with no history; typing detaches

- **Feature:** Compose history
- **Preconditions:** A freshly reloaded dashboard, live session, no text inserted
  yet this session.
- **Config-matrix cell:** Browser = desktop/mobile Chrome; any viewport.
- **Steps:**
  1. Open the composer without inserting anything.
  2. Inspect the Back and Forward buttons.
  3. Insert `alpha`, then reopen, tap **Back** to load `alpha`.
  4. Edit the text to `alphabet` (type into the textarea), then tap **Back**.
- **Expected result:** In step 2 both Back and Forward are visible but disabled.
  In step 4, typing detaches from history so **Back** re-enters history from the
  newest entry (`alpha`), confirming edits become a fresh draft.
- **Platforms:** Desktop Chrome, iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## CH-4 — History is per session

- **Feature:** Compose history
- **Preconditions:** Two live sessions, A and B.
- **Config-matrix cell:** Browser = desktop/mobile Chrome; any viewport.
- **Steps:**
  1. View session A, insert `from-a` via the composer.
  2. Switch to view session B, open the composer, tap **Back**.
- **Expected result:** Session B's composer shows no `from-a` entry — Back is
  disabled (empty history) because history is isolated per session. Switching
  back to A and opening the composer still recalls `from-a`.
- **Platforms:** Desktop Chrome, iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## CH-5 — Reload clears history

- **Feature:** Compose history
- **Preconditions:** A live session with at least one inserted entry.
- **Config-matrix cell:** Browser = desktop/mobile Chrome; any viewport.
- **Steps:**
  1. Insert `remember-me` in a session.
  2. Reload the dashboard page.
  3. Reopen the composer and tap **Back**.
- **Expected result:** After reload the history is empty — Back is disabled and
  `remember-me` is no longer recallable (history is in-memory only, by design).
- **Platforms:** Desktop Chrome, iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_
