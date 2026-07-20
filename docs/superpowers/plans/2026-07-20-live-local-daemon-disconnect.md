# Live Local Daemon Disconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark a live local session `disconnected` when its dashboard daemon bridge proves unreachable, without overwriting terminal outcomes or changing remote reconnection.

**Architecture:** Add a dependency-injected reconciliation helper in the dashboard server that re-reads metadata, probes the current socket, and applies a queued current-state patch only if the same local session socket is still live. Route daemon-side WebSocket failures through a small lifecycle object that deduplicates `error`/`close`, closes the browser socket, logs reconciliation failures, and keeps browser-initiated close separate.

**Tech Stack:** Bun, TypeScript ESM, `bun:test`, Node socket APIs, climon metadata store, catalogued `logMsg` logging.

## Global Constraints

- Apply the new reconciliation only to local sessions; `origin: "remote"` remains owned by the ingest/uplink lifecycle.
- Preserve remote automatic recovery under the same namespaced session ID.
- Preserve concurrent `completed` and `failed` metadata transitions.
- Browser-initiated WebSocket close must not be treated as daemon death.
- Use strict TDD and run the focused failing test before implementation.
- Keep the legacy/actor engine boundary unchanged.
- Do not merge this branch.

---

## File Structure

- Modify `src/server/server.ts`: define the local reconciliation helper and attach-bridge lifecycle, then wire them into the existing WebSocket bridge.
- Modify `tests/server-remote.test.ts`: add focused unit tests for reconciliation, race safety, remote exclusion, event deduplication, browser-close behavior, and error reporting.
- Modify `src/i18n/messages.en.json`: catalogue the warning emitted when reconciliation fails.

No new production file is needed: the behavior is server-specific, and the existing `src/server/server.ts` already owns socket probing, startup stale-session cleanup, and browser-to-daemon attachment.

### Task 1: Reconcile a Dead Live Local Session Safely

**Files:**
- Modify: `src/server/server.ts:31-33,857-915`
- Test: `tests/server-remote.test.ts:1-14,195-212,273-298`

**Interfaces:**
- Consumes: `readSessionMeta(id)`, `probeSocket(socketPath)`, and `patchSessionMetaFromCurrent(id, updateCurrent)`.
- Produces: `reconcileLiveLocalDaemonDisconnect(sessionId: string, deps?: LiveLocalDisconnectDeps): Promise<void>`.

- [ ] **Step 1: Write failing reconciliation tests**

Add `reconcileLiveLocalDaemonDisconnect` to the exports destructured from `serverModule`, then add this suite after `shouldMarkDisconnected`:

```ts
describe("reconcileLiveLocalDaemonDisconnect", () => {
  test("marks an unreachable live local session disconnected", async () => {
    const initial = meta({ id: "local-live", origin: "local", socketPath: "tcp://127.0.0.1:4001" });
    let patchResult: Partial<SessionMeta> | undefined;

    await reconcileLiveLocalDaemonDisconnect(initial.id, {
      readSession: async () => initial,
      probe: async () => false,
      patchFromCurrent: async (_id, updateCurrent) => {
        patchResult = updateCurrent(initial);
        return patchResult ? { ...initial, ...patchResult } : initial;
      }
    });

    expect(patchResult).toEqual({
      status: "disconnected",
      priorityReason: "disconnected"
    });
  });

  test("leaves a live local session unchanged when its current socket responds", async () => {
    const initial = meta({ origin: "local" });
    let patchCalls = 0;

    await reconcileLiveLocalDaemonDisconnect(initial.id, {
      readSession: async () => initial,
      probe: async () => true,
      patchFromCurrent: async () => {
        patchCalls++;
        return initial;
      }
    });

    expect(patchCalls).toBe(0);
  });

  test("preserves a concurrent terminal transition and replacement socket", async () => {
    const initial = meta({ origin: "local", socketPath: "tcp://127.0.0.1:4001" });
    const currentStates = [
      meta({ status: "completed", priorityReason: "completed", socketPath: initial.socketPath }),
      meta({ status: "failed", priorityReason: "failed", socketPath: initial.socketPath }),
      meta({ status: "running", priorityReason: "running", socketPath: "tcp://127.0.0.1:4002" })
    ];
    const patches: Array<Partial<SessionMeta> | undefined> = [];

    for (const current of currentStates) {
      await reconcileLiveLocalDaemonDisconnect(initial.id, {
        readSession: async () => initial,
        probe: async () => false,
        patchFromCurrent: async (_id, updateCurrent) => {
          patches.push(updateCurrent(current));
          return current;
        }
      });
    }

    expect(patches).toEqual([undefined, undefined, undefined]);
  });

  test("does not probe or patch remote sessions", async () => {
    const remote = meta({ origin: "remote" });
    let probed = false;
    let patched = false;

    await reconcileLiveLocalDaemonDisconnect(remote.id, {
      readSession: async () => remote,
      probe: async () => {
        probed = true;
        return false;
      },
      patchFromCurrent: async () => {
        patched = true;
        return remote;
      }
    });

    expect(probed).toBe(false);
    expect(patched).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```powershell
