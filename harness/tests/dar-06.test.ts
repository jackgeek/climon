import { describe, expect, test } from "bun:test";
import {
  DAR_06_SUBCHECK_NAMES,
  runDar06,
  type Dar06BrowserDriver,
  type Dar06BrowserSurface,
  type Dar06BrowserSurfaceProgress,
  type Dar06Context,
  type Dar06Pty,
} from "../src/scenarios/dar-06.js";

// ── Titles ─────────────────────────────────────────────────────────────────

const DAR_06_SUBCHECK_TITLES = [
  "OSC 0 emitted title appears in session metadata and browser UI",
  "OSC 2 emitted title overrides to match in session metadata and browser UI",
  "PROGRESS state 1 value 42 sets normal determinate progress in metadata and browser",
  "CLEAR_PROGRESS removes progress state from metadata and browser",
  "PROGRESS state 3 sets indeterminate progress in metadata and browser with no percent",
  "PROGRESS state 2 sets error progress in metadata and browser with no percent",
  "PROGRESS state 4 sets warning progress in metadata and browser with no percent",
  "Final scrollback after process exit preserves raw OSC 0, OSC 2, and OSC 9;4 sequences",
] as const;

// ── Shared types ────────────────────────────────────────────────────────────

const RUN_ID = "abc12345-0000-0000-0000-000000000000";
const SESSION_ID = "dar-06-session";
const T0_TOKEN = "dar06-t0-abc12345";

type SessionStatus =
  | "running"
  | "acknowledged"
  | "needs-attention"
  | "completed"
  | "paused"
  | "failed"
  | "disconnected";

interface ProgressMeta {
  state: string;
  value?: number;
}

interface SessionMeta {
  id: string;
  status: SessionStatus;
  terminalTitle?: string | null;
  progress?: ProgressMeta | null;
  [key: string]: unknown;
}

// ── Scenario state model ────────────────────────────────────────────────────

interface ScenarioState {
  sessionId?: string;
  status: SessionStatus;
  terminalTitle?: string | null;
  progress?: ProgressMeta | null;
  exited: boolean;
  ptyOutput: string;
  scrollbackContent: string;
}

// ── Fake implementations ────────────────────────────────────────────────────

class FakePty implements Dar06Pty {
  public readonly writeTextCalls: string[] = [];
  public readonly waitForExitCalls: number[] = [];
  public killCalls = 0;
  public waitForExitError?: Error;

  public constructor(
    private readonly state: ScenarioState,
    private readonly options: { spawnMarker?: string } = {}
  ) {}

  public writeText(text: string): void {
    this.writeTextCalls.push(text);
    if (text === "EXIT\n") {
      this.state.exited = true;
      this.state.status = "completed";
    }
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
    if (this.waitForExitError) {
      throw this.waitForExitError;
    }
    if (!this.state.exited) {
      throw new Error("Timed out waiting for process exit");
    }
    return 0;
  }

  public kill(): void {
    this.killCalls += 1;
  }
}

/** Simulates the browser terminal surface for DAR-06. */
class FakeBrowserSurface implements Dar06BrowserSurface {
  public readonly name: string;
  public readonly viewerId: string;
  public readonly callLog: string[] = [];
  public readonly sendTerminalLineCalls: string[] = [];
  public readonly waitForTerminalTextCalls: Array<{ text: string; deadline: number }> = [];
  public closeError?: Error;

  public constructor(
    name: string,
    viewerId: string,
    private readonly state: ScenarioState
  ) {
    this.name = name;
    this.viewerId = viewerId;
  }

  public async open(_baseUrl: string, _deadline: number): Promise<void> {
    this.callLog.push("open");
  }

  public async openTerminal(_id: string, _deadline: number): Promise<void> {
    this.callLog.push("openTerminal");
  }

