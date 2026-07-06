# Compose History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-session, in-memory compose history to the dashboard composer, with Back/Forward buttons that cycle the textarea through previously inserted text.

**Architecture:** A pure helper (`src/web/composeHistory.ts`) records inserted text (dedup + cap). `App.tsx` owns the history as a per-session `Record<sessionId, string[]>` in React state (cleared on reload) and records on Insert. `TerminalPanel.tsx` gains a `composeHistory` prop plus a local navigation cursor and two Back/Forward buttons that drive the parent-controlled `composeText`.

**Tech Stack:** TypeScript ESM (explicit `.js` import extensions), React 19, Fluent UI (`@fluentui/react-components`, `@fluentui/react-icons`), Bun test runner (`bun:test`).

**Spec:** `docs/superpowers/specs/2026-07-06-compose-history-design.md`

---

### Task 1: `composeHistory` pure helper

**Files:**
- Create: `src/web/composeHistory.ts`
- Test: `tests/compose-history.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/compose-history.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { addComposeEntry, MAX_COMPOSE_HISTORY } from "../src/web/composeHistory.js";

describe("addComposeEntry", () => {
  test("appends text as the newest entry", () => {
    expect(addComposeEntry([], "one")).toEqual(["one"]);
    expect(addComposeEntry(["one"], "two")).toEqual(["one", "two"]);
  });

  test("ignores empty text", () => {
    expect(addComposeEntry(["one"], "")).toEqual(["one"]);
    expect(addComposeEntry([], "")).toEqual([]);
  });

  test("de-duplicates by moving the existing copy to newest", () => {
    expect(addComposeEntry(["one", "two", "three"], "two")).toEqual([
      "one",
      "three",
      "two"
    ]);
  });

  test("does not mutate the input array", () => {
    const history = ["one"];
    addComposeEntry(history, "two");
    expect(history).toEqual(["one"]);
  });

  test("caps to MAX_COMPOSE_HISTORY, dropping oldest first", () => {
    let history: string[] = [];
    for (let i = 0; i < MAX_COMPOSE_HISTORY + 5; i++) {
      history = addComposeEntry(history, `entry-${i}`);
    }
    expect(history.length).toBe(MAX_COMPOSE_HISTORY);
    expect(history[0]).toBe("entry-5");
    expect(history[history.length - 1]).toBe(`entry-${MAX_COMPOSE_HISTORY + 4}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/compose-history.test.ts`
Expected: FAIL — cannot resolve `../src/web/composeHistory.js` (module does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `src/web/composeHistory.ts`:

```typescript
/**
 * Upper bound on remembered compose entries per session; oldest entries are
 * dropped first. Bounds memory for long-lived dashboard tabs.
 */
export const MAX_COMPOSE_HISTORY = 50;

/**
 * Returns a new history with `text` recorded as the most recent entry (last).
 * Empty text is ignored, exact duplicates are de-duplicated (the existing copy
 * is moved to the end), and the list is capped to {@link MAX_COMPOSE_HISTORY}.
 * The input array is never mutated.
 */
