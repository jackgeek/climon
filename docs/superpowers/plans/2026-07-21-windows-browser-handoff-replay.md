# Windows Browser Handoff Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a dashboard or PWA terminal's full xterm state when Windows ConPTY's erase-only resize repaint would otherwise make a control handoff replay blank.

**Architecture:** The browser captures a generation-scoped xterm serialization and its source grid immediately before a displaced-to-controlling refit. At the existing replay boundary, a pure decision helper chooses the serialized checkpoint only when the checkpoint was nonblank, belongs to the current attachment, and the post-resize terminal is blank; recovery restores at the source grid before resizing xterm back to the winning viewport, while every other replay follows the existing daemon path.

**Tech Stack:** React 19, TypeScript ESM, xterm.js 6, `@xterm/addon-serialize` 0.14, Bun, `bun:test`, `@xterm/headless`.

## Global Constraints

- Preserve full browser scrollback, styling, cursor state, and terminal modes.
- Keep normal nonblank daemon replay authoritative.
- Do not add protocol frames, actor behavior, PTY-output classification, retries, or timing delays.
- Restore serialized xterm state at its captured columns/rows, then resize to the winning viewport in the write callback.
- Scope checkpoints to one attachment generation and clear them on replay completion, disconnect, reconnect, session change, and exit.
- Use explicit `.js` extensions for relative TypeScript imports.
- Do not change or test the legacy session engine.

---

## File Structure

- Create `src/web/handoff-replay.ts`: pure checkpoint creation and recovery-decision helpers; no React or WebSocket dependencies.
- Create `tests/handoff-replay.test.ts`: focused unit/headless-xterm coverage for the ConPTY erase-only regression and checkpoint decisions.
- Modify `src/web/components/TerminalView.tsx`: load the serialize addon, capture/consume checkpoints, and clear lifecycle state.
- Modify `tests/terminal-view.test.ts`: assert live component wiring and addon registration without introducing a browser test runner.
- Modify `package.json` and `bun.lock`: add the xterm-compatible serialize addon.
- Modify `docs/manual-tests/terminal-control-handoff.md`: add the Windows dashboard/PWA handoff regression case.

---

### Task 1: Build the handoff checkpoint primitive

**Files:**
- Create: `src/web/handoff-replay.ts`
- Create: `tests/handoff-replay.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces:
  - `HandoffReplayCheckpoint`
  - `createHandoffReplayCheckpoint(attachmentGeneration: number, serialized: string, capturedText: string, cols: number, rows: number): HandoffReplayCheckpoint`
  - `shouldRestoreHandoffReplayCheckpoint(args: HandoffReplayDecision): boolean`
- Consumes: xterm serialization strings from `SerializeAddon.serialize()` and plain terminal text from `captureTerminalText()`.

- [ ] **Step 1: Add the serialize addon dependency**

Run:

```powershell
Set-Location 'C:\git\climon\.worktrees\fix-windows-browser-handoff-replay'
bun add '@xterm/addon-serialize@^0.14.0'
```

Expected: `package.json` and `bun.lock` add `@xterm/addon-serialize` at the xterm 6-compatible `^0.14.0` range.

- [ ] **Step 2: Write the failing checkpoint and ConPTY regression tests**

Create `tests/handoff-replay.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import xterm from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  createHandoffReplayCheckpoint,
  shouldRestoreHandoffReplayCheckpoint
} from "../src/web/handoff-replay.js";

const { Terminal } = xterm;

const WINDOWS_RESIZE_ERASE_ONLY =
  `\x1b[?25l${"\x1b[K\r\n".repeat(55)}\x1b[K\x1b[H\x1b[?25h`;