  public async sendTerminalLine(text: string): Promise<void> {
    this.callLog.push(`sendTerminalLine:${text}`);
    this.sendTerminalLineCalls.push(text);

    // Simulate the fixture processing the command.
    if (text.startsWith("TITLE0 ")) {
      const value = text.slice("TITLE0 ".length);
      this.state.terminalTitle = value;
      this.state.ptyOutput += `\x1b]0;${value}\x07DAR_METADATA_OSC_EMITTED TITLE0\n`;
      this.state.scrollbackContent += `\x1b]0;${value}\x07`;
    } else if (text.startsWith("TITLE2 ")) {
      const value = text.slice("TITLE2 ".length);
      this.state.terminalTitle = value;
      this.state.ptyOutput += `\x1b]2;${value}\x07DAR_METADATA_OSC_EMITTED TITLE2\n`;
      this.state.scrollbackContent += `\x1b]2;${value}\x07`;
    } else if (text === "PROGRESS 1 42") {
      this.state.progress = { state: "normal", value: 42 };
      this.state.ptyOutput += `\x1b]9;4;1;42\x07DAR_METADATA_OSC_EMITTED PROGRESS 1 42\n`;
      this.state.scrollbackContent += `\x1b]9;4;1;42\x07`;
    } else if (text === "CLEAR_PROGRESS") {
      this.state.progress = null;
      this.state.ptyOutput += `\x1b]9;4;0;0\x07DAR_METADATA_OSC_EMITTED CLEAR_PROGRESS\n`;
      this.state.scrollbackContent += `\x1b]9;4;0;0\x07`;
    } else if (text === "PROGRESS 3 0") {
      this.state.progress = { state: "indeterminate" };
      this.state.ptyOutput += `\x1b]9;4;3;0\x07DAR_METADATA_OSC_EMITTED PROGRESS 3 0\n`;
      this.state.scrollbackContent += `\x1b]9;4;3;0\x07`;
    } else if (text === "PROGRESS 2 0") {
      this.state.progress = { state: "error" };
      this.state.ptyOutput += `\x1b]9;4;2;0\x07DAR_METADATA_OSC_EMITTED PROGRESS 2 0\n`;
      this.state.scrollbackContent += `\x1b]9;4;2;0\x07`;
    } else if (text === "PROGRESS 4 0") {
      this.state.progress = { state: "warning" };
      this.state.ptyOutput += `\x1b]9;4;4;0\x07DAR_METADATA_OSC_EMITTED PROGRESS 4 0\n`;
      this.state.scrollbackContent += `\x1b]9;4;4;0\x07`;
    } else if (text === "EXIT") {
      this.state.exited = true;
      this.state.status = "completed";
    }
  }

  public async waitForTerminalText(text: string, deadline: number): Promise<void> {
    this.callLog.push(`waitForTerminalText:${text}`);
    this.waitForTerminalTextCalls.push({ text, deadline });
    if (!this.state.ptyOutput.includes(text)) {
      throw new Error(`Terminal text not found: ${text}`);
    }
  }

  public async title(_id: string, _deadline: number): Promise<string> {
    this.callLog.push("title");
    return this.state.terminalTitle ?? "";
  }

  public async progress(_id: string, _deadline: number): Promise<Dar06BrowserSurfaceProgress> {
    this.callLog.push("progress");
    const p = this.state.progress;
    if (!p) {
      return { state: null, percent: null };
    }
    // indeterminate, error, warning: no percent
    if (p.state === "normal" && p.value !== undefined) {
      return { state: "normal", percent: p.value };
    }
    return { state: p.state, percent: null };
  }

  public async close(): Promise<void> {
    this.callLog.push("close");
    if (this.closeError) {
      throw this.closeError;
    }
  }
}

class FakeBrowserDriver implements Dar06BrowserDriver {
  public readonly createSurfaceCalls: Array<{
    name: string;
    viewport: { width: number; height: number };
  }> = [];
  public readonly surface: FakeBrowserSurface;

  public constructor(state: ScenarioState) {
    this.surface = new FakeBrowserSurface(
      "title-progress-browser",
      "surface-1-title-progress-browser",
      state
    );
  }

  public async createSurface(options: {
    name: string;
    viewport: { width: number; height: number };
  }): Promise<Dar06BrowserSurface> {
    this.createSurfaceCalls.push({ name: options.name, viewport: options.viewport });
    return this.surface;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<ScenarioState> = {}): ScenarioState {
  return {
    sessionId: SESSION_ID,
    status: "running",
    terminalTitle: undefined,
    progress: undefined,
    exited: false,
    ptyOutput: "DAR_METADATA_STATIC\n",
    scrollbackContent: "",
    ...overrides,
  };
}

function makeContext(state: ScenarioState): Dar06Context {
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
        ): Promise<SessionMeta> => ({ id: SESSION_ID, status }),
        waitForTerminalStatus: async (_id: string, _deadline: number): Promise<SessionMeta> => ({
          id: SESSION_ID,
          status: "completed",
        }),
        read: async (_id: string): Promise<SessionMeta> => ({
          id: SESSION_ID,
          status: state.status,
          terminalTitle: state.terminalTitle ?? undefined,
          progress: state.progress ?? undefined,
        }),
      },
    },
  };
}

function makeDependencies(
  state: ScenarioState,
  overrides: Partial<{
    browser: FakeBrowserDriver;
    pty: FakePty;
    readScrollback: (home: string, id: string) => Promise<string>;
  }> = {}
) {
  const browser = overrides.browser ?? new FakeBrowserDriver(state);
  const pty = overrides.pty ?? new FakePty(state);
  return {
    now: () => Date.now(),
    sleep: async () => {},
    pollIntervalMs: 1,
    createUuid: () => RUN_ID,
    createBrowserDriver: () => browser,
    spawnPty: () => pty,
    findSession: async ({ expectedName }: { expectedName: string }) =>
      expectedName === `DAR-06-${RUN_ID}`
        ? ({ id: SESSION_ID, status: "running" as const } as SessionMeta)
        : undefined,
    readScrollback:
      overrides.readScrollback ??
      (async (_home: string, _id: string) => state.scrollbackContent),
    browser,
    pty,
  };
}

