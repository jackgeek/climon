# Windows Browser Handoff Viewport Blankness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make browser handoff recovery detect a blank visible xterm viewport even when full scrollback remains nonblank.

**Architecture:** Add a dedicated visible-viewport capture beside the existing full-buffer capture. Checkpoint creation keeps using the full buffer, while the replay recovery decision reads only `term.rows` lines beginning at `buffer.active.baseY`; temporary tunnel diagnostics are removed after the regression is covered.

**Tech Stack:** React 19, TypeScript ESM, xterm.js 6, `@xterm/headless`, Bun, `bun:test`.

## Global Constraints

- Preserve full browser scrollback, styling, cursor state, and terminal modes.
- Keep normal nonblank visible daemon replay authoritative.
- Visible-viewport blankness must ignore nonblank retained scrollback above `buffer.active.baseY`.
- Do not add protocol frames, actor behavior, PTY-output classification, retries, timing delays, or dependencies.
- Keep checkpoint creation on full-buffer `captureTerminalText()`.
- Remove all temporary `[handoff-debug:*]` console output.
- Use explicit `.js` extensions for relative TypeScript imports.
- Do not change or test the legacy session engine.

---

## File Structure

- Modify `src/web/components/TerminalView.tsx`: add the visible-viewport capture and use it only for the handoff restore decision; remove temporary diagnostics.
- Modify `tests/terminal-view.test.ts`: prove scrollback can remain nonblank while the viewport is blank, and prove production wiring uses the viewport helper only at replay decision time.
- Modify `docs/superpowers/plans/2026-07-21-windows-browser-handoff-replay.md`: record the corrected helper in the original integration task so the executed plan matches the approved design.

---

### Task 1: Detect visible viewport blankness

**Files:**
- Modify: `src/web/components/TerminalView.tsx:112-154,952-1025`
- Modify: `tests/terminal-view.test.ts:8-30,365-379`
- Modify: `docs/superpowers/plans/2026-07-21-windows-browser-handoff-replay.md`

**Interfaces:**
- Produces: `captureTerminalViewportText(term: ViewportCapturableTerminal | null): string`
- Preserves: `captureTerminalText(term: CapturableTerminal | null): string` as the full-buffer capture used for checkpoints and copy/select behavior.
- Consumes: `buffer.active.baseY`, `term.rows`, and `buffer.active.getLine(index)`.

- [ ] **Step 1: Write the failing viewport regression tests**

Add `captureTerminalViewportText` to the imports from `TerminalView.js` in
`tests/terminal-view.test.ts`.

Add the captured Windows erase sequence near the existing test helper:

```ts
const WINDOWS_RESIZE_ERASE_ONLY =
  `\x1b[?25l${"\x1b[K\r\n".repeat(55)}\x1b[K\x1b[H\x1b[?25h`;
```

Add these tests beside the existing `captureTerminalText` tests:

```ts
test("distinguishes a blank visible viewport from retained scrollback", async () => {
  const term = new Terminal({ cols: 20, rows: 4, scrollback: 100, allowProposedApi: true });
  await writeTerminal(term, "old1\r\nold2\r\nold3\r\nold4\r\nold5");
  expect(captureTerminalViewportText(term)).toContain("old5");
  await writeTerminal(term, WINDOWS_RESIZE_ERASE_ONLY);

  expect(captureTerminalText(term)).toContain("old1");
  expect(captureTerminalViewportText(term).trim()).toBe("");
  term.dispose();
});

test("uses full-buffer capture for the checkpoint and viewport capture for restore decisions", () => {
  const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");
  const checkpointStart = source.indexOf("createHandoffReplayCheckpoint(");
  const decisionStart = source.indexOf("shouldRestoreHandoffReplayCheckpoint({");

  expect(source.slice(checkpointStart, decisionStart)).toContain("captureTerminalText(term)");
  expect(source.slice(decisionStart)).toContain("currentText: captureTerminalViewportText(term)");
  expect(source).not.toContain("[handoff-debug:");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
Set-Location 'C:\git\climon\.worktrees\fix-windows-browser-handoff-replay'
bun test tests/terminal-view.test.ts
```

Expected: FAIL because `captureTerminalViewportText` is not exported, the
decision still uses full-buffer text, and temporary diagnostics remain.

- [ ] **Step 3: Implement the dedicated viewport capture**

Replace the terminal capture interfaces/helpers in
`src/web/components/TerminalView.tsx` with:

```ts
interface CapturableTerminal {
  buffer: {
    active: {
      length: number;
      getLine: (index: number) => { translateToString: (trimRight?: boolean) => string } | undefined;
    };
  };
}

interface ViewportCapturableTerminal extends CapturableTerminal {
  rows: number;
  buffer: {
    active: CapturableTerminal["buffer"]["active"] & {
      baseY: number;
    };
  };
}

function joinCapturedTerminalLines(lines: string[]): string {
  while (lines.length > 0 && lines[lines.length - 1].length === 0) {
    lines.pop();
  }
  return lines.join("\n");
}

export function captureTerminalText(term: CapturableTerminal | null): string {
  if (!term) {
    return "";
  }
  const buffer = term.buffer.active;
  const lines = Array.from(
    { length: buffer.length },
    (_, index) => buffer.getLine(index)?.translateToString(true) ?? ""
  );
  return joinCapturedTerminalLines(lines);
}

export function captureTerminalViewportText(term: ViewportCapturableTerminal | null): string {
  if (!term) {
    return "";
  }
  const buffer = term.buffer.active;
  const lines = Array.from(
    { length: term.rows },
    (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ""
  );
  return joinCapturedTerminalLines(lines);
}
```

- [ ] **Step 4: Use viewport text only for the recovery decision**

In the replay branch, remove:

```ts
const currentText = captureTerminalText(term);
```

and pass the viewport capture directly:

```ts
const restoreCheckpoint = shouldRestoreHandoffReplayCheckpoint({
  checkpoint: handoffCheckpoint,
  currentAttachmentGeneration: attachmentGenerationRef.current,
  replayRequested,
  currentText: captureTerminalViewportText(term)
});
```

Keep checkpoint creation unchanged:

```ts
createHandoffReplayCheckpoint(
  attachmentGeneration,
  serializer.serialize(),
  captureTerminalText(term),
  term.cols,
  term.rows
)
```

- [ ] **Step 5: Remove temporary tunnel diagnostics**

Delete both complete `console.error` blocks beginning with:

```ts
console.error("[handoff-debug:capture]"
```

and:

```ts
console.error("[handoff-debug:replay]"
```

No handoff diagnostics remain in production code.

- [ ] **Step 6: Correct the original implementation plan**

In `docs/superpowers/plans/2026-07-21-windows-browser-handoff-replay.md`,
change the replay decision sample from:

```ts
currentText: captureTerminalText(term)
```

to:

```ts
currentText: captureTerminalViewportText(term)
```

Add `captureTerminalViewportText` to Task 2's consumed interfaces and state
that it reads only the visible viewport while checkpoint creation keeps the
full-buffer capture.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
bun test tests/handoff-replay.test.ts tests/terminal-view.test.ts tests/terminal-replay.test.ts
```

Expected: all tests pass.

- [ ] **Step 8: Run typecheck, lint, and web build**

Run:

```powershell
bun run lint
bun run build:web
git --no-pager diff --check
```

Expected: lint/typecheck/messages pass, the web bundle builds, and the diff
check reports no errors.

- [ ] **Step 9: Commit the viewport correction**

```powershell
git add src/web/components/TerminalView.tsx tests/terminal-view.test.ts docs/superpowers/plans/2026-07-21-windows-browser-handoff-replay.md
git commit -m "fix(web): detect blank handoff viewport" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Re-run tunnel and Windows evidence gates

**Files:**
- Modify: `docs/manual-tests/results/windows.md`

**Interfaces:**
- Consumes: `captureTerminalViewportText()` from Task 1 and the existing
  serialized handoff checkpoint path.
- Produces: exact-candidate DAR-03/TCH-14 evidence only after the tunnel and
  attached-console checks pass.

- [ ] **Step 1: Rebuild the exact release candidate**

Run:

```powershell
Set-Location 'C:\git\climon\.worktrees\fix-windows-browser-handoff-replay\rust'
cargo build --release -p climon-cli
Get-FileHash '.\target\release\climon.exe' -Algorithm SHA256
```

Expected: release build succeeds and prints the replacement candidate hash.

- [ ] **Step 2: Restart the source dashboard and reopen Tunnel Link**

Run the dashboard from the worktree with the isolated release-gate
`CLIMON_HOME`, then use **Menu → Tunnel Link → Open link**. Use the tunnel
dashboard as the PWA surface.

Expected: both local and tunnel dashboards show the same fresh actor session.

- [ ] **Step 3: Repeat dashboard-to-tunnel handoff without fresh output**

Create colored output and a recognizable marker in the local dashboard, let
the tunnel dashboard take control, and do not type after the transfer.

Expected: the tunnel dashboard immediately shows the marker and prior output;
its DevTools console contains no `[handoff-debug:*]` messages.

- [ ] **Step 4: Repeat tunnel-to-dashboard handoff and scrollback**

Write one marker from the tunnel controller, take control back locally without
new output, then scroll upward and back to the bottom.

Expected: local content restores immediately, retained history is scrollable,
and the tunnel marker remains at the bottom.

- [ ] **Step 5: Repeat attached-console reclaim**

Start an attached actor session from the exact candidate in Windows Terminal.
Take control in a dashboard, type a non-Space key locally, then press Space.

Expected: the non-Space key is swallowed, Space restores the local terminal,
and the dashboard becomes displaced.

- [ ] **Step 6: Record and commit evidence**

Update the DAR-03 row in `docs/manual-tests/results/windows.md` with the date,
commit, exact SHA-256, session IDs, tunnel handoff evidence, retained-scrollback
result, displaced-input result, and Space-reclaim result.

Run:

```powershell
git add docs/manual-tests/results/windows.md
git commit -m "docs: record Windows browser handoff pass" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