function writeTerminal(term: InstanceType<typeof Terminal>, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function terminalText(term: InstanceType<typeof Terminal>): string {
  const lines = Array.from({ length: term.buffer.active.length }, (_, index) =>
    term.buffer.active.getLine(index)?.translateToString(true) ?? ""
  );
  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.join("\n");
}

describe("browser handoff replay checkpoint", () => {
  test("restores full styled scrollback after the Windows erase-only resize repaint", async () => {
    const term = new Terminal({ cols: 20, rows: 4, scrollback: 100, allowProposedApi: true });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    await writeTerminal(term, "\x1b[31mold1\x1b[0m\r\nold2\r\nold3\r\nold4\r\nold5");
    const checkpoint = createHandoffReplayCheckpoint(
      7,
      serializer.serialize(),
      terminalText(term),
      term.cols,
      term.rows
    );

    term.resize(30, 6);
    const targetSize = { cols: term.cols, rows: term.rows };
    await writeTerminal(term, WINDOWS_RESIZE_ERASE_ONLY);
    expect(terminalText(term).trim()).toBe("");
    expect(
      shouldRestoreHandoffReplayCheckpoint({
        checkpoint,
        currentAttachmentGeneration: 7,
        replayRequested: true,
        currentText: terminalText(term)
      })
    ).toBe(true);

    term.resize(checkpoint.cols, checkpoint.rows);
    term.reset();
    await writeTerminal(term, checkpoint.serialized);
    term.resize(targetSize.cols, targetSize.rows);

    expect(terminalText(term)).toContain("old1");
    expect(terminalText(term)).toContain("old5");
    expect([term.cols, term.rows]).toEqual([30, 6]);
    expect(checkpoint.serialized).toContain("\x1b[31m");
    term.dispose();
  });

  test("keeps a nonblank post-resize terminal authoritative", () => {
    const checkpoint = createHandoffReplayCheckpoint(2, "serialized", "before", 80, 24);

    expect(
      shouldRestoreHandoffReplayCheckpoint({
        checkpoint,
        currentAttachmentGeneration: 2,
        replayRequested: true,
        currentText: "new authoritative output"
      })
    ).toBe(false);
  });

  test("does not restore a blank checkpoint", () => {
    const checkpoint = createHandoffReplayCheckpoint(2, "serialized", " \r\n\t", 80, 24);

    expect(
      shouldRestoreHandoffReplayCheckpoint({
        checkpoint,
        currentAttachmentGeneration: 2,
        replayRequested: true,
        currentText: ""
      })
    ).toBe(false);
  });

  test("rejects stale generations and non-replay binary frames", () => {
    const checkpoint = createHandoffReplayCheckpoint(2, "serialized", "before", 80, 24);

    expect(
      shouldRestoreHandoffReplayCheckpoint({
        checkpoint,
        currentAttachmentGeneration: 3,
        replayRequested: true,
        currentText: ""
      })
    ).toBe(false);
    expect(
      shouldRestoreHandoffReplayCheckpoint({
        checkpoint,
        currentAttachmentGeneration: 2,
        replayRequested: false,
        currentText: ""
      })
    ).toBe(false);
  });
});
```

- [ ] **Step 3: Run the new test to verify it fails**

Run:

```powershell
bun test tests/handoff-replay.test.ts
```

Expected: FAIL because `src/web/handoff-replay.ts` does not exist.

- [ ] **Step 4: Implement the pure checkpoint helper**

Create `src/web/handoff-replay.ts`:

```ts
export interface HandoffReplayCheckpoint {
  attachmentGeneration: number;
  serialized: string;
  cols: number;
  rows: number;
  hadVisibleContent: boolean;
}

export interface HandoffReplayDecision {
  checkpoint: HandoffReplayCheckpoint | null;
  currentAttachmentGeneration: number;
  replayRequested: boolean;
  currentText: string;
}

export function createHandoffReplayCheckpoint(
  attachmentGeneration: number,
  serialized: string,
  capturedText: string,
  cols: number,
  rows: number
): HandoffReplayCheckpoint {
  return {
    attachmentGeneration,
    serialized,
    cols,
    rows,
    hadVisibleContent: /\S/.test(capturedText)
  };
}

export function shouldRestoreHandoffReplayCheckpoint({
  checkpoint,
  currentAttachmentGeneration,
  replayRequested,
  currentText
}: HandoffReplayDecision): boolean {
  return (
    replayRequested &&
    checkpoint !== null &&
    checkpoint.attachmentGeneration === currentAttachmentGeneration &&
    checkpoint.hadVisibleContent &&
    !/\S/.test(currentText)
  );
}
```

- [ ] **Step 5: Run the focused test to verify it passes**

Run:

```powershell
bun test tests/handoff-replay.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 6: Commit the checkpoint primitive**

```powershell
git add package.json bun.lock src/web/handoff-replay.ts tests/handoff-replay.test.ts
git commit -m "fix(web): add handoff replay checkpoints" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Recover blank control handoffs in TerminalView

**Files:**
- Modify: `src/web/components/TerminalView.tsx:1-21,271-278,464-502,772-789,841-994,1043-1138`
- Modify: `tests/terminal-view.test.ts:1-30,107-127,163-175`

**Interfaces:**
- Consumes:
  - `createHandoffReplayCheckpoint(...)`
  - `shouldRestoreHandoffReplayCheckpoint(...)`
  - `SerializeAddon.serialize(): string`
  - `captureTerminalViewportText(term)` — visible viewport only (reads `buffer.active.baseY + rows`); used for the restore decision so retained scrollback does not mask a blank viewport
- Produces: generation-scoped handoff recovery integrated into the existing resize/replay flow.

- [ ] **Step 1: Write failing component-wiring tests**

Update the imports in `tests/terminal-view.test.ts` to include `SerializeAddon`:

```ts
import { SerializeAddon } from "@xterm/addon-serialize";
```

Replace the addon-loading test with:

```ts
test("loads fit, web link, and serialize addons", () => {
  const loaded: string[] = [];
  const fitAddon = { activate: () => {}, dispose: () => {} };
  const webLinksAddon = { activate: () => {}, dispose: () => {} };
  const serializeAddon = { activate: () => {}, dispose: () => {} };

  loadTerminalAddons(
    { loadAddon: (addon) => loaded.push(
      addon === fitAddon ? "fit" : addon === webLinksAddon ? "web-links" : "serialize"
    ) },
    fitAddon,
    webLinksAddon,
    serializeAddon
  );

  expect(loaded).toEqual(["fit", "web-links", "serialize"]);
});
```

Add these tests beside the existing mid-session replay tests:

```ts
test("captures a serialized checkpoint before a displaced controller refits", () => {
  const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

  expect(source).toContain("const serializeRef = useRef<SerializeAddon | null>(null);");
  expect(source).toContain("const handoffReplayCheckpointRef = useRef<HandoffReplayCheckpoint | null>(null);");
  expect(source).toContain(
    "createHandoffReplayCheckpoint(\n                  attachmentGeneration,\n                  serializer.serialize(),\n                  captureTerminalText(term),\n                  term.cols,\n                  term.rows\n                )"
  );
  expect(source.indexOf("serializer.serialize()")).toBeLessThan(
    source.indexOf("replayAfterNextResizeRef.current = true;")
  );
});

test("restores only a valid blank handoff replay and consumes the checkpoint", () => {
  const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

  expect(source).toContain("shouldRestoreHandoffReplayCheckpoint({");
  expect(source).toContain("currentAttachmentGeneration: attachmentGenerationRef.current");
  expect(source).toContain("currentText: captureTerminalViewportText(term)");
  expect(source).toContain("handoffReplayCheckpointRef.current = null;");
  expect(source).toContain("applyAuthoritativeTerminalSize(term, handoffCheckpoint.cols, handoffCheckpoint.rows);");
  expect(source).toContain("term.reset();\n              replayData = handoffCheckpoint.serialized;");
  expect(source).toContain("applyAuthoritativeTerminalSize(term, restoreTargetSize.cols, restoreTargetSize.rows);");
});

test("clears handoff replay state at every attachment lifecycle boundary", () => {
  const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

  expect(source.match(/clearHandoffReplayCheckpoint\(\);/g)?.length).toBeGreaterThanOrEqual(4);
  expect(source).toContain("terminalExitReceived = true;\n            clearHandoffReplayCheckpoint();");
  expect(source).toContain("disconnected = true;\n      clearHandoffReplayCheckpoint();");
  expect(source).toContain("function closeWs(): void {\n    clearHandoffReplayCheckpoint();");
});

test("constructs and retains the live serialize addon", () => {
  const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

  expect(source).toContain("const serialize = new SerializeAddon();");
  expect(source).toContain("loadTerminalAddons(term, fit, webLinks, serialize);");
  expect(source).toContain("serializeRef.current = serialize;");
  expect(source).toContain("serializeRef.current = null;");
  expect(new SerializeAddon()).toBeDefined();
});
```

- [ ] **Step 2: Run the TerminalView tests to verify they fail**

Run:

```powershell
bun test tests/terminal-view.test.ts
```

Expected: FAIL on the changed `loadTerminalAddons` signature and missing checkpoint wiring.

- [ ] **Step 3: Add imports, refs, and addon loading**

In `src/web/components/TerminalView.tsx`, add:

```ts
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  createHandoffReplayCheckpoint,
  shouldRestoreHandoffReplayCheckpoint,
  type HandoffReplayCheckpoint
} from "../handoff-replay.js";
```

Change `loadTerminalAddons` to:

```ts
export function loadTerminalAddons(
  term: Pick<Terminal, "loadAddon">,
  fit: ITerminalAddon,
  webLinks: ITerminalAddon,
  serialize: ITerminalAddon
): void {
  term.loadAddon(fit);
  term.loadAddon(webLinks);
  term.loadAddon(serialize);
}
```

Add refs beside `fitRef` and the replay refs:

```ts
const serializeRef = useRef<SerializeAddon | null>(null);
const handoffReplayCheckpointRef = useRef<HandoffReplayCheckpoint | null>(null);
```

Add the focused cleanup helper:

```ts
function clearHandoffReplayCheckpoint(): void {
  handoffReplayCheckpointRef.current = null;
}
```

Create and retain the addon with the terminal:

```ts
const serialize = new SerializeAddon();
loadTerminalAddons(term, fit, webLinks, serialize);
configureTerminalUnicode(term, new Unicode11Addon());
term.open(container);
termRef.current = term;
fitRef.current = fit;
serializeRef.current = serialize;
```

Clear the addon ref during terminal cleanup:

```ts
termRef.current = null;
fitRef.current = null;
serializeRef.current = null;
```

- [ ] **Step 4: Capture the checkpoint before the handoff refit**

Inside the `shouldRefitOnControlFrame({ state, wasDisplaced })` branch, before setting `replayAfterNextResizeRef`, add:

```ts
const serializer = serializeRef.current;
handoffReplayCheckpointRef.current = serializer
  ? createHandoffReplayCheckpoint(
      attachmentGeneration,
      serializer.serialize(),
      captureTerminalText(term),
      term.cols,
      term.rows
    )
  : null;