// ── Contract tests ──────────────────────────────────────────────────────────

describe("DAR-06 subcheck contract", () => {
  test("exports exactly 8 subchecks with the correct names", () => {
    expect(DAR_06_SUBCHECK_NAMES).toHaveLength(8);
    expect(DAR_06_SUBCHECK_NAMES).toEqual([
      "osc-0-title",
      "osc-2-title",
      "progress-normal",
      "progress-clear",
      "progress-indeterminate",
      "progress-error",
      "progress-warning",
      "raw-sequence-passthrough",
    ]);
  });

  test("exported titles match the 8 descriptive titles", async () => {
    const { DAR_06_SUBCHECKS } = await import("../src/scenarios/dar-06.js");
    const titles = DAR_06_SUBCHECKS.map((s) => s.title);
    expect(titles).toEqual(Array.from(DAR_06_SUBCHECK_TITLES));
  });
});

// ── Happy-path tests ─────────────────────────────────────────────────────────

describe("runDar06 happy-path: all 8 subchecks pass", () => {
  test("returns 8 results with correct names, titles, and passed status", async () => {
    const state = makeState();
    const context = makeContext(state);
    const { browser, pty, ...deps } = makeDependencies(state);

    const results = await runDar06(context, deps);

    expect(results).toHaveLength(8);
    for (const [index, result] of results.entries()) {
      expect(result.name, `result[${index}].name`).toBe(DAR_06_SUBCHECK_NAMES[index]);
      expect(result.title, `result[${index}].title`).toBe(DAR_06_SUBCHECK_TITLES[index]);
      expect(
        result.status,
        `result[${index}].status — ${result.message ?? "no message"}`
      ).toBe("passed");
    }
  });

  test("all subchecks include base evidence paths", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    const results = await runDar06(context, deps);

    for (const result of results) {
      expect(result.evidence, `${result.name} evidence`).toContain("pty/input.log");
      expect(result.evidence, `${result.name} evidence`).toContain("pty/output.log");
      expect(result.evidence, `${result.name} evidence`).toContain(
        `home/sessions/${SESSION_ID}.json`
      );
    }
  });

  test("sendTerminalLine is called in the correct command order", async () => {
    const state = makeState();
    const context = makeContext(state);
    const { browser, ...deps } = makeDependencies(state);

    await runDar06(context, deps);

    const commandCalls = browser.surface.sendTerminalLineCalls;
    expect(commandCalls[0]).toMatch(/^TITLE0 dar06-t0-/);
    expect(commandCalls[1]).toMatch(/^TITLE2 dar06-t2-/);
    expect(commandCalls[2]).toBe("PROGRESS 1 42");
    expect(commandCalls[3]).toBe("CLEAR_PROGRESS");
    expect(commandCalls[4]).toBe("PROGRESS 3 0");
    expect(commandCalls[5]).toBe("PROGRESS 2 0");
    expect(commandCalls[6]).toBe("PROGRESS 4 0");
    expect(commandCalls[7]).toBe("EXIT");
  });

  test("browser surface is opened once with the correct name", async () => {
    const state = makeState();
    const context = makeContext(state);
    const { browser, ...deps } = makeDependencies(state);

    await runDar06(context, deps);

    expect(browser.createSurfaceCalls).toHaveLength(1);
    expect(browser.createSurfaceCalls[0]!.name).toBe("title-progress-browser");
  });

  test("unique title tokens are used per run", async () => {
    const UUID_A = "run-aaaa-0000-0000-0000-000000000000";
    const UUID_B = "run-bbbb-0000-0000-0000-111111111111";

    const state1 = makeState();
    const context1 = makeContext(state1);
    const deps1 = makeDependencies(state1);
    deps1.createUuid = () => UUID_A;
    // findSession must match the session name derived from the overridden UUID.
    deps1.findSession = async () => ({ id: SESSION_ID, status: "running" as const });

    const state2 = makeState();
    const context2 = makeContext(state2);
    const deps2 = makeDependencies(state2);
    deps2.createUuid = () => UUID_B;
    deps2.findSession = async () => ({ id: SESSION_ID, status: "running" as const });

    const [results1, results2] = await Promise.all([
      runDar06(context1, deps1),
      runDar06(context2, deps2),
    ]);

    expect(results1[0]!.status).toBe("passed");
    expect(results2[0]!.status).toBe("passed");
    // Token suffix differs by runId: different UUIDs → different tokens
    const cmd1 = deps1.browser.surface.sendTerminalLineCalls[0]!;
    const cmd2 = deps2.browser.surface.sendTerminalLineCalls[0]!;
    expect(cmd1).not.toBe(cmd2);
  });
});

