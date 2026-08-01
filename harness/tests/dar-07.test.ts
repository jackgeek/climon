import { describe, expect, test } from "bun:test";
import {
  DAR_07_SUBCHECK_NAMES,
  runDar07,
  type Dar07Context,
  type Dar07Dependencies,
  type Dar07Pty,
} from "../src/scenarios/dar-07.js";
import { SocketProbe } from "../src/drivers/socket-probe.js";
import type { SessionStatus } from "../src/session-ledger.js";

// ── Titles ─────────────────────────────────────────────────────────────────

const DAR_07_SUBCHECK_TITLES = [
  "Fast-success session finalizes with status=completed, exitCode=0, nonempty completedAt, and early marker in scrollback",
  "Fast-success daemon socket closes after finalization (TCP: connection refused; Unix: refused + file absent)",
  "Failed-exit session finalizes with status=failed, exitCode=7, nonempty completedAt, and failure marker in scrollback",
  "Failed-exit daemon socket closes after finalization (TCP: connection refused; Unix: refused + file absent)",
] as const;

// ── Test constants ─────────────────────────────────────────────────────────

const RUN_ID = "dar07run-0001-0000-0000-000000000000";

const SUCCESS_SESSION_ID = "dar-07-success-session";
const FAILURE_SESSION_ID = "dar-07-failure-session";

const SUCCESS_SOCKET = "tcp://127.0.0.1:19751";
const FAILURE_SOCKET = "tcp://127.0.0.1:19752";

// ── Fake session metadata ──────────────────────────────────────────────────

interface FakeSessionMeta extends Record<string, unknown> {
  id: string;
  name: string;
  status: SessionStatus;
  exitCode?: number;
  completedAt?: string;
  socketPath?: string;
}

interface ScenarioState {
  successMeta: FakeSessionMeta;
  failureMeta: FakeSessionMeta;
  successScrollback: string;
  failureScrollback: string;
  /** IDs tracked via context.runtime.sessions.track */
  trackedIds: string[];
  /** Simulate probe: any ref in this set is "open", others "closed" */
  openSockets: Set<string>;
}

function makeSuccessMeta(overrides: Partial<FakeSessionMeta> = {}): FakeSessionMeta {
  return {
    id: SUCCESS_SESSION_ID,
    name: `DAR-07-success-${RUN_ID.slice(0, 8)}`,
    status: "completed",
    exitCode: 0,
    completedAt: "2026-01-01T00:00:00.000Z",
    socketPath: SUCCESS_SOCKET,
    ...overrides,
  };
}

function makeFailureMeta(overrides: Partial<FakeSessionMeta> = {}): FakeSessionMeta {
  return {
    id: FAILURE_SESSION_ID,
    name: `DAR-07-failure-${RUN_ID.slice(0, 8)}`,
    status: "failed",
    exitCode: 7,
    completedAt: "2026-01-01T00:00:01.000Z",
    socketPath: FAILURE_SOCKET,
    ...overrides,
  };
}

function makeState(overrides: Partial<ScenarioState> = {}): ScenarioState {
  return {
    successMeta: makeSuccessMeta(),
    failureMeta: makeFailureMeta(),
    successScrollback: "DAR_LIFECYCLE_EARLY success\nsome other output\n",
    failureScrollback: "DAR_LIFECYCLE_EARLY failure\nsome other output\n",
    trackedIds: [],
    openSockets: new Set([SUCCESS_SOCKET, FAILURE_SOCKET]),
    ...overrides,
  };
}

// ── Type aliases ────────────────────────────────────────────────────────────

type PtyMap = Map<"success" | "failure", FakePty>;

// ── Fake PTY ───────────────────────────────────────────────────────────────

class FakePty implements Dar07Pty {
  public killCalls = 0;
  public waitForExitCalls: number[] = [];
  public expectRawCalls: string[] = [];
  public writeTextCalls: string[] = [];
  public waitForExitError?: Error;
  public expectRawError?: Error;
  private readonly _onWriteText?: (text: string) => void;

  public constructor(options: { onWriteText?: (text: string) => void } = {}) {
    this._onWriteText = options.onWriteText;
  }

  public async expectRaw(marker: string, _deadline: number): Promise<void> {
    this.expectRawCalls.push(marker);
    if (this.expectRawError) {
      throw this.expectRawError;
    }
  }

