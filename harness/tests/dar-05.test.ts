import { describe, expect, test } from "bun:test";
import {
  DAR_05_SUBCHECK_NAMES,
  runDar05,
  type Dar05BrowserDriver,
  type Dar05BrowserSurface,
  type Dar05Context,
  type Dar05Pty,
} from "../src/scenarios/dar-05.js";

const DAR_05_SUBCHECK_TITLES = [
  "Flags the session as needing attention and captures a non-empty attentionMatchedAt token",
  "Acknowledges the current attention token through the browser and clears the flag",
  "Resets the attention flag to running when the body changes",
  "Re-flags the session as needing attention after the body-change idle period",
  "Preserves the attention token and status across a resize",
  "Rejects a stale token and leaves the attention flag unchanged",
  "Accepts the current token and clears the attention flag a second time",
] as const;

const RUN_ID = "abc123";
const SESSION_ID = "dar-05-session";
const INITIAL_TOKEN = "attention-token-initial-abc123";
const SECOND_TOKEN = "attention-token-second-abc123";

type SessionStatus =
  | "running"
  | "acknowledged"
  | "needs-attention"
  | "completed"
  | "paused"
  | "failed"
  | "disconnected";

interface SessionMeta {
  id: string;
  status: SessionStatus;
  attentionMatchedAt?: string;
  [key: string]: unknown;
}

interface ScenarioState {
  sessionId?: string;
  status: SessionStatus;
  attentionMatchedAt?: string;
  exited: boolean;
  ptyOutput: string;
}

class FakePty implements Dar05Pty {
  public readonly writeTextCalls: string[] = [];
  public readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  public readonly waitForExitCalls: number[] = [];
  public readonly waitForQuietCalls: Array<{ quietPeriodMs: number; deadline: number }> = [];
  public killCalls = 0;

  public constructor(
    private readonly state: ScenarioState,
    private readonly options: {
      spawnMarker?: string;
      waitForExitError?: Error;
    } = {}
  ) {}

  public writeText(text: string): void {
    this.writeTextCalls.push(text);
    if (text.startsWith("CHANGE ") && text.endsWith("\n")) {
      const token = text.slice("CHANGE ".length, -1);
      this.state.ptyOutput += `DAR_METADATA_BODY_CHANGED ${token}\n`;
      this.state.status = "running";
      this.state.attentionMatchedAt = undefined;
      return;
    }
    if (text === "EXIT\n") {
      this.state.exited = true;
      this.state.status = "completed";
    }
  }

  public resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  public async expectRaw(marker: string, _deadline: number): Promise<void> {
    if (this.options.spawnMarker) {
      throw new Error(this.options.spawnMarker);
    }
    if (!this.state.ptyOutput.includes(marker)) {
      throw new Error(`Missing raw marker: ${marker}`);
    }
  }

  public async waitForExit(deadline: number): Promise<number> {
    this.waitForExitCalls.push(deadline);
    if (this.options.waitForExitError) {
      throw this.options.waitForExitError;
    }
    if (!this.state.exited) {
      throw new Error("Timed out waiting for process exit");
    }
    return 0;
  }

  public kill(): void {
    this.killCalls += 1;
  }

  public async waitForQuiet(quietPeriodMs: number, deadline: number): Promise<void> {
    this.waitForQuietCalls.push({ quietPeriodMs, deadline });
  }
}

class FakeBrowserSurface implements Dar05BrowserSurface {
  public readonly name: string;
  public readonly viewerId: string;
  public readonly callLog: string[] = [];
  public readonly openCalls: string[] = [];
  public readonly openTerminalCalls: string[] = [];
  public readonly acknowledgeAttentionCalls: string[] = [];
  public readonly acknowledgeAttentionTokenCalls: Array<{ id: string; token: string }> = [];
  public readonly waitForDisplacedCalls: string[] = [];
  public readonly statusCalls: string[] = [];
  public readonly closeCalls: string[] = [];
  public closeError?: Error;
  public acknowledgeAttentionError?: Error;
  public waitForDisplacedError?: Error;

  public constructor(
    name: string,
    viewerId: string,
    private readonly state: ScenarioState
  ) {
    this.name = name;
    this.viewerId = viewerId;
  }

  public async open(baseUrl: string, _deadline: number): Promise<void> {
    this.callLog.push("open");
    this.openCalls.push(baseUrl);
  }

  public async openTerminal(id: string, _deadline: number): Promise<void> {
    this.callLog.push("openTerminal");
    this.openTerminalCalls.push(id);
  }

  public async acknowledgeAttention(id: string, _deadline: number): Promise<void> {
    this.callLog.push("acknowledgeAttention");
    this.acknowledgeAttentionCalls.push(id);
    if (this.acknowledgeAttentionError) {
      throw this.acknowledgeAttentionError;
    }
    if (this.state.status === "needs-attention") {
      this.state.status = "acknowledged";
      this.state.attentionMatchedAt = undefined;
    }
  }

