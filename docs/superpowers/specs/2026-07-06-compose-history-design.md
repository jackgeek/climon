# Compose history — design

## Problem

The dashboard composer (`src/web/components/TerminalPanel.tsx`, opened from the
terminal panel chooser) lets a user type text and insert it into the attached
terminal session. Once inserted, the text is gone — there is no way to recall
something you previously sent. Users who repeatedly send similar commands or
snippets must retype them.

## Goal

Let the composer remember previously inserted text and expose **Back/Forward**
buttons that cycle the textarea through prior entries, so a user can quickly
recall and re-insert (or edit and re-insert) something they sent before.

## Scope & decisions

- **Lifetime:** In-memory only. History lives in React state and is cleared on
  page reload. No `localStorage`/server persistence. (User decision.)
- **Scope:** Per session. Each terminal session has its own history, keyed by
  the active session id. Switching sessions shows that session's own history.
  (User decision.)
- **What is recorded:** Only text that is actually **Inserted**. Cancelled
  drafts are not recorded.
- **Ordering:** oldest → newest.
- **De-duplication:** Inserting text equal to an existing entry moves that entry
  to the newest position rather than adding a duplicate.
- **Cap:** History is bounded to `MAX_COMPOSE_HISTORY = 50` entries per session;
  the oldest entries are dropped first. Bounds memory for long-lived tabs.
- **End behavior:** Linear with draft restore (not wraparound). Back stops at the
  oldest entry; Forward past the newest restores the user's live draft.

## Architecture

Three units, each with a single clear purpose:

1. **`src/web/composeHistory.ts` (pure helper).**
   - `MAX_COMPOSE_HISTORY` constant.
   - `addComposeEntry(history: string[], text: string): string[]` — returns a new
     array with `text` recorded as the newest entry. Ignores empty text,
     de-duplicates (moving an existing copy to the end), and caps to
     `MAX_COMPOSE_HISTORY`. No storage, no React — trivially unit-testable.

2. **`src/web/App.tsx` (owner of history state).**
   - New state: `composeHistory: Record<string, string[]>` keyed by session id.
   - On `onComposeInsert(text)`: in addition to the existing
     `sendInput`/reset behavior, update the active session's entry via
     `addComposeEntry`.
   - Passes the active session's history (`composeHistory[activeId] ?? []`) to
     `TerminalPanel` as the `composeHistory` prop.
   - `composeText` (the current draft) remains a single global state as today;
     only the recall history is per-session.

3. **`src/web/components/TerminalPanel.tsx` (composer UI + navigation cursor).**
   - New prop: `composeHistory: string[]` (oldest → newest, for the active
     session).
   - Local cursor state `historyIndex: number | null`. `null` = editing a fresh
     draft (not browsing history); otherwise indexes `composeHistory`.
   - `composeDraftRef` stashes the live draft when the user first steps into
     history, so Forward past the newest entry can restore it.
   - **Back** (older): from draft, stashes the draft and loads the newest entry;
     otherwise moves one step older. Disabled when history is empty or at the
     oldest entry.
   - **Forward** (newer): moves one step newer; past the newest entry clears the
     cursor and restores the stashed draft. Disabled while on the live draft.
   - Navigation updates the textarea via the existing controlled
     `onComposeTextChange` callback (parent-owned `composeText`).
   - Typing in the textarea resets `historyIndex` to `null` (edits become the new
     draft).
   - Opening the composer (`view` becomes `"compose"`) resets `historyIndex` to
     `null`.
   - Two `@fluentui/react-icons` buttons (`ChevronLeft24Regular` /
     `ChevronRight24Regular`) added to the existing `composeActions` row, with
     `aria-label`s ("Previous compose entry" / "Next compose entry") and text
     labels ("Back" / "Forward") shown only when `showLabels` is true, matching
     the icon-only-on-mobile pattern used elsewhere in the panel.

## Data flow

```
User types ──▶ Textarea.onChange ──▶ historyIndex=null; onComposeTextChange(value)
Back  click ──▶ goBackInHistory()  ──▶ setHistoryIndex; onComposeTextChange(entry)
Fwd   click ──▶ goForwardInHistory()──▶ setHistoryIndex/null; onComposeTextChange(entry|draft)
Insert click ─▶ onComposeInsert(text) ─▶ sendInput(text); App: addComposeEntry(history[activeId], text)
```

## Error handling / edge cases

- Empty text is never recorded and Insert stays disabled (existing behavior).
- Empty history disables Back and Forward.
- Duplicate inserts collapse to a single newest entry.
- Session with no history yet → prop defaults to `[]`.
- Reload clears everything (by design).

## Testing

- **Unit (`tests/*.test.ts`, `bun:test`):** `addComposeEntry` — appends, skips
  empty, de-duplicates (moves to newest), enforces the cap.
- **Component (`tests/terminal-panel.test.ts`):** Back/Forward buttons render
  with correct `aria-label`s; disabled states for empty history and for the
  live-draft position; labels hidden when `showLabels` is false.
- **Manual (`docs/manual-tests/`):** New feature-named manual-test doc covering
  recording on insert, Back/Forward cycling, draft restore, per-session
  isolation, and reload clearing; linked from the manual-tests README index.

## Out of scope (YAGNI)

- Persisting history across reloads or to the server.
- A shared/global history across sessions.
- A dropdown/list picker of past entries (buttons only).
- Recording cancelled (non-inserted) drafts.