  public async waitForExit(deadline: number): Promise<number> {
    this.waitForExitCalls.push(deadline);
    if (this.waitForExitError) {
      throw this.waitForExitError;
    }
    return 0;
  }

  public kill(): void {
    this.killCalls += 1;
  }

  public writeText(text: string): void {
    this.writeTextCalls.push(text);
    this._onWriteText?.(text);
  }
}

// ── Fake session store ────────────────────────────────────────────────────

interface FakeSessionsStore {
  track: (id: string) => void;
  waitForTerminalStatus: (id: string, deadline: number) => Promise<FakeSessionMeta>;
  read: (id: string) => Promise<FakeSessionMeta>;
  trackedIds: string[];
}

function makeSessionsStore(state: ScenarioState): FakeSessionsStore {
  const metaMap = new Map<string, FakeSessionMeta>([
    [SUCCESS_SESSION_ID, state.successMeta],
    [FAILURE_SESSION_ID, state.failureMeta],
  ]);

  return {
    trackedIds: state.trackedIds,
    track(id: string): void {
      state.trackedIds.push(id);
    },
    async waitForTerminalStatus(id: string, _deadline: number): Promise<FakeSessionMeta> {
      const meta = metaMap.get(id);
      if (!meta) {
        throw new Error(`Unknown session id: ${id}`);
      }
      return meta;
    },
    async read(id: string): Promise<FakeSessionMeta> {
      const meta = metaMap.get(id);
      if (!meta) {
        throw new Error(`Unknown session id: ${id}`);
      }
      return meta;
    },
  };
}

// ── Fake SocketProbe ──────────────────────────────────────────────────────

class FakeSocketProbe extends SocketProbe {
  public readonly openSockets: Set<string>;

  public constructor(openSockets: Set<string>) {
    super({ now: () => Date.now(), sleep: async () => {}, pollIntervalMs: 1 });
    this.openSockets = openSockets;
  }

  public override async probeOnce(ref: import("../src/drivers/socket-probe.js").SocketRef): Promise<boolean> {
    return this.openSockets.has(ref.raw);
  }

  public override async waitOpen(ref: import("../src/drivers/socket-probe.js").SocketRef, _deadline: number): Promise<void> {
    if (!this.openSockets.has(ref.raw)) {
      throw new Error(`Socket ${ref.raw} is not open`);
    }
  }

  public override async waitClosed(ref: import("../src/drivers/socket-probe.js").SocketRef, _deadline: number): Promise<void> {
    if (this.openSockets.has(ref.raw)) {
      throw new Error(`Socket ${ref.raw} is still open`);
    }
    // Unix: path absence is also required, but in fake mode we skip the filesystem check.
  }
}

// ── Context and dependency factories ─────────────────────────────────────

function makeContext(state: ScenarioState): Dar07Context {
  const store = makeSessionsStore(state);
  return {
    platform: "macos",
    overallDeadline: Date.now() + 120_000,
    build: {
      clientPath: "/fake/climon",
      fixturePath: "/fake/fixture",
    },
    runtime: {
      root: "/fake/root",
      home: "/fake/home",
      env: {},
      artifacts: { dir: "/fake/artifacts", appendText: async () => {} },
      sessions: store,
    },
  };
}

// Gate tokens derived from RUN_ID (first 8 chars of "dar07run-0001-0000-0000-000000000000" = "dar07run")
const SUCCESS_GATE_TOKEN = "dar07-gate-success-dar07run";
const FAILURE_GATE_TOKEN = "dar07-gate-failure-dar07run";