Set-Location C:\git\climon
bun test tests/server-remote.test.ts -t "reconcileLiveLocalDaemonDisconnect"
```

Expected: FAIL because `reconcileLiveLocalDaemonDisconnect` is not exported.

- [ ] **Step 3: Add the queued current-state reconciliation helper**

Add `patchSessionMetaFromCurrent` to the `../store.js` import and
`SessionMetaPatch` to the type import from `../types.js`. Define the dependency
interface and helper beside `shouldMarkDisconnected`:

```ts
const LIVE_SESSION_STATUSES = new Set<SessionStatus>([
  "running",
  "acknowledged",
  "needs-attention",
  "paused"
]);

function isLiveLocalSession(session: SessionMeta): boolean {
  // Older local metadata may omit origin; only the explicit remote marker is excluded.
  return session.origin !== "remote" && LIVE_SESSION_STATUSES.has(session.status);
}

interface LiveLocalDisconnectDeps {
  readSession: (id: string) => Promise<SessionMeta | undefined>;
  probe: (socketPath: string) => Promise<boolean>;
  patchFromCurrent: (
    id: string,
    updateCurrent: (current: SessionMeta) => SessionMetaPatch | undefined
  ) => Promise<SessionMeta | undefined>;
}

const liveLocalDisconnectDeps: LiveLocalDisconnectDeps = {
  readSession: readSessionMeta,
  probe: probeSocket,
  patchFromCurrent: patchSessionMetaFromCurrent
};

export async function reconcileLiveLocalDaemonDisconnect(
  sessionId: string,
  deps: LiveLocalDisconnectDeps = liveLocalDisconnectDeps
): Promise<void> {
  const observed = await deps.readSession(sessionId);
  if (!observed || !isLiveLocalSession(observed)) {
    return;
  }
  if (await deps.probe(observed.socketPath)) {
    return;
  }
  await deps.patchFromCurrent(sessionId, (current) => {
    if (!isLiveLocalSession(current) || current.socketPath !== observed.socketPath) {
      return undefined;
    }
    return {
      status: "disconnected",
      priorityReason: "disconnected"
    };
  });
}
```

Refactor `shouldMarkDisconnected` to use `LIVE_SESSION_STATUSES.has(session.status)` for its initial status check while preserving its existing PID/socket behavior and remote early return.

- [ ] **Step 4: Run the focused reconciliation and startup-cleanup tests**

Run:

```powershell
Set-Location C:\git\climon
bun test tests/server-remote.test.ts -t "reconcileLiveLocalDaemonDisconnect|shouldMarkDisconnected"
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit the reconciliation helper**