  public async acknowledgeAttentionToken(
    id: string,
    token: string,
    _deadline: number
  ): Promise<void> {
    this.callLog.push("acknowledgeAttentionToken");
    this.acknowledgeAttentionTokenCalls.push({ id, token });
    // Server validates token; only clear if it matches current attentionMatchedAt.
    if (
      this.state.status === "needs-attention" &&
      this.state.attentionMatchedAt === token
    ) {
      this.state.status = "acknowledged";
      this.state.attentionMatchedAt = undefined;
    }
  }

  public async status(id: string, _deadline: number): Promise<string | null> {
    this.callLog.push("status");
    this.statusCalls.push(id);
    return this.state.status;
  }

  public async close(): Promise<void> {
    this.callLog.push("close");
    this.closeCalls.push(this.name);
    if (this.closeError) {
      throw this.closeError;
    }
  }

  public async waitForDisplaced(id: string, _deadline: number): Promise<string> {
    this.callLog.push("waitForDisplaced");
    this.waitForDisplacedCalls.push(id);
    if (this.waitForDisplacedError) {
      throw this.waitForDisplacedError;
    }
    return this.viewerId;
  }
}

class FakeBrowserDriver implements Dar05BrowserDriver {
  public readonly createSurfaceCalls: Array<{
    name: string;
    viewport: { width: number; height: number };
    displayMode?: "browser" | "standalone";
  }> = [];
  public readonly surface1: FakeBrowserSurface;
  public readonly surface2: FakeBrowserSurface;

  /** surface is the first surface created (alias for surface1, kept for old tests) */
  public get surface(): FakeBrowserSurface {
    return this.surface1;
  }

  public constructor(state: ScenarioState) {
    this.surface1 = new FakeBrowserSurface(
      "attention-browser",
      "surface-1-attention-browser",
      state
    );
    this.surface2 = new FakeBrowserSurface(
      "stale-rejection-browser",
      "surface-2-stale-rejection-browser",
      state
    );
  }

  public async createSurface(options: {
    name: string;
    viewport: { width: number; height: number };
    displayMode?: "browser" | "standalone";
  }): Promise<Dar05BrowserSurface> {
    this.createSurfaceCalls.push({ name: options.name, viewport: options.viewport, displayMode: options.displayMode });
    const callIndex = this.createSurfaceCalls.length;
    return callIndex === 1 ? this.surface1 : this.surface2;
  }
}

function makeState(overrides: Partial<ScenarioState> = {}): ScenarioState {
  return {
    sessionId: SESSION_ID,
    status: "running",
    attentionMatchedAt: undefined,
    exited: false,
    ptyOutput: "DAR_METADATA_STATIC\n",
    ...overrides,
  };
}

function makeContext(state: ScenarioState): Dar05Context {
  return {
    platform: "macos",
    overallDeadline: Date.now() + 120_000,
    build: { clientPath: "/fake/climon", fixturePath: "/fake/fixture" },
    runtime: {
      root: "/fake/root",
      home: "/fake/home",
      baseUrl: "http://127.0.0.1:54321/",
      env: {},
      artifacts: { dir: "/fake/artifacts", appendText: async () => {} },
      sessions: {
        track: (_id: string) => {},
        waitForStatus: async (
          _id: string,
          status: SessionStatus,
          _deadline: number
        ): Promise<SessionMeta> => {
          return { id: SESSION_ID, status, attentionMatchedAt: state.attentionMatchedAt };
        },
        read: async (_id: string): Promise<SessionMeta> => {
          return {
            id: SESSION_ID,
            status: state.status,
            attentionMatchedAt: state.attentionMatchedAt,
          };
        },
      },
    },
  };
}

//
// The scenario calls waitForStatus in this order per full happy-path run:
//   [0] waitForStatus("running")         -- initial startup check (return discarded)
//   [1] waitForStatus("needs-attention") -- sub1: get initial attentionMatchedAt
//   [2] waitForStatus("acknowledged")    -- sub2: confirm ack cleared flag
//   [3] waitForStatus("running")         -- sub3: confirm body-change reset
//   [4] waitForStatus("needs-attention") -- sub4: re-flagged with new token
//   [5] waitForStatus("acknowledged")    -- sub7: confirm second ack
//
// And sessions.read() is called in this order:
//   [0] read() in sub3: verify attentionMatchedAt cleared
//   [1..3] read() in sub5: bounded observation window (3 polls)
//   [4..6] read() in sub6: continuous observation window (3 polls)
//
function makeHappyPathSeqs(): {
  waitSeq: SessionMeta[];
  readSeq: SessionMeta[];
} {
  return {
    waitSeq: [
      { id: SESSION_ID, status: "running" },                                             // [0] startup
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: INITIAL_TOKEN },  // [1] sub1
      { id: SESSION_ID, status: "acknowledged" },                                        // [2] sub2
      { id: SESSION_ID, status: "running" },                                             // [3] sub3
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN },   // [4] sub4
      { id: SESSION_ID, status: "acknowledged" },                                        // [5] sub7
    ],
    readSeq: [
      { id: SESSION_ID, status: "running" },                                             // [0] sub3
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN },   // [1] sub5 poll1
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN },   // [2] sub5 poll2
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN },   // [3] sub5 poll3
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN },   // [4] sub6 poll1
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN },   // [5] sub6 poll2
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN },   // [6] sub6 poll3
    ],
  };
}