function makeDependencies(
  state: ScenarioState,
  options: {
    successPty?: FakePty;
    failurePty?: FakePty;
    extraFindSession?: (name: string) => Promise<FakeSessionMeta | undefined>;
  } = {}
): Dar07Dependencies & { ptyMap: PtyMap } {
  // When the caller does NOT supply an explicit PTY, create one wired to close
  // the socket on RELEASE so the happy-path waitOpen → RELEASE → waitClosed
  // cycle works deterministically.
  const successPty =
    options.successPty ??
    new FakePty({
      onWriteText: (text) => {
        if (text.trim() === `RELEASE ${SUCCESS_GATE_TOKEN}`) {
          state.openSockets.delete(SUCCESS_SOCKET);
        }
      },
    });
  const failurePty =
    options.failurePty ??
    new FakePty({
      onWriteText: (text) => {
        if (text.trim() === `RELEASE ${FAILURE_GATE_TOKEN}`) {
          state.openSockets.delete(FAILURE_SOCKET);
        }
      },
    });

  const ptyMap: PtyMap = new Map();

  return {
    ptyMap,
    now: () => Date.now(),
    sleep: async () => {},
    pollIntervalMs: 1,
    createUuid: () => RUN_ID,
    spawnPty: (spec, _deps) => {
      const pty = spec.args.includes("fast-success") ? successPty : failurePty;
      ptyMap.set(spec.args.includes("fast-success") ? "success" : "failure", pty);
      return pty;
    },
    findSession: async ({ expectedName }) => {
      if (options.extraFindSession) {
        const extra = await options.extraFindSession(expectedName);
        if (extra !== undefined) {
          return extra;
        }
      }
      // Return "running" status so the condition-wait in runVariant sees a live
      // session while socket capture is still pending (mirrors real launcher
      // behaviour: session is running before the daemon publishes its port).
      if (expectedName.includes("success")) {
        return { ...state.successMeta, status: "running" as const };
      }
      if (expectedName.includes("failure")) {
        return { ...state.failureMeta, status: "running" as const };
      }
      return undefined;
    },
    readScrollback: async (_home, id) => {
      if (id === SUCCESS_SESSION_ID) {
        return state.successScrollback;
      }
      if (id === FAILURE_SESSION_ID) {
        return state.failureScrollback;
      }
      return "";
    },
    createSocketProbe: () => new FakeSocketProbe(state.openSockets),
  };
}

// ── Contract tests ────────────────────────────────────────────────────────

describe("DAR-07 subcheck contract", () => {
  test("exports exactly 4 subchecks with the correct names", () => {
    expect(DAR_07_SUBCHECK_NAMES).toHaveLength(4);
    expect(DAR_07_SUBCHECK_NAMES).toEqual([
      "success-finalization",
      "success-socket-cleanup",
      "failure-finalization",
      "failure-socket-cleanup",
    ]);
  });

  test("exported titles match the 4 descriptive titles", async () => {
    const { DAR_07_SUBCHECKS } = await import("../src/scenarios/dar-07.js");
    const titles = DAR_07_SUBCHECKS.map((s) => s.title);
    expect(titles).toEqual(Array.from(DAR_07_SUBCHECK_TITLES));
  });
});

// ── Happy-path tests ─────────────────────────────────────────────────────