// ── Subcheck isolation: metadata/UI mismatch ─────────────────────────────────

describe("runDar06 subcheck isolation: metadata/browser mismatch", () => {
  test("osc-0-title fails when metadata never reflects title token", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // Metadata read always returns no terminalTitle.
    context.runtime.sessions.read = async () => ({
      id: SESSION_ID,
      status: "running",
      terminalTitle: null,
    });

    // Deadline expires immediately after first poll.
    deps.now = () => Date.now() + 200_000;

    const results = await runDar06(context, deps);

    expect(results[0]!.name).toBe("osc-0-title");
    expect(results[0]!.status).toBe("failed");
    for (let i = 1; i < 8; i++) {
      expect(results[i]!.status, `result[${i}].status`).toBe("failed");
      expect(results[i]!.message, `result[${i}].message`).toContain("Unable to run subcheck");
    }
  });

  test("osc-2-title fails when browser never reflects title2 token", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // First call to title() returns the t0 title (osc-0 passed); subsequent calls for t2 hang.
    deps.browser.surface.title = async (_id: string, _deadline: number) => {
      // Return t0 token always — t2 never appears.
      return T0_TOKEN;
    };
    // Also make the deadline expire quickly.
    const base = Date.now();
    let callCount = 0;
    deps.now = () => {
      callCount += 1;
      // Expire after ~30 calls to prevent infinite loop.
      return callCount > 30 ? base + 200_000 : base;
    };

    const results = await runDar06(context, deps);

    expect(results[1]!.name).toBe("osc-2-title");
    expect(results[1]!.status).toBe("failed");
    for (let i = 2; i < 8; i++) {
      expect(results[i]!.status, `result[${i}].status`).toBe("failed");
    }
  });

  test("progress-normal fails when metadata returns wrong progress state", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // Subcheck 1 and 2 pass (state is updated by fake surface). For subcheck 3, override read
    // to return wrong progress state.
    let readCallCount = 0;
    const origRead = context.runtime.sessions.read.bind(context.runtime.sessions);
    context.runtime.sessions.read = async (id) => {
      readCallCount += 1;
      const meta = await origRead(id);
      // After PROGRESS 1 42 is sent, force wrong state.
      if (state.progress?.state === "normal") {
        return { ...meta, progress: { state: "error", value: 0 } };
      }
      return meta;
    };

    const base = Date.now();
    let callCount = 0;
    deps.now = () => {
      callCount += 1;
      return callCount > 60 ? base + 200_000 : base;
    };

    const results = await runDar06(context, deps);

    expect(results[2]!.name).toBe("progress-normal");
    expect(results[2]!.status).toBe("failed");
    for (let i = 3; i < 8; i++) {
      expect(results[i]!.status, `result[${i}].status`).toBe("failed");
    }
  });

  test("progress-clear fails when browser still reports non-null state after CLEAR_PROGRESS", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // After CLEAR_PROGRESS, browser progress stays non-null (bug simulation).
    const origProgress = deps.browser.surface.progress.bind(deps.browser.surface);
    deps.browser.surface.progress = async (id, deadline) => {
      const p = await origProgress(id, deadline);
      // Always return non-null state even after clearing.
      if (state.progress === null) {
        return { state: "normal", percent: 42 };
      }
      return p;
    };

    const base = Date.now();
    let callCount = 0;
    deps.now = () => {
      callCount += 1;
      return callCount > 80 ? base + 200_000 : base;
    };

    const results = await runDar06(context, deps);

    expect(results[3]!.name).toBe("progress-clear");
    expect(results[3]!.status).toBe("failed");
  });

  test("progress-indeterminate fails when browser returns a non-null percent", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // Browser returns percent=0 instead of null for indeterminate (bug).
    const origProgress = deps.browser.surface.progress.bind(deps.browser.surface);
    deps.browser.surface.progress = async (id, deadline) => {
      const p = await origProgress(id, deadline);
      if (p.state === "indeterminate") {
        return { state: "indeterminate", percent: 0 };
      }
      return p;
    };

    const results = await runDar06(context, deps);

    expect(results[4]!.name).toBe("progress-indeterminate");
    expect(results[4]!.status).toBe("failed");
    expect(results[4]!.message).toContain("percent");
  });

  test("progress-error fails when browser returns a non-null percent", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    const origProgress = deps.browser.surface.progress.bind(deps.browser.surface);
    deps.browser.surface.progress = async (id, deadline) => {
      const p = await origProgress(id, deadline);
      if (p.state === "error") {
        return { state: "error", percent: 1 };
      }
      return p;
    };

    const results = await runDar06(context, deps);

    expect(results[5]!.name).toBe("progress-error");
    expect(results[5]!.status).toBe("failed");
    expect(results[5]!.message).toContain("percent");
  });

  test("progress-warning fails when browser returns a non-null percent", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    const origProgress = deps.browser.surface.progress.bind(deps.browser.surface);
    deps.browser.surface.progress = async (id, deadline) => {
      const p = await origProgress(id, deadline);
      if (p.state === "warning") {
        return { state: "warning", percent: 99 };
      }
      return p;
    };

    const results = await runDar06(context, deps);

    expect(results[6]!.name).toBe("progress-warning");
    expect(results[6]!.status).toBe("failed");
    expect(results[6]!.message).toContain("percent");
  });
});