function makeSequencedContext(
  state: ScenarioState,
  waitSeq: SessionMeta[],
  readSeq: SessionMeta[]
): Dar05Context {
  let wsIdx = 0;
  let readIdx = 0;
  return {
    platform: "macos",
    overallDeadline: Date.now() + 120_000,
    build: { clientPath: "/fake/climon", fixturePath: "/fake/fixture" },
    runtime: {
      root: "/fake/root",
      home: "/fake/home",
      baseUrl: "http://127.0.0.1:54321/",
      env: {},
      artifacts: { dir: "/fake/artifacts", appendText: async () => {} },
      sessions: {
        track: () => {},
        waitForStatus: async (_id, status) =>
          waitSeq[wsIdx++] ?? { id: SESSION_ID, status },
        read: async () =>
          readSeq[readIdx++] ?? { id: SESSION_ID, status: state.status as SessionStatus },
      },
    },
  };
}

describe("DAR-05 subcheck contract", () => {
  test("exports exactly 7 subchecks with the correct names and titles", () => {
    expect(DAR_05_SUBCHECK_NAMES).toHaveLength(7);
    expect(DAR_05_SUBCHECK_NAMES).toEqual([
      "initial-attention-flag",
      "current-token-acknowledgement",
      "body-change-reset",
      "reflag-after-body-change",
      "resize-stickiness",
      "stale-token-rejection",
      "second-token-acknowledgement",
    ]);
  });

  test("exported titles match the 7 descriptive titles", async () => {
    const { DAR_05_SUBCHECKS } = await import("../src/scenarios/dar-05.js");
    const titles = DAR_05_SUBCHECKS.map((s) => s.title);
    expect(titles).toEqual(Array.from(DAR_05_SUBCHECK_TITLES));
  });
});

describe("runDar05 happy-path: all 7 subchecks pass", () => {
  test("returns 7 results with correct names and titles", async () => {
    const state = makeState();
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);
    const browser = new FakeBrowserDriver(state);
    const pty = new FakePty({ ...state }, {});

    const results = await runDar05(context, {
      now: () => Date.now(),
      sleep: async () => {},
      pollIntervalMs: 1,
      createUuid: () => RUN_ID,
      createBrowserDriver: () => browser,
      spawnPty: () => pty,
      findSession: async ({ expectedName }) =>
        expectedName === `DAR-05-${RUN_ID}`
          ? { id: SESSION_ID, status: "running" as const }
          : undefined,
      writeConfig: async () => {},
    });

    expect(results).toHaveLength(7);
    for (const [index, result] of results.entries()) {
      expect(result.name, `result[${index}].name`).toBe(DAR_05_SUBCHECK_NAMES[index]);
      expect(result.title, `result[${index}].title`).toBe(DAR_05_SUBCHECK_TITLES[index]);
      expect(result.status, `result[${index}].status — ${result.message ?? "no message"}`).toBe("passed");
    }
  });

  test("all subchecks include base evidence paths", async () => {
    const state = makeState();
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    const results = await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
    });

    for (const result of results) {
      expect(result.evidence, `${result.name} evidence`).toContain("pty/input.log");
      expect(result.evidence, `${result.name} evidence`).toContain("pty/output.log");
      expect(result.evidence, `${result.name} evidence`).toContain(
        `home/sessions/${SESSION_ID}.json`
      );
    }
  });
});