describe("runDar07 happy-path: all 4 subchecks pass", () => {
  test("returns exactly 4 results with correct names, titles, and passed status", async () => {
    // Default makeState: sockets are open initially; default makeDependencies closes
    // them via writeText callbacks on RELEASE, so all cleanup subchecks pass.
    const state = makeState();
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);

    expect(results).toHaveLength(4);
    for (const [index, result] of results.entries()) {
      expect(result.name, `result[${index}].name`).toBe(DAR_07_SUBCHECK_NAMES[index]);
      expect(result.title, `result[${index}].title`).toBe(DAR_07_SUBCHECK_TITLES[index]);
      expect(
        result.status,
        `result[${index}].status — ${result.message ?? "no message"}`
      ).toBe("passed");
    }
  });

  test("all subchecks include PTY artifact evidence paths", async () => {
    const state = makeState({ openSockets: new Set() });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);

    const successResults = results.filter((r) => r.name.startsWith("success-"));
    for (const result of successResults) {
      expect(result.evidence, `${result.name} evidence`).toContain("pty/success/input.log");
      expect(result.evidence, `${result.name} evidence`).toContain("pty/success/output.log");
    }

    const failureResults = results.filter((r) => r.name.startsWith("failure-"));
    for (const result of failureResults) {
      expect(result.evidence, `${result.name} evidence`).toContain("pty/failure/input.log");
      expect(result.evidence, `${result.name} evidence`).toContain("pty/failure/output.log");
    }
  });

  test("finalization subchecks include session meta and scrollback evidence paths", async () => {
    const state = makeState({ openSockets: new Set() });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);

    const successFin = results.find((r) => r.name === "success-finalization")!;
    expect(successFin.evidence).toContain(`home/sessions/${SUCCESS_SESSION_ID}.json`);
    expect(successFin.evidence).toContain(`home/sessions/${SUCCESS_SESSION_ID}.scrollback`);
    expect(successFin.evidence).toContain(`home/logs/daemon/${SUCCESS_SESSION_ID}.log`);

    const failureFin = results.find((r) => r.name === "failure-finalization")!;
    expect(failureFin.evidence).toContain(`home/sessions/${FAILURE_SESSION_ID}.json`);
  });

  test("both PTYs are spawned with the correct fixture subcommand", async () => {
    const state = makeState({ openSockets: new Set() });
    const context = makeContext(state);
    const { ptyMap, ...deps } = makeDependencies(state);
    const spawnedSpecs: string[][] = [];

    await runDar07(context, {
      ...deps,
      spawnPty: (spec, _d) => {
        spawnedSpecs.push(spec.args);
        return ptyMap.get(spec.args.includes("fast-success") ? "success" : "failure") ?? new FakePty();
      },
    });

    expect(spawnedSpecs).toHaveLength(2);
    expect(spawnedSpecs.some((args) => args.includes("fast-success"))).toBe(true);
    expect(spawnedSpecs.some((args) => args.includes("failed-exit"))).toBe(true);
  });

  test("spawn args include the unique gate token for each variant", async () => {
    const state = makeState({ openSockets: new Set() });
    const context = makeContext(state);
    const { ptyMap, ...deps } = makeDependencies(state);
    const spawnedSpecs: string[][] = [];

    await runDar07(context, {
      ...deps,
      spawnPty: (spec, _d) => {
        spawnedSpecs.push(spec.args);
        return ptyMap.get(spec.args.includes("fast-success") ? "success" : "failure") ?? new FakePty();
      },
    });

    const successSpec = spawnedSpecs.find((args) => args.includes("fast-success"))!;
    const failureSpec = spawnedSpecs.find((args) => args.includes("failed-exit"))!;
    expect(successSpec).toContain(SUCCESS_GATE_TOKEN);
    expect(failureSpec).toContain(FAILURE_GATE_TOKEN);
    // Tokens must be distinct
    expect(SUCCESS_GATE_TOKEN).not.toBe(FAILURE_GATE_TOKEN);
  });

  test("writeText is called with RELEASE and the correct token before PTY exit", async () => {
    const successPty = new FakePty();
    const failurePty = new FakePty();
    const state = makeState();
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state, { successPty, failurePty });

    await runDar07(context, deps);

    // Each PTY must receive exactly one RELEASE command followed by the
    // cross-platform PTY Enter key.
    expect(successPty.writeTextCalls).toContain(`RELEASE ${SUCCESS_GATE_TOKEN}\r`);
    expect(failurePty.writeTextCalls).toContain(`RELEASE ${FAILURE_GATE_TOKEN}\r`);
    const successRelease = successPty.writeTextCalls.find((t) => t.startsWith("RELEASE "));
    expect(successRelease, "RELEASE write must end with a single \\r").toMatch(/[^\n]\r$/);
    // RELEASE must appear before waitForExit (writeText before waitForExit means
    // writeTextCalls is populated and then waitForExitCalls follows).
    expect(successPty.writeTextCalls.length).toBeGreaterThanOrEqual(1);
    expect(successPty.waitForExitCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("both PTYs receive a kill() call during cleanup", async () => {
    const successPty = new FakePty();
    const failurePty = new FakePty();
    const state = makeState({ openSockets: new Set() });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state, { successPty, failurePty });

    await runDar07(context, deps);

    expect(successPty.killCalls).toBe(1);
    expect(failurePty.killCalls).toBe(1);
  });

  test("both PTYs have expectRaw called with the correct early and gate markers", async () => {
    const successPty = new FakePty();
    const failurePty = new FakePty();
    const state = makeState({ openSockets: new Set() });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state, { successPty, failurePty });

    await runDar07(context, deps);

    expect(successPty.expectRawCalls).toContain("DAR_LIFECYCLE_EARLY success");
    expect(successPty.expectRawCalls).toContain(`DAR_LIFECYCLE_GATE ${SUCCESS_GATE_TOKEN}`);
    expect(failurePty.expectRawCalls).toContain("DAR_LIFECYCLE_EARLY failure");
    expect(failurePty.expectRawCalls).toContain(`DAR_LIFECYCLE_GATE ${FAILURE_GATE_TOKEN}`);
  });

  test("tracks the correct session IDs via context.runtime.sessions.track", async () => {
    const state = makeState({ openSockets: new Set() });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    await runDar07(context, deps);

    expect(state.trackedIds).toContain(SUCCESS_SESSION_ID);
    expect(state.trackedIds).toContain(FAILURE_SESSION_ID);
  });
});