replayAfterNextResizeRef.current = true;
refit();
```

Use the `attachmentGeneration` captured by `attachLiveSession`; do not read a later generation into the checkpoint.

- [ ] **Step 5: Select checkpoint recovery at the replay boundary**

Replace the mid-session replay preparation with:

```ts
let replayData: string | Uint8Array = data;
let restoreTargetSize: { cols: number; rows: number } | null = null;
if (firstBinaryFrame) {
  firstBinaryFrame = false;
  if (resetBeforeReplay) {
    term.reset();
  }
} else if (replayRequested) {
  const handoffCheckpoint = handoffReplayCheckpointRef.current;
  const restoreCheckpoint = shouldRestoreHandoffReplayCheckpoint({
    checkpoint: handoffCheckpoint,
    currentAttachmentGeneration: attachmentGenerationRef.current,
    replayRequested,
   currentText: captureTerminalViewportText(term)
  });
  handoffReplayCheckpointRef.current = null;
  if (restoreCheckpoint && handoffCheckpoint) {
    restoreTargetSize = { cols: term.cols, rows: term.rows };
    applyAuthoritativeTerminalSize(term, handoffCheckpoint.cols, handoffCheckpoint.rows);
    term.reset();
    replayData = handoffCheckpoint.serialized;
  } else {
    // Ordinary mid-session replay remains daemon-authoritative.
    refreshTerminalForReplay(term);
  }
}
replayWriteInProgressRef.current = true;
term.write(replayData, () => {
  if (restoreTargetSize) {
    applyAuthoritativeTerminalSize(term, restoreTargetSize.cols, restoreTargetSize.rows);
  }
  replayWriteInProgressRef.current = false;
  completeInitialReplay(
    attachmentGeneration,
    attachmentGenerationRef.current,
    () => {
      initialReplayCompleteRef.current = true;
      reconnectAttemptRef.current = 0;
      scheduleContentReveal();
    },
    refreshActiveTerminal
  );
});
```

Do not write the discarded daemon replay after selecting the checkpoint.
The target resize must occur in the write callback so the serialized cursor
positions are parsed at the source grid before xterm reflows them.

- [ ] **Step 6: Clear checkpoints at lifecycle boundaries**

Insert `clearHandoffReplayCheckpoint();` as the first statement in `closeWs()`:

```ts
function closeWs(): void {
  clearHandoffReplayCheckpoint();
  clearReconnectTimer();
}
```

Insert it immediately after the stale-socket guard in `handleDisconnect()` so a
current attachment clears the checkpoint but a stale one returns first:

```ts
disconnected = true;
if (attachmentGeneration !== attachmentGenerationRef.current) {
  return;
}
clearHandoffReplayCheckpoint();
```

Insert it immediately after `terminalExitReceived = true;`:

```ts
terminalExitReceived = true;
clearHandoffReplayCheckpoint();
term.write(`\r\n\x1b[90m[session exited with code ${msg.exitCode}]\x1b[0m\r\n`);
```

Also clear it when a replay marker arrives without a pending resize checkpoint only by normal single-use consumption in the binary replay branch; do not clear a valid checkpoint before its binary payload.

- [ ] **Step 7: Run the focused web tests**

Run:

```powershell
bun test tests/handoff-replay.test.ts tests/terminal-view.test.ts tests/terminal-replay.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 8: Run type checking and the web build**