describe("runDar05 subcheck isolation: each subcheck fails independently", () => {
  test("initial-attention-flag fails when PTY spawn fails", async () => {
    const state = makeState();
    const context = makeContext(state);
    const results = await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => {
        throw new Error("PTY spawn error");
      },
      findSession: async () => undefined,
      writeConfig: async () => {},
    });

    expect(results[0]!.name).toBe("initial-attention-flag");
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.message).toContain("PTY spawn error");

    for (let i = 1; i < 7; i++) {
      expect(results[i]!.status, `result[${i}].status`).toBe("failed");
      expect(results[i]!.message, `result[${i}].message`).toContain("Unable to run subcheck");
    }
  });

  test("initial-attention-flag fails when session cannot be found", async () => {
    const state = makeState();
    const context = makeContext(state);
    const results = await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => undefined,
      writeConfig: async () => {},
      now: () => Date.now() + 200_000,
    });

    expect(results[0]!.name).toBe("initial-attention-flag");
    expect(results[0]!.status).toBe("failed");
  });

  test("current-token-acknowledgement fails independently when initial-attention-flag fails", async () => {
    const state = makeState();
    const context = makeContext(state);
    const results = await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => {
        throw new Error("spawn error");
      },
      findSession: async () => undefined,
      writeConfig: async () => {},
    });

    expect(results[1]!.name).toBe("current-token-acknowledgement");
    expect(results[1]!.status).toBe("failed");
    expect(results[1]!.message).toContain("Unable to run subcheck");
  });

  test("body-change-reset fails independently when waitForStatus times out", async () => {
    const state = makeState();
    // Sub1 passes (running + needs-attention), sub2 passes (acknowledged),
    // sub3 times out waiting for "running" after body change.
    const waitSeq: SessionMeta[] = [
      { id: SESSION_ID, status: "running" },
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: INITIAL_TOKEN },
      { id: SESSION_ID, status: "acknowledged" },
    ];
    let wsIdx = 0;
    const readSeq: SessionMeta[] = [
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: INITIAL_TOKEN },
    ];
    let readIdx = 0;

    const context: Dar05Context = {
      platform: "macos",
      overallDeadline: Date.now() + 120_000,
      build: { clientPath: "/fake/climon", fixturePath: "/fake/fixture" },
      runtime: {
        root: "/fake/root",
        home: "/fake/home",
        baseUrl: "http://127.0.0.1:54321/",
        env: {},
        artifacts: { dir: "/fake/artifacts", appendText: async () => {} },
        sessions: {
          track: () => {},
          waitForStatus: async (_id, status) => {
            const meta = waitSeq[wsIdx++];
            if (meta) return meta;
            throw new Error(`Timed out waiting for session to reach status ${status}`);
          },
          read: async () => readSeq[readIdx++] ?? { id: SESSION_ID, status: "running" as SessionStatus },
        },
      },
    };

    const results = await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
    });

    expect(results[0]!.status).toBe("passed");
    expect(results[1]!.status).toBe("passed");
    expect(results[2]!.name).toBe("body-change-reset");
    expect(results[2]!.status).toBe("failed");
    // Downstream subchecks blocked too
    for (let i = 3; i < 7; i++) {
      expect(results[i]!.status, `result[${i}].status`).toBe("failed");
    }
  });

  test("resize-stickiness fails when attention token disappears after resize", async () => {
    const state = makeState();
    const waitSeq: SessionMeta[] = [
      { id: SESSION_ID, status: "running" },
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: INITIAL_TOKEN },
      { id: SESSION_ID, status: "acknowledged" },
      { id: SESSION_ID, status: "running" },
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN },
    ];
    let wsIdx = 0;
    // After resize the token is GONE — simulating a bug
    const readSeq: SessionMeta[] = [
      { id: SESSION_ID, status: "running" },                                   // sub3
      { id: SESSION_ID, status: "running", attentionMatchedAt: undefined },    // sub5: token cleared (BUG)
      { id: SESSION_ID, status: "running" },                                   // sub6 (won't reach)
    ];
    let readIdx = 0;
    const context: Dar05Context = {
      platform: "macos",
      overallDeadline: Date.now() + 120_000,
      build: { clientPath: "/fake/climon", fixturePath: "/fake/fixture" },
      runtime: {
        root: "/fake/root",
        home: "/fake/home",
        baseUrl: "http://127.0.0.1:54321/",
        env: {},
        artifacts: { dir: "/fake/artifacts", appendText: async () => {} },
        sessions: {
          track: () => {},
          waitForStatus: async (_id, status) => waitSeq[wsIdx++] ?? { id: SESSION_ID, status },
          read: async () => readSeq[readIdx++] ?? { id: SESSION_ID, status: "running" as SessionStatus },
        },
      },
    };
    const results = await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
    });

    expect(results[4]!.name).toBe("resize-stickiness");
    expect(results[4]!.status).toBe("failed");
  });

  test("stale-token-rejection fails when stale token incorrectly clears attention", async () => {
    const state = makeState();
    const waitSeq: SessionMeta[] = [
      { id: SESSION_ID, status: "running" },
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: INITIAL_TOKEN },
      { id: SESSION_ID, status: "acknowledged" },
      { id: SESSION_ID, status: "running" },
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN },
    ];
    let wsIdx = 0;
    const readSeq: SessionMeta[] = [
      { id: SESSION_ID, status: "running" },                                           // sub3
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN }, // sub5 poll1
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN }, // sub5 poll2
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN }, // sub5 poll3
      // sub6 poll1: After stale token: status unexpectedly cleared (BUG)
      { id: SESSION_ID, status: "acknowledged", attentionMatchedAt: undefined },
    ];
    let readIdx = 0;
    const context: Dar05Context = {
      platform: "macos",
      overallDeadline: Date.now() + 120_000,
      build: { clientPath: "/fake/climon", fixturePath: "/fake/fixture" },
      runtime: {
        root: "/fake/root",
        home: "/fake/home",
        baseUrl: "http://127.0.0.1:54321/",
        env: {},
        artifacts: { dir: "/fake/artifacts", appendText: async () => {} },
        sessions: {
          track: () => {},
          waitForStatus: async (_id, status) => waitSeq[wsIdx++] ?? { id: SESSION_ID, status },
          read: async () => readSeq[readIdx++] ?? { id: SESSION_ID, status: "running" as SessionStatus },
        },
      },
    };
    const results = await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
    });

    expect(results[5]!.name).toBe("stale-token-rejection");
    expect(results[5]!.status).toBe("failed");
  });

  test("resize-stickiness fails when token is correctly read on poll 1 but incorrectly cleared on poll 2", async () => {
    // FAILS against current code: single-sample read sees correct state on poll 1 and passes sub5.
    // PASSES after fix: second poll reads the delayed incorrect clear and fails sub5 as expected.
    const state = makeState();
    const waitSeq: SessionMeta[] = [
      { id: SESSION_ID, status: "running" },
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: INITIAL_TOKEN },
      { id: SESSION_ID, status: "acknowledged" },
      { id: SESSION_ID, status: "running" },
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN },
    ];
    let wsIdx = 0;
    const readSeq: SessionMeta[] = [
      { id: SESSION_ID, status: "running" },                                            // sub3
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN },  // sub5 poll1: correct
      { id: SESSION_ID, status: "running", attentionMatchedAt: undefined },             // sub5 poll2: delayed clear (BUG)
    ];
    let readIdx = 0;
    const context: Dar05Context = {
      platform: "macos",
      overallDeadline: Date.now() + 120_000,
      build: { clientPath: "/fake/climon", fixturePath: "/fake/fixture" },
      runtime: {
        root: "/fake/root",
        home: "/fake/home",
        baseUrl: "http://127.0.0.1:54321/",
        env: {},
        artifacts: { dir: "/fake/artifacts", appendText: async () => {} },
        sessions: {
          track: () => {},
          waitForStatus: async (_id, status) => waitSeq[wsIdx++] ?? { id: SESSION_ID, status },
          read: async () =>
            readSeq[readIdx++] ?? { id: SESSION_ID, status: "needs-attention" as SessionStatus, attentionMatchedAt: SECOND_TOKEN },
        },
      },
    };

    const results = await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
      pollIntervalMs: 1,
      sleep: async () => {},
    });

    // sub5 must detect the delayed incorrect clear and fail.
    expect(results[4]!.name).toBe("resize-stickiness");
    expect(results[4]!.status).toBe("failed");
    expect(results[4]!.message).toMatch(/expected status to remain needs-attention|expected attentionMatchedAt to remain/i);
  });

  test("stale-token-rejection catches a delayed incorrect clear within observation window", async () => {
    // FAILS against current code: single-sample read sees correct state on poll 1 and passes sub6.
    // PASSES after fix: second poll reads the delayed incorrect clear and fails sub6 as expected.
    const state = makeState();
    const waitSeq: SessionMeta[] = [
      { id: SESSION_ID, status: "running" },
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: INITIAL_TOKEN },
      { id: SESSION_ID, status: "acknowledged" },
      { id: SESSION_ID, status: "running" },
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN },
      // sub7 would need acknowledged, but sub6 should fail before reaching it
    ];
    let wsIdx = 0;
    const readSeq: SessionMeta[] = [
      { id: SESSION_ID, status: "running" },                                           // sub3
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN }, // sub5 poll1
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN }, // sub5 poll2
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN }, // sub5 poll3
      // sub6 poll1: correct state — current single-sample code stops here and PASSES sub6
      { id: SESSION_ID, status: "needs-attention", attentionMatchedAt: SECOND_TOKEN },
      // sub6 poll2: delayed incorrect clear (server bug) — fixed code catches this
      { id: SESSION_ID, status: "acknowledged", attentionMatchedAt: undefined },
    ];
    let readIdx = 0;
    const context: Dar05Context = {
      platform: "macos",
      overallDeadline: Date.now() + 120_000,
      build: { clientPath: "/fake/climon", fixturePath: "/fake/fixture" },
      runtime: {
        root: "/fake/root",
        home: "/fake/home",
        baseUrl: "http://127.0.0.1:54321/",
        env: {},
        artifacts: { dir: "/fake/artifacts", appendText: async () => {} },
        sessions: {
          track: () => {},
          waitForStatus: async (_id, status) => waitSeq[wsIdx++] ?? { id: SESSION_ID, status },
          read: async () =>
            readSeq[readIdx++] ?? { id: SESSION_ID, status: "needs-attention" as SessionStatus, attentionMatchedAt: SECOND_TOKEN },
        },
      },
    };

    const results = await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
    });

    // sub6 must detect the delayed incorrect clear and fail.
    expect(results[5]!.name).toBe("stale-token-rejection");
    expect(results[5]!.status).toBe("failed");
    expect(results[5]!.message).toMatch(/stale token should have been rejected|attentionMatchedAt should remain/i);
  });
});