// ── Finalization failure tests ────────────────────────────────────────────

describe("runDar07 success-finalization failures", () => {
  test("fails when status is not completed", async () => {
    const state = makeState({
      successMeta: makeSuccessMeta({ status: "running" }),
      openSockets: new Set(),
    });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);
    const fin = results.find((r) => r.name === "success-finalization")!;

    expect(fin.status).toBe("failed");
    expect(fin.message).toContain("status");
  });

  test("fails when exitCode is non-zero for success variant", async () => {
    const state = makeState({
      successMeta: makeSuccessMeta({ exitCode: 1 }),
      openSockets: new Set(),
    });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);
    const fin = results.find((r) => r.name === "success-finalization")!;

    expect(fin.status).toBe("failed");
    expect(fin.message).toContain("exitCode");
  });

  test("fails when completedAt is empty", async () => {
    const state = makeState({
      successMeta: makeSuccessMeta({ completedAt: "" }),
      openSockets: new Set(),
    });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);
    const fin = results.find((r) => r.name === "success-finalization")!;

    expect(fin.status).toBe("failed");
    expect(fin.message).toContain("completedAt");
  });

  test("fails when scrollback does not contain the early success marker", async () => {
    const state = makeState({
      successScrollback: "some output without the marker",
      openSockets: new Set(),
    });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);
    const fin = results.find((r) => r.name === "success-finalization")!;

    expect(fin.status).toBe("failed");
    expect(fin.message).toContain("DAR_LIFECYCLE_EARLY success");
  });
});

describe("runDar07 failure-finalization assertions", () => {
  test("fails when exitCode is not exactly 7", async () => {
    const state = makeState({
      failureMeta: makeFailureMeta({ exitCode: 1 }),
      openSockets: new Set(),
    });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);
    const fin = results.find((r) => r.name === "failure-finalization")!;

    expect(fin.status).toBe("failed");
    expect(fin.message).toContain("exitCode");
    expect(fin.message).toContain("7");
  });

  test("fails when scrollback does not contain the early failure marker", async () => {
    const state = makeState({
      failureScrollback: "no marker here",
      openSockets: new Set(),
    });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);
    const fin = results.find((r) => r.name === "failure-finalization")!;

    expect(fin.status).toBe("failed");
    expect(fin.message).toContain("DAR_LIFECYCLE_EARLY failure");
  });

  test("fails when status is not failed", async () => {
    const state = makeState({
      failureMeta: makeFailureMeta({ status: "completed" }),
      openSockets: new Set(),
    });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);
    const fin = results.find((r) => r.name === "failure-finalization")!;

    expect(fin.status).toBe("failed");
    expect(fin.message).toContain("status");
  });
});

// ── Socket cleanup tests ───────────────────────────────────────────────────