```powershell
Set-Location C:\git\climon
git add -- src/server/server.ts tests/server-remote.test.ts
git commit -m "fix(server): reconcile dead local daemon sessions" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Route Daemon Bridge Failures Through a Deduplicated Lifecycle

**Files:**
- Modify: `src/server/server.ts:85-88,2147-2219`
- Modify: `src/i18n/messages.en.json:582-620`
- Test: `tests/server-remote.test.ts`

**Interfaces:**
- Consumes: `reconcileLiveLocalDaemonDisconnect(sessionId)`, `ServerWebSocket.close()`, and `Socket.destroy()`.
- Produces: `createAttachBridgeLifecycle(options): AttachBridgeLifecycle`, with `daemonFailed(): void` and `browserClosed(): void`.

- [ ] **Step 1: Write failing lifecycle tests**

Add `createAttachBridgeLifecycle` to the exports destructured from `serverModule`, then add:

```ts
describe("createAttachBridgeLifecycle", () => {
  test("deduplicates daemon error and close while closing the browser", async () => {
    let browserCloses = 0;
    let reconciles = 0;
    const lifecycle = createAttachBridgeLifecycle({
      sessionId: "local-live",
      closeBrowser: () => browserCloses++,
      destroyDaemon: () => {},
      reconcile: async () => {
        reconciles++;
      },
      reportFailure: () => {}
    });

    lifecycle.daemonFailed();
    lifecycle.daemonFailed();
    await Promise.resolve();

    expect(browserCloses).toBe(1);
    expect(reconciles).toBe(1);
  });

  test("browser close only destroys its daemon bridge", async () => {
    let browserCloses = 0;
    let daemonDestroys = 0;
    let reconciles = 0;
    let lifecycle: ReturnType<typeof createAttachBridgeLifecycle>;
    lifecycle = createAttachBridgeLifecycle({
      sessionId: "local-live",
      closeBrowser: () => browserCloses++,
      destroyDaemon: () => {
        daemonDestroys++;
        lifecycle.daemonFailed();
      },
      reconcile: async () => {
        reconciles++;
      },
      reportFailure: () => {}
    });

    lifecycle.browserClosed();
    await Promise.resolve();

    expect(daemonDestroys).toBe(1);
    expect(browserCloses).toBe(0);
    expect(reconciles).toBe(0);
  });

  test("reports reconciliation rejection once", async () => {
    const failure = new Error("metadata write failed");
    const reported: unknown[] = [];
    const lifecycle = createAttachBridgeLifecycle({
      sessionId: "local-live",
      closeBrowser: () => {},
      destroyDaemon: () => {},
      reconcile: async () => {
        throw failure;
      },
      reportFailure: (error) => reported.push(error)
    });

    lifecycle.daemonFailed();
    await Promise.resolve();
    await Promise.resolve();

    expect(reported).toEqual([failure]);
  });
});
```

- [ ] **Step 2: Run lifecycle tests to verify they fail**

Run:

```powershell
Set-Location C:\git\climon
bun test tests/server-remote.test.ts -t "createAttachBridgeLifecycle"
```

Expected: FAIL because `createAttachBridgeLifecycle` is not exported.

- [ ] **Step 3: Implement the lifecycle and catalogue its warning**

Add `AttachBridgeLifecycle` and `AttachBridgeLifecycleOptions` near the existing
`WsData` interface. Update that existing `WsData` definition by adding the two
optional fields shown below; do not insert a second `WsData` declaration:

```ts
interface AttachBridgeLifecycle {
  daemonFailed(): void;
  browserClosed(): void;
}

interface AttachBridgeLifecycleOptions {
  sessionId: string;
  closeBrowser: () => void;
  destroyDaemon: () => void;
  reconcile: (sessionId: string) => Promise<void>;
  reportFailure: (error: unknown) => void;
}

export function createAttachBridgeLifecycle(
  options: AttachBridgeLifecycleOptions
): AttachBridgeLifecycle {
  let daemonFailureHandled = false;
  return {
    daemonFailed() {
      if (daemonFailureHandled) {
        return;
      }
      daemonFailureHandled = true;
      options.closeBrowser();
      void options.reconcile(options.sessionId).catch(options.reportFailure);
    },
    browserClosed() {
      daemonFailureHandled = true;
      options.destroyDaemon();
    }
  };
}