Run:

```powershell
bun run typecheck
bun run build:web
```

Expected: both commands exit 0.

- [ ] **Step 9: Commit the live integration**

```powershell
git add src/web/components/TerminalView.tsx tests/terminal-view.test.ts
git commit -m "fix(web): restore blank browser control handoffs" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Document and physically verify the Windows regression

**Files:**
- Modify: `docs/manual-tests/terminal-control-handoff.md`
- Later release-gate evidence only: `docs/manual-tests/results/windows.md`

**Interfaces:**
- Consumes: the completed browser checkpoint behavior from Task 2.
- Produces: repeatable TCH-14 coverage and DAR-03 evidence.

- [ ] **Step 1: Add the manual regression case**

Append to `docs/manual-tests/terminal-control-handoff.md`:

```md
## TCH-14 — Windows browser handoff survives erase-only ConPTY resize repaint

- **Feature:** a displaced dashboard/PWA serializes its full xterm state before
  taking control. If Windows ConPTY's resize response leaves the browser blank,
  the matching attachment-generation checkpoint restores the visible screen,
  scrollback, styling, cursor, and modes at the existing replay boundary.
- **Preconditions:** Windows actor candidate built from this branch; dashboard
  server restarted from the same source; one live PowerShell session; desktop
  dashboard and installed PWA both open on that session.