describe("runDar05 cleanup", () => {
  test("sends EXIT and waits for PTY to exit", async () => {
    const state = makeState();
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);
    const pty = new FakePty({ ...state }, {});

    await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => pty,
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
    });

    expect(pty.writeTextCalls).toContain("EXIT\n");
    expect(pty.waitForExitCalls).toHaveLength(1);
  });

  test("kills PTY when EXIT does not complete in time", async () => {
    const state = makeState();
    const context = makeContext(state);
    const pty = new FakePty(
      { ...state },
      { waitForExitError: new Error("timed out") }
    );

    try {
      await runDar05(context, {
        createBrowserDriver: () => new FakeBrowserDriver(state),
        spawnPty: () => pty,
        findSession: async () => undefined,
        writeConfig: async () => {},
        now: () => Date.now() + 200_000,
      });
    } catch {
      // Cleanup errors are re-thrown; the kill call is what we verify.
    }

    expect(pty.killCalls).toBeGreaterThanOrEqual(1);
  });

  test("closes browser surface on cleanup after successful run", async () => {
    const state = makeState();
    const browser = new FakeBrowserDriver(state);
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => browser,
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
    });

    // After the fix: surface1 (attention-browser) is closed mid-run after sub2 displacement;
    // surface2 (stale-rejection-browser) is the surface left open and closed during cleanup.
    expect(browser.surface1.closeCalls).toHaveLength(1);
    expect(browser.surface1.closeCalls[0]).toBe("attention-browser");
    expect(browser.surface2.closeCalls).toHaveLength(1);
    expect(browser.surface2.closeCalls[0]).toBe("stale-rejection-browser");
  });

  test("writeConfig is called with fast attention.idleSeconds before PTY spawn", async () => {
    const state = makeState();
    const writtenConfigs: Array<{ home: string; config: unknown }> = [];
    let spawnCalled = false;
    const context = makeContext(state);

    await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => {
        spawnCalled = true;
        return new FakePty({ ...state }, { spawnMarker: "spawn error" });
      },
      findSession: async () => undefined,
      writeConfig: async (home, config) => {
        writtenConfigs.push({ home, config });
      },
    });

    expect(writtenConfigs).toHaveLength(1);
    expect(writtenConfigs[0]!.home).toBe("/fake/home");
    const cfg = writtenConfigs[0]!.config as { attention?: { idleSeconds?: number } };
    expect(cfg.attention?.idleSeconds).toBeGreaterThan(0);
    expect(cfg.attention?.idleSeconds).toBeLessThanOrEqual(3);
    expect(spawnCalled).toBe(true);
  });
});