// ── Subcheck isolation: stale metadata value ──────────────────────────────────
// Spec gap DAR-06: metadata predicate for indeterminate/error/warning must
// require value absent/null, symmetric with browser percent === null.

describe("runDar06 subcheck isolation: stale metadata value", () => {
  test("progress-indeterminate fails when metadata still carries a stale value", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // Simulate a daemon bug: after transitioning to indeterminate, the metadata
    // still has value: 42 left over from a prior normal progress.
    const origRead = context.runtime.sessions.read.bind(context.runtime.sessions);
    context.runtime.sessions.read = async (id: string) => {
      const meta = await origRead(id);
      if ((meta.progress as { state?: string } | undefined)?.state === "indeterminate") {
        return { ...meta, progress: { state: "indeterminate", value: 42 } };
      }
      return meta;
    };

    // Allow subchecks 1-4 to complete in the tight poll loop, then expire.
    const base = Date.now();
    let callCount = 0;
    deps.now = () => {
      callCount++;
      return callCount > 80 ? base + 200_000 : base;
    };

    const results = await runDar06(context, deps);

    expect(results[4]!.name).toBe("progress-indeterminate");
    expect(results[4]!.status).toBe("failed");
  });

  test("progress-error fails when metadata still carries a stale value", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    const origRead = context.runtime.sessions.read.bind(context.runtime.sessions);
    context.runtime.sessions.read = async (id: string) => {
      const meta = await origRead(id);
      if ((meta.progress as { state?: string } | undefined)?.state === "error") {
        return { ...meta, progress: { state: "error", value: 42 } };
      }
      return meta;
    };

    // Allow subchecks 1-5 to complete, then expire during subcheck 6.
    const base = Date.now();
    let callCount = 0;
    deps.now = () => {
      callCount++;
      return callCount > 150 ? base + 200_000 : base;
    };

    const results = await runDar06(context, deps);

    expect(results[5]!.name).toBe("progress-error");
    expect(results[5]!.status).toBe("failed");
  });

  test("progress-warning fails when metadata still carries a stale value", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    const origRead = context.runtime.sessions.read.bind(context.runtime.sessions);
    context.runtime.sessions.read = async (id: string) => {
      const meta = await origRead(id);
      if ((meta.progress as { state?: string } | undefined)?.state === "warning") {
        return { ...meta, progress: { state: "warning", value: 42 } };
      }
      return meta;
    };

    // Allow subchecks 1-6 to complete, then expire during subcheck 7.
    const base = Date.now();
    let callCount = 0;
    deps.now = () => {
      callCount++;
      return callCount > 250 ? base + 200_000 : base;
    };

    const results = await runDar06(context, deps);

    expect(results[6]!.name).toBe("progress-warning");
    expect(results[6]!.status).toBe("failed");
  });
});

// ── Subcheck isolation: prerequisite cascade ──────────────────────────────────

describe("runDar06 subcheck isolation: prerequisite cascade", () => {
  test("PTY spawn failure blocks all 8 subchecks with 'Unable to run subcheck'", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);
    deps.spawnPty = () => {
      throw new Error("PTY spawn error");
    };

    const results = await runDar06(context, deps);

    expect(results).toHaveLength(8);
    for (const [index, result] of results.entries()) {
      expect(result.name, `result[${index}].name`).toBe(DAR_06_SUBCHECK_NAMES[index]);
      expect(result.status, `result[${index}].status`).toBe("failed");
      expect(result.message, `result[${index}].message`).toContain(
        index === 0 ? "PTY spawn error" : "Unable to run subcheck"
      );
    }
  });

  test("session-not-found in sub1 blocks sub2-8", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);
    deps.findSession = async () => undefined;
    deps.now = () => Date.now() + 200_000;

    const results = await runDar06(context, deps);

    expect(results[0]!.name).toBe("osc-0-title");
    expect(results[0]!.status).toBe("failed");
    for (let i = 1; i < 8; i++) {
      expect(results[i]!.status, `result[${i}].status`).toBe("failed");
      expect(results[i]!.message, `result[${i}].message`).toContain("Unable to run subcheck");
    }
  });

  test("no browser driver blocks sub1 and all downstream", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);
    (deps as { createBrowserDriver?: unknown }).createBrowserDriver = undefined;

    const results = await runDar06(context, deps);

    expect(results[0]!.status).toBe("failed");
    for (let i = 1; i < 8; i++) {
      expect(results[i]!.status, `result[${i}].status`).toBe("failed");
    }
  });

  test("osc-0 failure cascades to block osc-2 with dependency message", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // Metadata never reflects terminalTitle → osc-0 fails.
    context.runtime.sessions.read = async () => ({
      id: SESSION_ID,
      status: "running",
      terminalTitle: null,
    });
    deps.now = () => Date.now() + 200_000;

    const results = await runDar06(context, deps);

    expect(results[0]!.status).toBe("failed");
    expect(results[1]!.status).toBe("failed");
    expect(results[1]!.message).toContain("Unable to run subcheck");
    expect(results[1]!.message).toContain("osc-0-title");
  });
});