export function addComposeEntry(history: string[], text: string): string[] {
  if (text.length === 0) {
    return history;
  }
  const withoutDuplicate = history.filter((entry) => entry !== text);
  withoutDuplicate.push(text);
  if (withoutDuplicate.length > MAX_COMPOSE_HISTORY) {
    return withoutDuplicate.slice(withoutDuplicate.length - MAX_COMPOSE_HISTORY);
  }
  return withoutDuplicate;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/compose-history.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/composeHistory.ts tests/compose-history.test.ts
git commit -m "feat: add compose history helper" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `TerminalPanel` Back/Forward navigation UI

**Files:**
- Modify: `src/web/components/TerminalPanel.tsx`
- Test: `tests/terminal-panel.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/terminal-panel.test.ts`, first add `composeHistory: []` to the default props object inside `renderPanel` so the new required prop is always present:

```typescript
  const props = {
    view: "compose" as TerminalPanelView,
    fontSize: 14,
    composeText: "hello world",
    composeHistory: [] as string[],
    selectionText: "",
    stripDecorations: false,
    showLabels: true,
    showSelect: false,
    onSelect: () => undefined,
    onAdjustFont: () => undefined,
    onComposeTextChange: () => undefined,
    onComposeInsert: () => undefined,
    onComposeCancel: () => undefined,
    onToggleStripDecorations: () => undefined,
    onSelectionClose: () => undefined,
    onSend: () => undefined,
    ...overrides
  };
```

Then add this `describe` block at the end of the file (before the final closing brace of the outer `describe`, or as a sibling `describe` — place it as a new top-level `describe`):

```typescript
describe("TerminalPanel compose history", () => {
  test("renders Back and Forward buttons with accessible names", () => {
    const markup = renderPanel({ composeHistory: ["prev"] });

    expect(markup).toContain('aria-label="Previous compose entry"');
    expect(markup).toContain('aria-label="Next compose entry"');
  });

  test("both history buttons are disabled when history is empty", () => {
    // composeText is non-empty so Insert is enabled; the only disabled
    // buttons are the two navigation buttons.
    const markup = renderPanel({ composeText: "hello world", composeHistory: [] });

    const disabledCount = (markup.match(/disabled=""/g) ?? []).length;
    expect(disabledCount).toBe(2);
  });

  test("Back is enabled and Forward disabled at the live draft with history", () => {
    // Initial render: historyIndex is null (live draft). With one history
    // entry, Back is enabled and only Forward is disabled.
    const markup = renderPanel({ composeText: "hello world", composeHistory: ["prev"] });

    const disabledCount = (markup.match(/disabled=""/g) ?? []).length;
    expect(disabledCount).toBe(1);
  });

  test("history buttons show text labels only when showLabels is true", () => {
    const withLabels = renderPanel({ composeHistory: ["prev"], showLabels: true });
    const withoutLabels = renderPanel({ composeHistory: ["prev"], showLabels: false });

    expect(withLabels).toContain(">Back<");
    expect(withLabels).toContain(">Forward<");
    expect(withoutLabels).not.toContain(">Back<");
    expect(withoutLabels).not.toContain(">Forward<");
  });

  test("navigation and reset handlers are wired in source", () => {
    const source = readFileSync("src/web/components/TerminalPanel.tsx", "utf8");

    expect(source).toContain("function goBackInHistory()");
    expect(source).toContain("function goForwardInHistory()");
    expect(source).toContain("onClick={() => goBackInHistory()}");
    expect(source).toContain("onClick={() => goForwardInHistory()}");
    // Typing detaches from history navigation.
    expect(source).toContain("setHistoryIndex(null)");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/terminal-panel.test.ts`
Expected: FAIL — new assertions fail (no `Previous compose entry` aria-label, `goBackInHistory` not found, disabled counts wrong).

- [ ] **Step 3: Update the icon imports**

In `src/web/components/TerminalPanel.tsx`, change the `react` import and add the two chevron icons.

Replace:

```typescript
import { Button, Checkbox, Text, Textarea, makeStyles, tokens } from "@fluentui/react-components";
import { useEffect, useRef } from "react";
import {
  ArrowEnterLeft24Regular,
  ChevronDown24Regular,
  ChevronUp24Regular,
  Compose24Regular,
  Dismiss24Regular,
  Keyboard24Regular,
  SelectAllOn24Regular,
  SelectObject24Regular,
  TextFont24Regular
} from "@fluentui/react-icons";
```

With:

```typescript
import { Button, Checkbox, Text, Textarea, makeStyles, tokens } from "@fluentui/react-components";
import { useEffect, useRef, useState } from "react";
import {
  ArrowEnterLeft24Regular,
  ChevronDown24Regular,
  ChevronLeft24Regular,
  ChevronRight24Regular,
  ChevronUp24Regular,
  Compose24Regular,
  Dismiss24Regular,
  Keyboard24Regular,
  SelectAllOn24Regular,
  SelectObject24Regular,
  TextFont24Regular
} from "@fluentui/react-icons";
```

- [ ] **Step 4: Add the `composeHistory` prop to the `Props` interface**

Replace:

```typescript
  view: TerminalPanelView;
  fontSize: number;
  composeText: string;
  selectionText: string;
```

With:

```typescript
  view: TerminalPanelView;
  fontSize: number;
  composeText: string;
  composeHistory: string[];
  selectionText: string;
```

- [ ] **Step 5: Destructure the new prop**

Replace:

```typescript
  view,
  fontSize,
  composeText,
  selectionText,
```

With:

```typescript
  view,
  fontSize,
  composeText,
  composeHistory,
  selectionText,
```

- [ ] **Step 6: Add navigation state and handlers**

Replace:

```typescript
  const styles = useStyles();
  const composeTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionTextareaRef = useRef<HTMLTextAreaElement | null>(null);
```

With:

```typescript
  const styles = useStyles();
  const composeTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // History cursor for the composer. `null` means the user is editing a fresh
  // draft (not currently browsing history); otherwise it indexes composeHistory
  // (oldest→newest). The draft is stashed so "forward" past the newest entry can
  // restore whatever the user had typed before they started browsing.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const composeDraftRef = useRef<string>("");

  // A freshly opened composer always starts detached from history.
  useEffect(() => {
    if (view === "compose") {
      setHistoryIndex(null);
    }
  }, [view]);

  function goBackInHistory(): void {
    if (composeHistory.length === 0) {
      return;
    }
    if (historyIndex === null) {
      composeDraftRef.current = composeText;
      const idx = composeHistory.length - 1;
      setHistoryIndex(idx);
      onComposeTextChange(composeHistory[idx]);
    } else if (historyIndex > 0) {
      const idx = historyIndex - 1;
      setHistoryIndex(idx);
      onComposeTextChange(composeHistory[idx]);
    }
  }

  function goForwardInHistory(): void {
    if (historyIndex === null) {
      return;
    }
    if (historyIndex < composeHistory.length - 1) {
      const idx = historyIndex + 1;
      setHistoryIndex(idx);
      onComposeTextChange(composeHistory[idx]);
    } else {
      setHistoryIndex(null);
      onComposeTextChange(composeDraftRef.current);
    }
  }
```

- [ ] **Step 7: Replace the compose render block with the history-aware version**

Replace:

```typescript
  if (view === "compose") {
    const empty = composeText.length === 0;
    return (
      <div className={styles.composeOverlay} role="group" aria-label="Compose text">
        <Textarea
          className={styles.composeTextarea}
          value={composeText}
          placeholder="Type text to insert into the terminal…"
          aria-label="Text to insert"
          autoFocus
          resize="none"
          textarea={{ ref: composeTextareaRef, style: { height: "100%" } }}
          onChange={(_e, data) => onComposeTextChange(data.value)}
        />
        <div className={styles.composeActions}>
          <Button
            appearance="outline"
            icon={<Dismiss24Regular />}
            onClick={() => onComposeCancel()}
          >
            Cancel
          </Button>
          <Button
            appearance="primary"
            icon={<ArrowEnterLeft24Regular />}
            disabled={empty}
            onClick={() => onComposeInsert(composeText)}
          >
            Insert
          </Button>
        </div>
      </div>
    );
  }
```

With:

```typescript
  if (view === "compose") {
    const empty = composeText.length === 0;
    const backDisabled = composeHistory.length === 0 || historyIndex === 0;
    const forwardDisabled = historyIndex === null;
    return (
      <div className={styles.composeOverlay} role="group" aria-label="Compose text">
        <Textarea
          className={styles.composeTextarea}
          value={composeText}
          placeholder="Type text to insert into the terminal…"
          aria-label="Text to insert"
          autoFocus
          resize="none"
          textarea={{ ref: composeTextareaRef, style: { height: "100%" } }}
          onChange={(_e, data) => {
            if (historyIndex !== null) {
              setHistoryIndex(null);
            }
            onComposeTextChange(data.value);
          }}
        />
        <div className={styles.composeActions}>
          <Button
            appearance="outline"
            icon={<ChevronLeft24Regular />}
            aria-label="Previous compose entry"
            disabled={backDisabled}
            onClick={() => goBackInHistory()}
          >
            {showLabels ? "Back" : undefined}
          </Button>
          <Button
            appearance="outline"
            icon={<ChevronRight24Regular />}
            aria-label="Next compose entry"
            disabled={forwardDisabled}
            onClick={() => goForwardInHistory()}
          >
            {showLabels ? "Forward" : undefined}
          </Button>
          <Button
            appearance="outline"
            icon={<Dismiss24Regular />}
            onClick={() => onComposeCancel()}
          >
            Cancel
          </Button>
          <Button
            appearance="primary"
            icon={<ArrowEnterLeft24Regular />}
            disabled={empty}
            onClick={() => onComposeInsert(composeText)}
          >
            Insert
          </Button>
        </div>
      </div>
    );
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test tests/terminal-panel.test.ts`
Expected: PASS — all existing tests plus the 5 new compose-history tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/web/components/TerminalPanel.tsx tests/terminal-panel.test.ts
git commit -m "feat: add Back/Forward navigation to the composer" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Wire per-session history in `App.tsx`

**Files:**
- Modify: `src/web/App.tsx`

There is no dedicated App-level test harness for this state, so this task is verified by type-check/lint (Step 4) and the manual tests in Task 4. Keep the changes minimal and exact.

- [ ] **Step 1: Import the helper**

Find the block of relative imports near the other `./` imports at the top of `src/web/App.tsx` and add this import line (place it alphabetically/near other web-module imports, e.g. after the preferences or fontSize import):

```typescript
import { addComposeEntry } from "./composeHistory.js";
```

- [ ] **Step 2: Add the per-session history state**

Find:

```typescript
  const [composeText, setComposeText] = useState("");
```

Replace with:

```typescript
  const [composeText, setComposeText] = useState("");
  const [composeHistory, setComposeHistory] = useState<Record<string, string[]>>({});
```

- [ ] **Step 3: Record history on insert and pass the prop**

Find the `TerminalPanel` usage:

```typescript
              <TerminalPanel
                view={panelView}
                fontSize={fontSize}
                composeText={composeText}
                selectionText={stripDecorations ? stripTerminalDecorations(selectionCaptureText) : selectionCaptureText}
```

Replace with:

```typescript
              <TerminalPanel
                view={panelView}
                fontSize={fontSize}
                composeText={composeText}
                composeHistory={activeId ? composeHistory[activeId] ?? [] : []}
                selectionText={stripDecorations ? stripTerminalDecorations(selectionCaptureText) : selectionCaptureText}
```

Then find:

```typescript
                onComposeInsert={(text) => {
                  terminalRef.current?.sendInput(text);
                  setComposeText("");
                  setPanelView(keyBarPinned ? "chooser" : "closed");
                }}
```

Replace with:

```typescript
                onComposeInsert={(text) => {
                  terminalRef.current?.sendInput(text);
                  if (activeId) {
                    setComposeHistory((prev) => ({
                      ...prev,
                      [activeId]: addComposeEntry(prev[activeId] ?? [], text)
                    }));
                  }
                  setComposeText("");
                  setPanelView(keyBarPinned ? "chooser" : "closed");
                }}
```

- [ ] **Step 4: Type-check and lint**

Run: `bun run typecheck`
Expected: PASS — no type errors (the `composeHistory` prop is now supplied and typed).

Run: `bun run lint`
Expected: PASS — no new lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx
git commit -m "feat: record per-session compose history and pass it to the panel" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Manual-test documentation

**Files:**
- Create: `docs/manual-tests/compose-history.md`
- Modify: `docs/manual-tests/README.md`

- [ ] **Step 1: Create the manual-test file**

Create `docs/manual-tests/compose-history.md`:

```markdown
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
```

- [ ] **Step 2: Link it from the manual-tests index**

In `docs/manual-tests/README.md`, find the row:

```markdown
| — | Text staging area — icon-only keybar chooser + full-viewport compose overlay (Insert / Cancel) | [text-staging-area.md](text-staging-area.md) |
```

Add a new row immediately after it:

```markdown
| — | Compose history — per-session in-memory recall with Back/Forward buttons in the composer | [compose-history.md](compose-history.md) |
```

- [ ] **Step 3: Commit**

```bash
git add docs/manual-tests/compose-history.md docs/manual-tests/README.md
git commit -m "docs: add compose history manual tests" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the relevant test files**

Run: `bun test tests/compose-history.test.ts tests/terminal-panel.test.ts`
Expected: PASS — all compose-history and terminal-panel tests pass.

- [ ] **Step 2: Type-check and lint the whole project**

Run: `bun run typecheck`
Expected: PASS — no type errors.

Run: `bun run lint`
Expected: PASS — no lint errors.

- [ ] **Step 3: (Optional) smoke-test in the dev server**

Run: `bun src/server.ts server`
Then open the dashboard, attach a live session, and walk through manual case CH-1.
Expected: Insert records history; Back/Forward cycle the textarea as specified.
```