describe("runDar07 socket-cleanup subchecks", () => {
  test("socket-cleanup passes when socket is open initially and closes after RELEASE", async () => {
    // Default makeState: both sockets in openSockets. Default makeDependencies
    // creates PTYs with onWriteText callbacks that delete sockets on RELEASE.
    const state = makeState();
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);

    const successCleanup = results.find((r) => r.name === "success-socket-cleanup")!;
    const failureCleanup = results.find((r) => r.name === "failure-socket-cleanup")!;
    expect(successCleanup.status).toBe("passed");
    expect(failureCleanup.status).toBe("passed");
  });

  test("socket-cleanup fails when waitOpen cannot prove the daemon listener was open", async () => {
    // openSockets empty → FakeSocketProbe.waitOpen throws → openProofRecorded = false
    const state = makeState({ openSockets: new Set() });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);

    const successCleanup = results.find((r) => r.name === "success-socket-cleanup")!;
    const failureCleanup = results.find((r) => r.name === "failure-socket-cleanup")!;
    expect(successCleanup.status).toBe("failed");
    expect(successCleanup.message).toMatch(/open proof absent/i);
    expect(failureCleanup.status).toBe("failed");
    expect(failureCleanup.message).toMatch(/open proof absent/i);
  });

  test("socket-cleanup fails when socket stays open after RELEASE (daemon refuses to close)", async () => {
    // Provide explicit PTYs without onWriteText callbacks so the socket is never
    // removed from openSockets even after RELEASE — FakeSocketProbe.waitClosed throws.
    const successPty = new FakePty(); // no write-text callback → socket stays open
    const failurePty = new FakePty();
    const state = makeState({ openSockets: new Set([SUCCESS_SOCKET, FAILURE_SOCKET]) });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state, { successPty, failurePty });

    const results = await runDar07(context, deps);

    const successCleanup = results.find((r) => r.name === "success-socket-cleanup")!;
    const failureCleanup = results.find((r) => r.name === "failure-socket-cleanup")!;
    expect(successCleanup.status).toBe("failed");
    expect(failureCleanup.status).toBe("failed");
  });

  test("socket-cleanup fails when socketPath is absent from metadata", async () => {
    const state = makeState({
      successMeta: makeSuccessMeta({ socketPath: undefined }),
      failureMeta: makeFailureMeta({ socketPath: undefined }),
      openSockets: new Set(),
    });
    // overallDeadline already expired → condition-wait times out on the first
    // poll iteration rather than spinning for FIND_SESSION_TIMEOUT_MS (30 s).
    const context: Dar07Context = { ...makeContext(state), overallDeadline: 1 };
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);

    const successCleanup = results.find((r) => r.name === "success-socket-cleanup")!;
    expect(successCleanup.status).toBe("failed");
    expect(successCleanup.message).toContain("socketPath");
  });

  test("socket-cleanup fails when socketPath is an invalid ref (named pipe)", async () => {
    const state = makeState({
      successMeta: makeSuccessMeta({ socketPath: "\\\\.\\pipe\\climon-session" }),
      openSockets: new Set(),
    });
    // overallDeadline already expired → condition-wait times out immediately.
    const context: Dar07Context = { ...makeContext(state), overallDeadline: 1 };
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);

    const successCleanup = results.find((r) => r.name === "success-socket-cleanup")!;
    expect(successCleanup.status).toBe("failed");
    // Named pipe: parse error, so message should note failure.
    expect(successCleanup.message).toBeTruthy();
  });
});

// ── PTY spawn failure isolation ───────────────────────────────────────────

describe("runDar07 PTY spawn failures are isolated per variant", () => {
  test("success-variant spawn failure marks success subchecks failed without affecting failure subchecks", async () => {
    const state = makeState({ openSockets: new Set() });
    const context = makeContext(state);
    let spawnCallIndex = 0;

    const failurePty = new FakePty();
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, {
      ...deps,
      spawnPty: (_spec) => {
        spawnCallIndex += 1;
        if (spawnCallIndex === 1) {
          throw new Error("Simulated success PTY spawn failure");
        }
        return failurePty;
      },
    });

    expect(results).toHaveLength(4);
    const successFin = results.find((r) => r.name === "success-finalization")!;
    const failureFin = results.find((r) => r.name === "failure-finalization")!;
    expect(successFin.status).toBe("failed");
    expect(failureFin.status).toBe("passed");
  });
});

// ── Subcheck result structure ─────────────────────────────────────────────

describe("runDar07 result structure", () => {
  test("each result has a non-negative durationMs", async () => {
    const state = makeState({ openSockets: new Set() });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);

    for (const result of results) {
      expect(result.durationMs, `${result.name} durationMs`).toBeGreaterThanOrEqual(0);
    }
  });

  test("results are in the canonical order: success-fin, success-cleanup, failure-fin, failure-cleanup", async () => {
    const state = makeState({ openSockets: new Set() });
    const context = makeContext(state);
    const { ptyMap: _, ...deps } = makeDependencies(state);

    const results = await runDar07(context, deps);

    expect(results.map((r) => r.name)).toEqual([
      "success-finalization",
      "success-socket-cleanup",
      "failure-finalization",
      "failure-socket-cleanup",
    ]);
  });
});

// ── DAR-07 regression: placeholder socketPath tcp://127.0.0.1:0 ───────────
//
// Root cause: launcher initially writes socketPath: "tcp://127.0.0.1:0" while
// the daemon binds to an OS-assigned port. runVariant must not capture that
// placeholder; it must keep polling until the metadata carries a valid,
// non-zero TCP port (or an absolute Unix path).