interface WsData {
  sessionId: string;
  socketPath: string;
  daemon?: Socket;
  bridgeLifecycle?: AttachBridgeLifecycle;
}
```

Add this message entry in `src/i18n/messages.en.json` with the other `server.*` entries:

```json
"server.live_daemon_disconnect_reconcile_failed": {
  "id": "7ad3cf10",
  "t": "failed to reconcile disconnected local session {sessionId}: {error}",
  "hint": "Warning when a failed dashboard-to-daemon socket cannot be reconciled into disconnected metadata; {sessionId} identifies the local session and {error} is the read, probe, or patch failure.",
  "params": {
    "sessionId": {
      "redact": false,
      "category": "generic"
    },
    "error": {
      "redact": true,
      "category": "diagnostic"
    }
  }
}
```

- [ ] **Step 4: Wire the lifecycle into the WebSocket bridge**

In `websocket.open`, insert the lifecycle immediately after
`const decoder = new FrameDecoder();`:

```ts
const bridgeLifecycle = createAttachBridgeLifecycle({
  sessionId: ws.data.sessionId,
  closeBrowser: () => ws.close(),
  destroyDaemon: () => daemon.destroy(),
  reconcile: reconcileLiveLocalDaemonDisconnect,
  reportFailure: (error) => {
    logMsg(getLogger(), "warn", "server.live_daemon_disconnect_reconcile_failed", {
      sessionId: ws.data.sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
ws.data.daemon = daemon;
ws.data.bridgeLifecycle = bridgeLifecycle;
```

Remove:

```ts
(ws.data as WsData & { daemon?: Socket }).daemon = daemon;
```

Replace the two daemon failure listeners:

```ts
daemon.on("error", bridgeLifecycle.daemonFailed);
daemon.on("close", bridgeLifecycle.daemonFailed);
```

In `websocket.message`, replace:

```ts
const daemon = (ws.data as WsData & { daemon?: Socket }).daemon;
```

with:

```ts
const daemon = ws.data.daemon;
```

Replace the complete `websocket.close` body with:

```ts
close(ws: ServerWebSocket<WsData>) {
  ws.data.bridgeLifecycle?.browserClosed();
}
```

Do not call `reconcileLiveLocalDaemonDisconnect` from `websocket.close`; that callback represents the browser side closing and must remain a detach-only path.

- [ ] **Step 5: Run the lifecycle tests and message catalogue check**

Run:

```powershell
Set-Location C:\git\climon
bun test tests/server-remote.test.ts -t "createAttachBridgeLifecycle|reconcileLiveLocalDaemonDisconnect|shouldMarkDisconnected"
bun run messages:check
```

Expected: selected tests PASS and the message catalogue check exits 0.

- [ ] **Step 6: Run the complete affected test file and typecheck**

Run:

```powershell
Set-Location C:\git\climon
bun test tests/server-remote.test.ts
bun run typecheck
```

Expected: `tests/server-remote.test.ts` passes and TypeScript reports no errors.

- [ ] **Step 7: Commit the bridge lifecycle**

```powershell
Set-Location C:\git\climon
git add -- src/server/server.ts src/i18n/messages.en.json tests/server-remote.test.ts
git commit -m "fix(server): persist live daemon bridge loss" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Verify DAR-09 Against the Actor Candidate

**Files:**
- Reference: `docs/superpowers/handoffs/2026-07-19-windows-daemon-actor-release-gate.md:478-516`
- Inspect: `$env:CLIMON_HOME\sessions\$Dar09.json`

**Interfaces:**
- Consumes: the source dashboard containing Tasks 1-2 and actor client `C:\Users\jackallan\AppData\Local\Temp\climon-dar-candidates\actor-win32-space-final\climon.exe`.
- Produces: physical Windows evidence that forced host death changes the card to `disconnected` and stops terminal reconnects.

- [ ] **Step 1: Restart only the isolated dashboard on the changed server source**

Stop dashboard PID `6236` only if it is still the process serving port `3135`. Start `bun src/server.ts server --port 3135` from `C:\git\climon` with:

```powershell
$env:CLIMON_HOME = "C:\Users\jackallan\AppData\Local\Temp\climon-dar-trace-4542855f-20260720"
$env:CLIMON_SESSION_ENGINE = "actor"
bun C:\git\climon\src\server.ts server --port 3135
```

Expected: `http://127.0.0.1:3135/health` returns an OK health response. Do not stop the unrelated server on port `3131`.

- [ ] **Step 2: Start a fresh headless actor session**

In the interactive Windows Terminal where the handoff helper functions are loaded:

```powershell
$Climon = "C:\Users\jackallan\AppData\Local\Temp\climon-dar-candidates\actor-win32-space-final\climon.exe"
$env:CLIMON_SESSION_ENGINE = "actor"
& $Climon run --headless powershell.exe -NoProfile -Command 'Start-Sleep 300'
$Dar09 = (Get-LatestSessionMetadata).id
$Hosts = @(Get-SessionHost $Dar09)
$Hosts | Select-Object ProcessId, ParentProcessId, CommandLine
if ($Hosts.Count -ne 1) {
  throw "Expected exactly one daemon host for $Dar09; found $($Hosts.Count)"
}
```

Expected: exactly one `climon __session $Dar09` host is listed.

- [ ] **Step 3: Open the session and force-terminate its host**

Use Playwright MCP against `http://127.0.0.1:3135/` to open the `$Dar09` terminal and confirm it is attached. Then run:

```powershell
Stop-Process -Id $Hosts[0].ProcessId -Force
```

Expected: this performs Windows `TerminateProcess`; it is not graceful shutdown.

- [ ] **Step 4: Verify durable dashboard disconnection**

Use Playwright MCP to confirm:

- The `$Dar09` card changes to `disconnected`.
- The already-open terminal no longer appears connected or interactive.
- The browser does not continue a live WebSocket reconnect loop.

Read the metadata:

```powershell
$Dar09Meta = Join-Path $env:CLIMON_HOME "sessions\$Dar09.json"
Get-Content $Dar09Meta -Raw | ConvertFrom-Json |
  Select-Object id, status, priorityReason, socketPath
```

Expected: `status` and `priorityReason` are both `disconnected`.

- [ ] **Step 5: Reconcile the intentionally forced session**

```powershell
& $Climon kill $Dar09
```

Expected: the stale forced-kill record is reconciled according to the existing command behavior.

- [ ] **Step 6: Run final focused automated verification**

```powershell
Set-Location C:\git\climon
bun test tests/server-remote.test.ts
bun run lint
git --no-pager status --short
```

Expected: tests and lint pass. The working tree is clean unless the DAR evidence intentionally produced an uncommitted report update; report updates remain deferred until the final same-candidate DAR-01 through DAR-10 sweep.