describe("runDar05 PTY input and resize behaviour", () => {
  test("sends CHANGE command with unique token for body-change-reset", async () => {
    const state = makeState();
    const pty = new FakePty({ ...state }, {});
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => pty,
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
    });

    const changeInputs = pty.writeTextCalls.filter((t) => t.startsWith("CHANGE "));
    expect(changeInputs).toHaveLength(1);
    expect(changeInputs[0]).toMatch(/^CHANGE dar05-change-[a-z0-9]+\n$/);
  });

  test("sends a resize during resize-stickiness subcheck", async () => {
    const state = makeState();
    const pty = new FakePty({ ...state }, {});
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => pty,
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
    });

    expect(pty.resizeCalls).toHaveLength(1);
    expect(pty.resizeCalls[0]!.cols).toBeGreaterThan(0);
    expect(pty.resizeCalls[0]!.rows).toBeGreaterThan(0);
  });

  test("passes the stale (initial) token to acknowledgeAttentionToken", async () => {
    const state = makeState();
    const browser = new FakeBrowserDriver(state);
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => browser,
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
    });

    // surface2 receives two token calls: [0] stale initialToken (sub6), [1] current secondToken (sub7).
    // surface2 never calls openTerminal or acknowledgeAttention (non-token form).
    const tokenCalls = browser.surface2.acknowledgeAttentionTokenCalls;
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls[0]!.id).toBe(SESSION_ID);
    // First call: stale INITIAL token (sub6)
    expect(tokenCalls[0]!.token).toBe(INITIAL_TOKEN);
    // Second call: current SECOND token (sub7)
    expect(tokenCalls[1]!.token).toBe(SECOND_TOKEN);
    // surface1 must NOT have received any token acks
    expect(browser.surface1.acknowledgeAttentionTokenCalls).toHaveLength(0);
  });

  test("acknowledgeAttention (not token) is used for current-token acks", async () => {
    const state = makeState();
    const browser = new FakeBrowserDriver(state);
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => browser,
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
    });

    // sub2 current-token ack goes to surface1 via acknowledgeAttention;
    // sub7 current-token ack goes to surface2 via acknowledgeAttentionToken.
    expect(browser.surface1.acknowledgeAttentionCalls).toHaveLength(1);
    expect(browser.surface2.acknowledgeAttentionCalls).toHaveLength(0);  // surface2 never uses non-token form
    // Stale token uses acknowledgeAttentionToken on surface2 (sub6); current token also uses it (sub7)
    expect(browser.surface1.acknowledgeAttentionTokenCalls).toHaveLength(0);
    expect(browser.surface2.acknowledgeAttentionTokenCalls).toHaveLength(2);
  });
});