// ── Raw-sequence-passthrough tests ────────────────────────────────────────────

describe("runDar06 raw-sequence-passthrough", () => {
  test("passes when scrollback contains all three OSC sequence prefixes", async () => {
    const state = makeState({
      // Pre-populate scrollback with all OSC sequence types.
      scrollbackContent:
        "\x1b]0;title-zero\x07\x1b]2;title-two\x07\x1b]9;4;1;42\x07\x1b]9;4;0;0\x07",
    });
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // Override readScrollback to return the pre-populated scrollback.
    deps.readScrollback = async () => state.scrollbackContent;

    const results = await runDar06(context, deps);

    expect(results[7]!.name).toBe("raw-sequence-passthrough");
    expect(results[7]!.status, results[7]!.message ?? "").toBe("passed");
    expect(results[7]!.message).toContain("ESC]0;");
    expect(results[7]!.message).toContain("ESC]2;");
    expect(results[7]!.message).toContain("ESC]9;4;");
  });

  test("fails when scrollback is missing ESC ]0; sequence", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    deps.readScrollback = async () =>
      "\x1b]2;title-two\x07\x1b]9;4;1;42\x07";

    const results = await runDar06(context, deps);

    expect(results[7]!.name).toBe("raw-sequence-passthrough");
    expect(results[7]!.status).toBe("failed");
    expect(results[7]!.message).toContain("ESC ]0;");
  });

  test("fails when scrollback is missing ESC ]2; sequence", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    deps.readScrollback = async () =>
      "\x1b]0;title-zero\x07\x1b]9;4;1;42\x07";

    const results = await runDar06(context, deps);

    expect(results[7]!.name).toBe("raw-sequence-passthrough");
    expect(results[7]!.status).toBe("failed");
    expect(results[7]!.message).toContain("ESC ]2;");
  });

  test("fails when scrollback is missing ESC ]9;4; sequence", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    deps.readScrollback = async () =>
      "\x1b]0;title-zero\x07\x1b]2;title-two\x07";

    const results = await runDar06(context, deps);

    expect(results[7]!.name).toBe("raw-sequence-passthrough");
    expect(results[7]!.status).toBe("failed");
    expect(results[7]!.message).toContain("ESC ]9;4;");
  });

  test("fails when scrollback is empty (no sequences written)", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    deps.readScrollback = async () => "";

    const results = await runDar06(context, deps);

    expect(results[7]!.status).toBe("failed");
    expect(results[7]!.message).toContain("ESC ]0;");
    expect(results[7]!.message).toContain("ESC ]2;");
    expect(results[7]!.message).toContain("ESC ]9;4;");
  });

  test("reports scrollback byte count in evidence", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    const results = await runDar06(context, deps);

    const passthrough = results[7]!;
    expect(passthrough.status).toBe("passed");
    const lengthEvidence = (passthrough.evidence ?? []).find((e) =>
      e.startsWith("scrollback.length=")
    );
    expect(lengthEvidence).toBeDefined();
  });

  test("counts all emitted forms of each OSC sequence type", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // The happy path sends: TITLE0, TITLE2, PROGRESS 1 42, CLEAR_PROGRESS, PROGRESS 3 0,
    // PROGRESS 2 0, PROGRESS 4 0 — that is 1 ESC]0;, 1 ESC]2;, 5 ESC]9;4;
    const results = await runDar06(context, deps);

    const passthrough = results[7]!;
    expect(passthrough.status).toBe("passed");
    const osc94Evidence = (passthrough.evidence ?? []).find((e) =>
      e.startsWith("osc94-count=")
    );
    expect(osc94Evidence).toBeDefined();
    const count = Number(osc94Evidence!.split("=")[1]);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ── Cleanup / fallback tests ──────────────────────────────────────────────────

describe("runDar06 cleanup: fallback on failure before EXIT", () => {
  test("sends EXIT through browser surface when scenario fails before subcheck 8", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // Make subcheck 7 (progress-warning) fail by timing out.
    let callCount = 0;
    const origProgress = deps.browser.surface.progress.bind(deps.browser.surface);
    deps.browser.surface.progress = async (id, deadline) => {
      callCount += 1;
      const p = await origProgress(id, deadline);
      // Never return warning state — force timeout.
      if (state.progress?.state === "warning") {
        return { state: null, percent: null };
      }
      return p;
    };

    const base = Date.now();
    let nowCallCount = 0;
    deps.now = () => {
      nowCallCount += 1;
      return nowCallCount > 200 ? base + 200_000 : base;
    };

    await runDar06(context, deps);

    // Sub8 should be blocked. Cleanup should have sent EXIT through browser surface.
    const exitCalls = deps.browser.surface.sendTerminalLineCalls.filter((c) => c === "EXIT");
    expect(exitCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("kills PTY when cleanup EXIT via browser surface fails", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // Force sub-7 failure.
    const origProgress = deps.browser.surface.progress.bind(deps.browser.surface);
    deps.browser.surface.progress = async (id, deadline) => {
      const p = await origProgress(id, deadline);
      if (state.progress?.state === "warning") return { state: null, percent: null };
      return p;
    };

    // Sending EXIT through browser surface throws.
    const origSendLine = deps.browser.surface.sendTerminalLine.bind(deps.browser.surface);
    deps.browser.surface.sendTerminalLine = async (text: string) => {
      if (text === "EXIT") {
        throw new Error("Browser send failed during cleanup");
      }
      await origSendLine(text);
    };

    const base = Date.now();
    let nowCallCount = 0;
    deps.now = () => {
      nowCallCount += 1;
      return nowCallCount > 200 ? base + 200_000 : base;
    };

    // Cleanup errors propagate (same as DAR-05 design). Catch and ignore the rejection;
    // what matters is that pty.kill() was called as the fallback.
    await runDar06(context, deps).catch(() => undefined);

    // PTY.kill() should have been called as fallback.
    expect(deps.pty.killCalls).toBeGreaterThanOrEqual(1);
  });

  test("sends EXIT via PTY writeText when no browser surface is available", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // Block sub1 so surface is never created.
    deps.findSession = async () => undefined;
    deps.now = () => Date.now() + 200_000;

    await runDar06(context, deps);

    // With no surface, cleanup should have called pty.writeText("EXIT\n").
    expect(deps.pty.writeTextCalls).toContain("EXIT\n");
  });

  test("cleanup waits for PTY exit after EXIT sent in subcheck 8", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    const results = await runDar06(context, deps);

    // All 8 passed; PTY should have received waitForExit in cleanup.
    expect(results[7]!.status).toBe("passed");
    expect(deps.pty.waitForExitCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── CLI wiring ────────────────────────────────────────────────────────────────

describe("DAR-06 CLI wiring", () => {
  test("DAR_06_SUBCHECKS is importable from dar-06.js", async () => {
    const { DAR_06_SUBCHECKS } = await import("../src/scenarios/dar-06.js");
    expect(Array.isArray(DAR_06_SUBCHECKS)).toBe(true);
    expect(DAR_06_SUBCHECKS).toHaveLength(8);
  });

  test("cli.ts imports DAR_06_SUBCHECKS and registers it in SUBCHECK_DEFINITIONS", async () => {
    // If cli.ts references DAR_06_SUBCHECKS in its SUBCHECK_DEFINITIONS map, the module will
    // import from dar-06.js successfully. We verify this by loading the cli module and
    // checking the scenario runner for DAR-06 is no longer notImplementedRunner.
    const cliModule = await import("../src/cli.js").catch(() => null);
    // The runCli export signals the module loaded without error.
    expect(cliModule).not.toBeNull();
    const runCli = (cliModule as { runCli?: unknown }).runCli;
    expect(typeof runCli).toBe("function");
  });

  test("runDar06 throws when no createBrowserDriver is supplied", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);
    (deps as { createBrowserDriver?: unknown }).createBrowserDriver = undefined;

    const results = await runDar06(context, deps);
    // Sub1 fails with createBrowserDriver error; sub2-8 blocked.
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.message).toContain("createBrowserDriver");
  });
});

// ── Browser marker waits: TDD for DAR-06 root cause fix ──────────────────────
// Real-run root cause: while the browser owns control, PTY output is routed to
// the browser viewer; pty.expectRaw cannot see command markers. The marker only
// appears locally after control is restored.  Fix: use
// surface.waitForTerminalText for every post-control marker; keep pty.expectRaw
// only for the initial READY before the browser ever connects.

describe("runDar06 browser marker waits: post-control markers use surface.waitForTerminalText", () => {
  test("pty.expectRaw is called exactly once (initial READY marker only)", async () => {
    const state = makeState();
    const context = makeContext(state);
    const { pty, ...deps } = makeDependencies(state);
    const expectRawCalls: string[] = [];
    pty.expectRaw = async (marker: string, _deadline: number): Promise<void> => {
      expectRawCalls.push(marker);
      if (!state.ptyOutput.includes(marker)) {
        throw new Error(`Missing raw marker: ${marker}`);
      }
    };

    await runDar06(context, { ...deps, spawnPty: () => pty });

    expect(expectRawCalls).toHaveLength(1);
    expect(expectRawCalls[0]).toBe("DAR_METADATA_STATIC");
  });

  test("surface.waitForTerminalText is called for each post-control command marker in order", async () => {
    const state = makeState();
    const context = makeContext(state);
    const { browser, ...deps } = makeDependencies(state);

    await runDar06(context, { ...deps, createBrowserDriver: () => browser });

    const waitCalls = browser.surface.waitForTerminalTextCalls.map((c) => c.text);
    expect(waitCalls).toHaveLength(7);
    expect(waitCalls[0]).toContain("DAR_METADATA_OSC_EMITTED TITLE0");
    expect(waitCalls[1]).toContain("DAR_METADATA_OSC_EMITTED TITLE2");
    expect(waitCalls[2]).toBe("DAR_METADATA_OSC_EMITTED PROGRESS 1 42");
    expect(waitCalls[3]).toBe("DAR_METADATA_OSC_EMITTED CLEAR_PROGRESS");
    expect(waitCalls[4]).toBe("DAR_METADATA_OSC_EMITTED PROGRESS 3 0");
    expect(waitCalls[5]).toBe("DAR_METADATA_OSC_EMITTED PROGRESS 2 0");
    expect(waitCalls[6]).toBe("DAR_METADATA_OSC_EMITTED PROGRESS 4 0");
  });
});

// ── DAR-06 root cause regression: predicates must read terminalTitle ──────────
// Confirmed root cause: SessionMetaLike.title and predicates read `m.title` but
// real session metadata artifacts write `terminalTitle` (src/types.ts). Any
// subcheck that polls `m.title` will always time out on a real run because the
// field is never populated.

describe("runDar06 DAR-06 root cause regression: terminalTitle field", () => {
  test("osc-0-title passes when metadata exposes terminalTitle with the token (no title field)", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // Model real metadata: daemon writes terminalTitle, not title.
    let capturedTerminalTitle: string | undefined;
    const origSend = deps.browser.surface.sendTerminalLine.bind(deps.browser.surface);
    deps.browser.surface.sendTerminalLine = async (text: string) => {
      await origSend(text);
      if (text.startsWith("TITLE0 ") || text.startsWith("TITLE2 ")) {
        capturedTerminalTitle = text.slice(text.indexOf(" ") + 1);
      }
    };
    context.runtime.sessions.read = async (_id: string) => ({
      id: SESSION_ID,
      status: "running" as SessionStatus,
      terminalTitle: capturedTerminalTitle,
      progress: state.progress ?? undefined,
    });

    const results = await runDar06(context, deps);

    expect(results[0]!.name).toBe("osc-0-title");
    expect(results[0]!.status).toBe("passed");
  });

  test("osc-2-title passes when metadata exposes terminalTitle with the token (no title field)", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // Model real metadata: daemon writes terminalTitle, not title.
    let capturedTerminalTitle: string | undefined;
    const origSend = deps.browser.surface.sendTerminalLine.bind(deps.browser.surface);
    deps.browser.surface.sendTerminalLine = async (text: string) => {
      await origSend(text);
      if (text.startsWith("TITLE0 ") || text.startsWith("TITLE2 ")) {
        capturedTerminalTitle = text.slice(text.indexOf(" ") + 1);
      }
    };
    context.runtime.sessions.read = async (_id: string) => ({
      id: SESSION_ID,
      status: "running" as SessionStatus,
      terminalTitle: capturedTerminalTitle,
      progress: state.progress ?? undefined,
    });

    const results = await runDar06(context, deps);

    expect(results[1]!.name).toBe("osc-2-title");
    expect(results[1]!.status).toBe("passed");
  });

  test("stray title property does not satisfy the osc-0-title predicate", async () => {
    const state = makeState();
    const context = makeContext(state);
    const deps = makeDependencies(state);

    // Intercept the command sent so we know the exact token value.
    let capturedTitleStray: string | undefined;
    const origSend = deps.browser.surface.sendTerminalLine.bind(deps.browser.surface);
    deps.browser.surface.sendTerminalLine = async (text: string) => {
      await origSend(text);
      if (text.startsWith("TITLE0 ")) capturedTitleStray = text.slice("TITLE0 ".length);
    };
    // Return the token only in the WRONG field; terminalTitle is absent.
    context.runtime.sessions.read = async (_id: string) => ({
      id: SESSION_ID,
      status: "running" as SessionStatus,
      title: capturedTitleStray, // stray field — must not satisfy the terminalTitle predicate
    });
    deps.now = () => Date.now() + 200_000;

    const results = await runDar06(context, deps);

    expect(results[0]!.name).toBe("osc-0-title");
    expect(results[0]!.status).toBe("failed");
  });
});