describe("DAR-07 regression: placeholder socketPath tcp://127.0.0.1:0 (DAR-07)", () => {
  test(
    "findSession returning :0 then :54321 — runVariant waits and uses valid ref; cleanup passes",
    async () => {
      // Only the valid ports are "open".  If runVariant incorrectly captures :0
      // and passes it to waitOpen/waitClosed, FakeSocketProbe would fail because
      // :0 is absent from openSockets.
      const VALID_SUCCESS_SOCKET = "tcp://127.0.0.1:54321";
      const VALID_FAILURE_SOCKET = "tcp://127.0.0.1:54322";

      const state = makeState({
        successMeta: makeSuccessMeta({ socketPath: VALID_SUCCESS_SOCKET }),
        failureMeta: makeFailureMeta({ socketPath: VALID_FAILURE_SOCKET }),
        openSockets: new Set([VALID_SUCCESS_SOCKET, VALID_FAILURE_SOCKET]),
      });

      // Wire PTYs to close the VALID sockets (not the default SUCCESS/FAILURE_SOCKET)
      // so waitClosed sees them closed after RELEASE.
      const successPty = new FakePty({
        onWriteText: (text) => {
          if (text.trim() === `RELEASE ${SUCCESS_GATE_TOKEN}`) {
            state.openSockets.delete(VALID_SUCCESS_SOCKET);
          }
        },
      });
      const failurePty = new FakePty({
        onWriteText: (text) => {
          if (text.trim() === `RELEASE ${FAILURE_GATE_TOKEN}`) {
            state.openSockets.delete(VALID_FAILURE_SOCKET);
          }
        },
      });

      const context = makeContext(state);
      const { ptyMap: _, ...baseDeps } = makeDependencies(state, { successPty, failurePty });

      // Sequence: first findSession call returns :0 placeholder, second returns valid.
      let successFindCalls = 0;
      let failureFindCalls = 0;

      const results = await runDar07(context, {
        ...baseDeps,
        findSession: async ({ expectedName }) => {
          if (expectedName.includes("success")) {
            successFindCalls += 1;
            if (successFindCalls === 1) {
              return { ...state.successMeta, status: "running" as SessionStatus, socketPath: "tcp://127.0.0.1:0" };
            }
            return { ...state.successMeta, status: "running" as SessionStatus };
          }
          if (expectedName.includes("failure")) {
            failureFindCalls += 1;
            if (failureFindCalls === 1) {
              return { ...state.failureMeta, status: "running" as SessionStatus, socketPath: "tcp://127.0.0.1:0" };
            }
            return { ...state.failureMeta, status: "running" as SessionStatus };
          }
          return undefined;
        },
      });

      // Placeholder must have been skipped; findSession must have been polled > 1 time.
      expect(successFindCalls, "success findSession call count").toBeGreaterThan(1);
      expect(failureFindCalls, "failure findSession call count").toBeGreaterThan(1);

      const successCleanup = results.find((r) => r.name === "success-socket-cleanup")!;
      const failureCleanup = results.find((r) => r.name === "failure-socket-cleanup")!;
      expect(successCleanup.status, successCleanup.message ?? "").toBe("passed");
      expect(failureCleanup.status, failureCleanup.message ?? "").toBe("passed");
    }
  );

  test(
    "times out with a useful message when metadata never publishes a valid socket path",
    async () => {
      const state = makeState({ openSockets: new Set() });

      // Use a monotonic counter clock that jumps 10 s per tick so the
      // FIND_SESSION_TIMEOUT_MS (30 s) deadline expires after 3–4 polls.
      let ticks = 0;
      const BASE = 1_000_000;
      const fastNow = () => BASE + ticks++ * 10_000;

      const context: Dar07Context = {
        ...makeContext(state),
        overallDeadline: BASE + 25_000, // < FIND_SESSION_TIMEOUT_MS (30 s)
      };

      const { ptyMap: _, ...baseDeps } = makeDependencies(state);

      const results = await runDar07(context, {
        ...baseDeps,
        now: fastNow,
        // Always return :0 — daemon never publishes a real port.
        findSession: async ({ expectedName }) => {
          if (expectedName.includes("success")) {
            return { ...state.successMeta, status: "running" as SessionStatus, socketPath: "tcp://127.0.0.1:0" };
          }
          if (expectedName.includes("failure")) {
            return { ...state.failureMeta, status: "running" as SessionStatus, socketPath: "tcp://127.0.0.1:0" };
          }
          return undefined;
        },
      });

      const successFin = results.find((r) => r.name === "success-finalization")!;
      const failureFin = results.find((r) => r.name === "failure-finalization")!;
      expect(successFin.status).toBe("failed");
      expect(failureFin.status).toBe("failed");
      // Message must mention timeout so operators understand what went wrong.
      expect(successFin.message, "success-finalization message").toMatch(/timed out/i);
    }
  );
});