describe("runDar05 sub2-to-sub3 reclaim: Space, displacement, and surface lifecycle", () => {
  // These tests FAIL against the pre-fix code which writes CHANGE directly after sub2 ack
  // while the browser is still the controller. The fix must: send local Space after sub2 ack,
  // wait for surface1 to become displaced, wait for local quiet, then close surface1, and only
  // then write CHANGE.

  test("sends Space to PTY immediately after sub2 acknowledgement and before CHANGE write", async () => {
    const state = makeState();
    const pty = new FakePty({ ...state }, {});
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => pty,
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
      now: () => Date.now(),
      sleep: async () => {},
      pollIntervalMs: 1,
    });

    const spaceIdx = pty.writeTextCalls.indexOf(" ");
    const changeIdx = pty.writeTextCalls.findIndex((t) => t.startsWith("CHANGE "));
    expect(spaceIdx, "Space must be sent to PTY (sub2 reclaim)").toBeGreaterThan(-1);
    expect(changeIdx, "CHANGE must be sent to PTY (sub3)").toBeGreaterThan(-1);
    expect(spaceIdx, "Space must come before CHANGE").toBeLessThan(changeIdx);
  });

  test("calls waitForDisplaced on surface1 after Space reclaim in sub2", async () => {
    const state = makeState();
    const browser = new FakeBrowserDriver(state);
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => browser,
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
      now: () => Date.now(),
      sleep: async () => {},
    });

    expect(
      browser.surface1.waitForDisplacedCalls,
      "waitForDisplaced must be called on surface1 after sub2 ack"
    ).toHaveLength(1);
    expect(browser.surface1.waitForDisplacedCalls[0]).toBe(SESSION_ID);

    // waitForDisplaced must follow acknowledgeAttention in surface1's call log
    const ackIdx = browser.surface1.callLog.indexOf("acknowledgeAttention");
    const displacedIdx = browser.surface1.callLog.indexOf("waitForDisplaced");
    expect(ackIdx, "acknowledgeAttention must precede waitForDisplaced").toBeGreaterThan(-1);
    expect(displacedIdx, "waitForDisplaced must appear after acknowledgeAttention").toBeGreaterThan(ackIdx);
  });

  test("calls waitForQuiet on PTY after displacement is confirmed", async () => {
    const state = makeState();
    const pty = new FakePty({ ...state }, {});
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => new FakeBrowserDriver(state),
      spawnPty: () => pty,
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
      now: () => Date.now(),
      sleep: async () => {},
    });

    expect(
      pty.waitForQuietCalls,
      "waitForQuiet must be called on PTY after sub2 displacement"
    ).not.toHaveLength(0);
    expect(pty.waitForQuietCalls[0]!.quietPeriodMs).toBeGreaterThan(0);
  });
});

describe("runDar05 two-surface lifecycle", () => {
  // These tests FAIL against the pre-fix code which reuses a single browser surface for both
  // the initial ack phase and the stale-token-rejection phase. The fix must: create a fresh
  // second surface for sub6, open only the dashboard base URL (no openTerminal), inject the
  // stale token, observe rejection, then call openTerminal only in sub7 before the final ack.

  test("creates two browser surfaces: attention-browser for sub2, stale-rejection-browser for sub6", async () => {
    const state = makeState();
    const browser = new FakeBrowserDriver(state);
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => browser,
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
      now: () => Date.now(),
      sleep: async () => {},
    });

    expect(
      browser.createSurfaceCalls,
      "exactly two surfaces must be created"
    ).toHaveLength(2);
    expect(browser.createSurfaceCalls[0]!.name).toBe("attention-browser");
    expect(browser.createSurfaceCalls[1]!.name).not.toBe("attention-browser");
  });

  test("surface1 is closed mid-run after sub2 displacement; surface2 is closed by cleanup", async () => {
    const state = makeState();
    const browser = new FakeBrowserDriver(state);
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => browser,
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
      now: () => Date.now(),
      sleep: async () => {},
    });

    // surface1 closed mid-run; surface2 closed in cleanup
    expect(browser.surface1.closeCalls, "surface1 must be closed once").toHaveLength(1);
    expect(browser.surface2.closeCalls, "surface2 must be closed once (cleanup)").toHaveLength(1);

    // surface1 close must follow waitForDisplaced (displacement confirmed before close)
    const displacedIdx1 = browser.surface1.callLog.indexOf("waitForDisplaced");
    const closeIdx1 = browser.surface1.callLog.indexOf("close");
    expect(displacedIdx1, "waitForDisplaced must precede surface1 close").toBeGreaterThan(-1);
    expect(closeIdx1, "surface1 close must follow waitForDisplaced").toBeGreaterThan(displacedIdx1);
  });

  test("surface2 opens dashboard base URL only — no openTerminal — before stale token injection in sub6", async () => {
    const state = makeState();
    const browser = new FakeBrowserDriver(state);
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => browser,
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
      now: () => Date.now(),
      sleep: async () => {},
    });

    // surface2 must have been opened (open called)
    expect(browser.surface2.openCalls, "surface2 must be opened").toHaveLength(1);
    // surface2 receives two token calls total: [0] stale (sub6), [1] current (sub7)
    expect(
      browser.surface2.acknowledgeAttentionTokenCalls,
      "surface2 must receive two token calls (stale sub6 + current sub7)"
    ).toHaveLength(2);
    expect(browser.surface2.acknowledgeAttentionTokenCalls[0]!.token).toBe(INITIAL_TOKEN);

    // open must precede stale ack in surface2's call log
    const openIdx = browser.surface2.callLog.indexOf("open");
    const staleAckIdx = browser.surface2.callLog.indexOf("acknowledgeAttentionToken");
    expect(openIdx, "surface2 open must precede stale ack").toBeGreaterThan(-1);
    expect(staleAckIdx, "stale ack must follow surface2 open").toBeGreaterThan(openIdx);

    // surface2 must NEVER call openTerminal — phone standalone surface never controls
    expect(browser.surface2.openTerminalCalls, "surface2 must never call openTerminal").toHaveLength(0);
  });
});