- **Config-matrix cell:** Windows Terminal + actor + desktop dashboard + PWA.
- **Steps:**
  1. In the managed PowerShell, produce more than one screen of colored output,
     then leave a recognizable prompt/marker visible.
  2. Take control in the desktop dashboard and scroll upward to confirm history.
  3. Take control in the PWA without typing any command after the transfer.
  4. Confirm the PWA immediately shows the prior screen; scroll upward.
  5. Take control back in the dashboard, again without producing fresh child
     output; confirm its screen and history immediately return.
  6. Type in the newest controller and confirm the displaced surface cannot type.
  7. Press Space in the local terminal to reclaim control.
- **Expected result:** every dashboard↔PWA transfer shows the prior terminal
  immediately, including full scrollback and colors, without waiting for fresh
  PowerShell output. Only the newest controller accepts input. Local Space
  reclaim restores local-size authority.
- **Platforms:** Windows Terminal + ConPTY (authoritative).
- **Result:** _(version / date / tester / pass|fail / notes)_
```

- [ ] **Step 2: Run the complete targeted automated gate**

Run:

```powershell
bun test tests/handoff-replay.test.ts tests/terminal-view.test.ts tests/terminal-replay.test.ts
bun run lint
bun run build:web
git --no-pager diff --check
```

Expected: tests pass, lint/typecheck/messages pass, web build succeeds, and `diff --check` emits no errors.

- [ ] **Step 3: Build the exact actor candidate**

Run:

```powershell
Set-Location 'C:\git\climon\.worktrees\fix-windows-browser-handoff-replay\rust'
cargo build --release -p climon-cli
Get-FileHash '.\target\release\climon.exe' -Algorithm SHA256
```

Expected: release build succeeds and prints the candidate's SHA-256 for the Windows report.

- [ ] **Step 4: Repeat DAR-03 and TCH-14 physically**

Use the exact candidate hash from Step 3 and the isolated release-gate `CLIMON_HOME`. Repeat dashboard→PWA, PWA→dashboard, displaced input swallowing, newest-controller input, and local Space reclaim without producing output between handoffs.

Expected: both browser surfaces restore immediately with full scrollback; no blank screen waits for new child output.

- [ ] **Step 5: Record evidence only after the physical pass**

Update the DAR-03 row in `docs/manual-tests/results/windows.md` with:

- candidate version and commit;
- exact SHA-256;
- session ID;
- dashboard and PWA transfer evidence;
- displaced input result;
- local Space reclaim result.

Do not claim pass if any browser requires fresh child output.

- [ ] **Step 6: Commit documentation and evidence**

```powershell
git add docs/manual-tests/terminal-control-handoff.md docs/manual-tests/results/windows.md
git commit -m "docs: cover Windows browser handoff replay" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