describe("runDar05 sub7 direct token acknowledgement", () => {
  // These tests are the failing regression: current sub7 calls openTerminal+acknowledgeAttention
  // which fails on macOS (mobile sidebar session-item absent after maximize).
  // The fix: sub7 directly calls acknowledgeAttentionToken with the captured secondToken,
  // no openTerminal, no acknowledgeAttention on surface2.

  test("surface2 receives two acknowledgeAttentionToken calls in order [initialToken, secondToken]", async () => {
    const state = makeState();
    const browser = new FakeBrowserDriver(state);
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => browser,
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
      now: () => Date.now(),
      sleep: async () => {},
      pollIntervalMs: 1,
    });

    const tokenCalls = browser.surface2.acknowledgeAttentionTokenCalls;
    expect(tokenCalls, "surface2 must receive exactly two token calls").toHaveLength(2);
    expect(tokenCalls[0]!.token, "first call must use stale initialToken (sub6)").toBe(INITIAL_TOKEN);
    expect(tokenCalls[1]!.token, "second call must use current secondToken (sub7)").toBe(SECOND_TOKEN);
    expect(tokenCalls[0]!.id).toBe(SESSION_ID);
    expect(tokenCalls[1]!.id).toBe(SESSION_ID);
  });

  test("surface2 has no openTerminal call — phone standalone surface never controls", async () => {
    const state = makeState();
    const browser = new FakeBrowserDriver(state);
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => browser,
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
    });

    expect(
      browser.surface2.openTerminalCalls,
      "surface2 must never call openTerminal"
    ).toHaveLength(0);
  });

  test("surface2 has no acknowledgeAttention (non-token) call — sub7 uses token form only", async () => {
    const state = makeState();
    const browser = new FakeBrowserDriver(state);
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => browser,
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
    });

    expect(
      browser.surface2.acknowledgeAttentionCalls,
      "surface2 must never call acknowledgeAttention (non-token)"
    ).toHaveLength(0);
  });

  test("cleanup sends EXIT after surface2 close — no sub7 reclaim Space (local terminal never displaced)", async () => {
    const state = makeState();
    const pty = new FakePty({ ...state }, {});
    const browser = new FakeBrowserDriver(state);
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => browser,
      spawnPty: () => pty,
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
      now: () => Date.now(),
      sleep: async () => {},
      pollIntervalMs: 1,
    });

    // Only one Space: the sub2 reclaim. No sub7 reclaim needed since surface2 never controls.
    const spaceCalls = pty.writeTextCalls.filter((t) => t === " ");
    expect(spaceCalls, "only sub2 sends Space — no sub7 reclaim").toHaveLength(1);

    // EXIT is sent safely since local terminal is never displaced by sub7
    expect(pty.writeTextCalls).toContain("EXIT\n");
    expect(pty.waitForExitCalls).toHaveLength(1);

    // surface2 is closed during cleanup
    expect(browser.surface2.closeCalls).toHaveLength(1);
  });
});

describe("runDar05 stale-surface viewport and display-mode", () => {
  test("creates stale-rejection-browser with phone viewport (390x844) and standalone display mode", async () => {
    const state = makeState();
    const browser = new FakeBrowserDriver(state);
    const { waitSeq, readSeq } = makeHappyPathSeqs();
    const context = makeSequencedContext(state, waitSeq, readSeq);

    await runDar05(context, {
      createBrowserDriver: () => browser,
      spawnPty: () => new FakePty({ ...state }, {}),
      findSession: async () => ({ id: SESSION_ID, status: "running" as const }),
      writeConfig: async () => {},
      now: () => Date.now(),
      sleep: async () => {},
      pollIntervalMs: 1,
    });

    expect(
      browser.createSurfaceCalls,
      "exactly two surfaces must be created"
    ).toHaveLength(2);
    expect(
      browser.createSurfaceCalls[1]!.viewport,
      "stale-rejection surface must use phone viewport 390x844"
    ).toEqual({ width: 390, height: 844 });
    expect(
      browser.createSurfaceCalls[1]!.displayMode,
      "stale-rejection surface must use standalone display mode"
    ).toBe("standalone");
  });
});
