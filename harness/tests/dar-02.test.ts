import { describe, expect, test } from "bun:test";
import type { SessionStatus } from "../src/session-ledger.js";
import {
  DAR_02_SUBCHECK_NAMES,
  runDar02,
  type Dar02BrowserDriver,
  type Dar02Context,
  type Dar02Dependencies,
  type DefaultHeadlessSpawnDependencies,
  type HeadlessProcess,
  type HeadlessSpawnSpec,
  spawnHeadlessProcessWithChildProcess,
} from "../src/scenarios/dar-02.js";

const SESSION_ID = "steady-otters-jam";
const RUN_ID = "abc123";
const READY_MARKER = "DAR_STREAM_READY";
const REPLAY_MARKERS = Array.from({ length: 20 }, (_, index) => {
  const phase = String(index + 1).padStart(3, "0");
  return `DAR_STREAM_REPLAY ${phase}`;
});
const LIVE_MARKERS = Array.from({ length: 20 }, (_, index) => {
  const phase = String(index + 21).padStart(3, "0");
  return `DAR_STREAM_LIVE ${phase}`;
});
const LAST_LIVE_MARKER = LIVE_MARKERS.at(-1)!;
const FINAL_EXIT_MARKER = "DAR_STREAM_EXIT 0";

interface ScenarioState {
  liveScrollback: string;
  finalScrollback?: string;
  daemonLog?: string;
  terminalText: string;
  meta: {
    id: string;
    status: SessionStatus;
    exitCode?: number;
    completedAt?: string;
  };
}

class FakeClock {
  public nowMs = 1_000;
  public readonly sleepCalls: number[] = [];

  public now(): number {
    this.nowMs += 1;
    return this.nowMs;
  }

  public async sleep(ms: number): Promise<void> {
    this.sleepCalls.push(ms);
    this.nowMs += ms;
  }
}

class FakeHeadlessProcess implements HeadlessProcess {
  public waitForExitCalls: number[] = [];
  public killCalls = 0;

  public constructor(
    private readonly state: ScenarioState,
    private readonly events: string[],
    private readonly options: {
      stdoutTexts?: string[];
      stdoutText?: string;
      stderrText?: string;
      waitForExitResult?: number | null;
      waitForExitError?: Error;
    } = {}
  ) {}

  public pid = 4242;

  public stdoutText(): string {
    this.events.push("process.stdout");
    if (this.options.stdoutTexts && this.options.stdoutTexts.length > 0) {
      return this.options.stdoutTexts.shift()!;
    }
    return this.options.stdoutText ?? `${this.state.meta.id}\n`;
  }

  public stderrText(): string {
    this.events.push("process.stderr");
    return this.options.stderrText ?? "";
  }

  public async waitForExit(deadline: number): Promise<number | null> {
    this.events.push("process.wait");
    this.waitForExitCalls.push(deadline);
    if (this.options.waitForExitError) {
      throw this.options.waitForExitError;
    }
    return this.options.waitForExitResult ?? 0;
  }

  public kill(): void {
    this.events.push("process.kill");
    this.killCalls += 1;
  }
}

class FakeSessionLedger {
  public readonly trackCalls: string[] = [];
  public readonly waitForStatusCalls: Array<{ id: string; status: SessionStatus; deadline: number }> = [];
  public readonly readCalls: string[] = [];

  public constructor(
    private readonly state: ScenarioState,
    private readonly events: string[],
    private readonly options: {
      trackError?: Error;
    } = {}
  ) {}

  public track(id: string): void {
    this.events.push(`sessions.track:${id}`);
    if (this.options.trackError) {
      throw this.options.trackError;
    }
    this.trackCalls.push(id);
  }

  public async waitForStatus(id: string, status: SessionStatus, deadline: number) {
    this.events.push(`sessions.wait:${id}:${status}`);
    this.waitForStatusCalls.push({ id, status, deadline });
    if (this.state.meta.id !== id) {
      throw new Error(`Unexpected session id ${id}`);
    }
    if (this.state.meta.status !== status) {
      throw new Error(`Session ${id} has status ${this.state.meta.status}, not ${status}`);
    }
    return { ...this.state.meta };
  }

  public async read(id: string) {
    this.events.push(`sessions.read:${id}`);
    this.readCalls.push(id);
    if (this.state.meta.id !== id) {
      throw new Error(`Unexpected session id ${id}`);
    }
    return { ...this.state.meta };
  }
}

class FakeBrowser implements Dar02BrowserDriver {
  public readonly waitForTerminalTextCalls: string[] = [];
  public readonly sendTerminalLineCalls: string[] = [];
  public readonly waitForSessionStatusCalls: Array<{ id: string; status: string }> = [];
  public readonly reopenViewerCalls: string[] = [];
  public openCalls = 0;
  public openTerminalCalls = 0;
  public closeViewerCalls = 0;

  public constructor(
    private readonly state: ScenarioState,
    private readonly events: string[],
    private readonly runId: string,
    private readonly options: {
      openError?: Error;
      openTerminalError?: Error;
      exitInputError?: Error;
      onExit?: (state: ScenarioState) => void;
    } = {}
  ) {}

  public async open(baseUrl: string): Promise<void> {
    this.events.push(`browser.open:${baseUrl}`);
    this.openCalls += 1;
    if (this.options.openError) {
      throw this.options.openError;
    }
  }

  public async waitForSessionStatus(id: string, status: string): Promise<void> {
    this.events.push(`browser.status:${id}:${status}`);
    this.waitForSessionStatusCalls.push({ id, status });
    if (this.state.meta.id !== id) {
      throw new Error(`Unexpected browser session id ${id}`);
    }
    if (this.state.meta.status !== status) {
      throw new Error(`Browser saw ${this.state.meta.status}, not ${status}`);
    }
  }

  public async openTerminal(id: string): Promise<void> {
    this.events.push(`browser.openTerminal:${id}`);
    this.openTerminalCalls += 1;
    if (this.options.openTerminalError) {
      throw this.options.openTerminalError;
    }
  }

  public async waitForTerminalText(text: string): Promise<void> {
    this.events.push(`browser.waitText:${text}`);
    this.waitForTerminalTextCalls.push(text);
    if (!this.state.terminalText.includes(text)) {
      throw new Error(`Missing terminal text: ${text}`);
    }
  }

  public async sendTerminalLine(text: string): Promise<void> {
    this.events.push(`browser.send:${text}`);
    this.sendTerminalLineCalls.push(text);
    if (text === `CONTINUE ${this.runId}`) {
      this.state.liveScrollback = `${this.state.liveScrollback}\n${LIVE_MARKERS.join("\n")}`;
      this.state.terminalText = `${this.state.terminalText}\n${LIVE_MARKERS.join("\n")}`;
      return;
    }
    if (text === "EXIT 0") {
      if (this.options.exitInputError) {
        throw this.options.exitInputError;
      }
      this.state.finalScrollback = `${this.state.liveScrollback}\n${FINAL_EXIT_MARKER}`;
      if (this.options.onExit) {
        this.options.onExit(this.state);
      } else {
        this.state.meta.status = "completed";
        this.state.meta.exitCode = 0;
        this.state.meta.completedAt = "2026-07-31T20:00:00.000Z";
      }
      return;
    }
    throw new Error(`Unexpected browser line ${text}`);
  }

  public async closeViewer(): Promise<void> {
    this.events.push("browser.close");
    this.closeViewerCalls += 1;
  }

  public async reopenViewer(baseUrl: string): Promise<void> {
    this.events.push(`browser.reopen:${baseUrl}`);
    this.reopenViewerCalls.push(baseUrl);
  }
}

function baseReplayText(): string {
  return [...REPLAY_MARKERS, READY_MARKER].join("\n");
}

function createState(overrides: Partial<ScenarioState> = {}): ScenarioState {
  const meta = {
    id: SESSION_ID,
    status: "running" as const,
    ...overrides.meta,
  };

  return {
    liveScrollback: baseReplayText(),
    finalScrollback: undefined,
    daemonLog: "daemon started\n",
    terminalText: baseReplayText(),
    ...overrides,
    meta,
  };
}

function createHarness(
  state: ScenarioState,
  options: {
    process?: ConstructorParameters<typeof FakeHeadlessProcess>[2];
    browser?: ConstructorParameters<typeof FakeBrowser>[3];
    sessions?: ConstructorParameters<typeof FakeSessionLedger>[2];
  } = {}
): {
  browser: FakeBrowser;
  clock: FakeClock;
  context: Dar02Context;
  dependencies: Dar02Dependencies;
  events: string[];
  process: FakeHeadlessProcess;
  sessions: FakeSessionLedger;
  spawnCalls: HeadlessSpawnSpec[];
} {
  const events: string[] = [];
  const clock = new FakeClock();
  const sessions = new FakeSessionLedger(state, events, options.sessions);
  const browser = new FakeBrowser(state, events, RUN_ID, options.browser);
  const process = new FakeHeadlessProcess(state, events, options.process);
  const spawnCalls: HeadlessSpawnSpec[] = [];

  const context: Dar02Context = {
    platform: "linux",
    overallDeadline: 60_000,
    build: {
      clientPath: "/repo/bin/climon",
    },
    browser,
    runtime: {
      root: "/repo",
      home: "/repo/.climon",
      baseUrl: "http://127.0.0.1:43123/",
      env: {
        CLIMON_HOME: "/repo/.climon",
        CLIMON_SESSION_ENGINE: "actor",
      },
      artifacts: {
        dir: "/repo/artifacts/cases/DAR-02",
      },
      processes: {
        async register() {},
      },
      sessions,
    },
  };

  const dependencies: Dar02Dependencies = {
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
    pollIntervalMs: 5,
    createUuid: () => RUN_ID,
    snapshotTerminalText: async () => {
      events.push("snapshot.terminal");
      return state.terminalText;
    },
    readLiveScrollback: async () => {
      events.push("scrollback.live");
      return state.liveScrollback;
    },
    readFinalScrollback: async () => {
      events.push("scrollback.final");
      return state.finalScrollback;
    },
    readDaemonLog: async () => {
      events.push("daemon.log");
      return state.daemonLog;
    },
    spawnHeadlessProcess: async (spec) => {
      events.push("spawn");
      spawnCalls.push(spec);
      return process;
    },
  };

  return { browser, clock, context, dependencies, events, process, sessions, spawnCalls };
}

describe("runDar02", () => {
  test("runs all DAR-02 subchecks in order, tracks immediately, waits for launcher exit 0, and waits for READY before opening the browser", async () => {
    const { browser, context, dependencies, events, process, sessions, spawnCalls } =
      createHarness(createState());

    const results = await runDar02(context, dependencies);

    expect(results.map((result) => result.name)).toEqual([...DAR_02_SUBCHECK_NAMES]);
    expect(results.map((result) => result.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
    expect(results.every((result) => result.durationMs > 0)).toBe(true);
    expect(spawnCalls).toEqual([
      {
        file: "/repo/bin/climon",
        args: [
          "run",
          "--headless",
          "--name",
          "DAR-02-abc123",
          "fixture",
          "streaming",
        ],
        cwd: "/repo",
        env: context.runtime.env,
        stdoutPath: "/repo/artifacts/cases/DAR-02/headless/stdout.log",
        stderrPath: "/repo/artifacts/cases/DAR-02/headless/stderr.log",
        shell: false,
        label: "climon-headless-launch",
        platform: "linux",
      },
    ]);
    expect(sessions.trackCalls).toEqual([SESSION_ID]);
    expect(events.indexOf(`sessions.track:${SESSION_ID}`)).toBeLessThan(
      events.indexOf("process.wait")
    );
    expect(events.indexOf("process.wait")).toBeLessThan(
      events.indexOf(`sessions.wait:${SESSION_ID}:running`)
    );
    expect(events.indexOf("scrollback.live")).toBeLessThan(
      events.indexOf(`browser.open:${context.runtime.baseUrl}`)
    );
    expect(browser.sendTerminalLineCalls).toEqual([`CONTINUE ${RUN_ID}`, "EXIT 0"]);
    expect(process.waitForExitCalls).toHaveLength(1);
  });

  test("uses exact replay/live markers and exact browser protocol lines", async () => {
    const { browser, context, dependencies } = createHarness(createState());

    const results = await runDar02(context, dependencies);

    expect(results.every((result) => result.status === "passed")).toBe(true);
    expect(browser.waitForTerminalTextCalls.slice(0, REPLAY_MARKERS.length)).toEqual(REPLAY_MARKERS);
    expect(browser.waitForTerminalTextCalls[REPLAY_MARKERS.length]).toBe(READY_MARKER);
    expect(
      browser.waitForTerminalTextCalls.slice(
        REPLAY_MARKERS.length + 1,
        REPLAY_MARKERS.length + 1 + LIVE_MARKERS.length
      )
    ).toEqual(LIVE_MARKERS);
    expect(browser.waitForTerminalTextCalls.at(-1)).toBe(LAST_LIVE_MARKER);
    expect(browser.sendTerminalLineCalls).toEqual([`CONTINUE ${RUN_ID}`, "EXIT 0"]);
  });

  test("fails headless-launch for duplicate and unsafe client stdout session ids", async () => {
    const cases = [
      {
        name: "duplicate session ids",
        stdoutText: `${SESSION_ID}\n${SESSION_ID}\n`,
        expectedMessage: "Expected exactly one headless session id line, found 2",
      },
      {
        name: "unsafe session id",
        stdoutText: "../escape\n",
        expectedMessage: "Unsafe session id from headless launch stdout",
      },
    ] as const;

    for (const testCase of cases) {
      const { context, dependencies, process } = createHarness(createState(), {
        process: { stdoutText: testCase.stdoutText },
      });

      const results = await runDar02(context, dependencies);

      expect(results.find((result) => result.name === "headless-launch")).toMatchObject({
        status: "failed",
        message: expect.stringContaining(testCase.expectedMessage),
      });
      expect(process.killCalls).toBe(1);
    }
  });

  test("waits for one complete safe session-id line and ignores later protocol output", async () => {
    const { context, dependencies, process, sessions } = createHarness(createState(), {
      process: {
        stdoutTexts: [
          "steady-otters-",
          `${SESSION_ID}\nDAR_STREAM_REPLAY 001\n`,
        ],
      },
    });

    const results = await runDar02(context, dependencies);

    expect(results.find((result) => result.name === "headless-launch")).toMatchObject({
      status: "passed",
    });
    expect(sessions.trackCalls).toEqual([SESSION_ID]);
    expect(process.killCalls).toBe(0);
  });

  test("fails headless-launch when the short-lived launcher exits non-zero after printing the session id", async () => {
    const { context, dependencies, process, sessions } = createHarness(createState(), {
      process: {
        waitForExitResult: 7,
      },
    });

    const results = await runDar02(context, dependencies);

    expect(sessions.trackCalls).toEqual([SESSION_ID]);
    expect(results.find((result) => result.name === "headless-launch")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("Expected headless launcher to exit 0, received 7"),
    });
    expect(process.killCalls).toBe(0);
  });

  test("blocks later subchecks when tracking the parsed session id fails", async () => {
    const { context, dependencies, process } = createHarness(createState(), {
      sessions: {
        trackError: new Error("Session steady-otters-jam is already tracked"),
      },
    });

    const results = await runDar02(context, dependencies);

    expect(results.find((result) => result.name === "headless-launch")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("already tracked"),
    });
    expect(results.find((result) => result.name === "daemon-running")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("headless-launch did not yield a safe session id"),
    });
    expect(process.killCalls).toBe(0);
  });

  test("closes and reopens the viewer while metadata stays running", async () => {
    const { browser, context, dependencies, events, sessions } = createHarness(createState());

    const results = await runDar02(context, dependencies);

    expect(results.find((result) => result.name === "viewer-independence")).toMatchObject({
      status: "passed",
      message: expect.stringContaining("running"),
    });
    expect(browser.closeViewerCalls).toBe(1);
    expect(browser.reopenViewerCalls).toEqual([context.runtime.baseUrl]);
    expect(events.indexOf("browser.close")).toBeLessThan(events.indexOf(`sessions.read:${SESSION_ID}`));
    expect(events.indexOf(`sessions.read:${SESSION_ID}`)).toBeLessThan(
      events.indexOf(`browser.reopen:${context.runtime.baseUrl}`)
    );
    expect(sessions.readCalls).toContain(SESSION_ID);
  });

  test("fails successful-finalization immediately when the page opens but terminal attach fails", async () => {
    const { browser, clock, context, dependencies, events, process, sessions } = createHarness(
      createState(),
      {
        browser: {
          openTerminalError: new Error("terminal attach failed"),
        },
      }
    );

    const results = await runDar02(context, dependencies);
    const successfulFinalization = results.find(
      (result) => result.name === "successful-finalization"
    );

    expect(results.find((result) => result.name === "midstream-attach")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("terminal attach failed"),
    });
    expect(successfulFinalization?.status).toBe("failed");
    expect(successfulFinalization?.durationMs).toBe(1);
    expect(successfulFinalization?.message).toContain("terminal attach failed");
    expect(successfulFinalization?.message).toContain(
      "browser terminal unavailable for EXIT 0 session control"
    );
    expect(browser.waitForSessionStatusCalls).toEqual([{ id: SESSION_ID, status: "running" }]);
    expect(sessions.waitForStatusCalls).toEqual([
      expect.objectContaining({ id: SESSION_ID, status: "running" }),
    ]);
    expect(events).not.toContain("scrollback.final");
    expect(clock.sleepCalls).toEqual([]);
    expect(process.killCalls).toBe(0);
  });

  test("fails successful-finalization immediately when the browser attach fails early", async () => {
    const { browser, clock, context, dependencies, events, process, sessions } = createHarness(
      createState(),
      {
        browser: {
          openError: new Error("dashboard unavailable"),
        },
      }
    );

    const results = await runDar02(context, dependencies);
    const successfulFinalization = results.find(
      (result) => result.name === "successful-finalization"
    );

    expect(results.find((result) => result.name === "midstream-attach")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("dashboard unavailable"),
    });
    expect(successfulFinalization?.status).toBe("failed");
    expect(successfulFinalization?.durationMs).toBe(1);
    expect(successfulFinalization?.message).toContain("dashboard unavailable");
    expect(successfulFinalization?.message).toContain(
      "browser terminal unavailable for EXIT 0 session control"
    );
    expect(browser.waitForSessionStatusCalls).toEqual([]);
    expect(browser.sendTerminalLineCalls).toEqual([]);
    expect(sessions.waitForStatusCalls).toEqual([
      expect.objectContaining({ id: SESSION_ID, status: "running" }),
    ]);
    expect(events).not.toContain("scrollback.final");
    expect(clock.sleepCalls).toEqual([]);
    expect(process.killCalls).toBe(0);
  });

  test("fails successful-finalization immediately when EXIT 0 cannot be sent", async () => {
    const { browser, clock, context, dependencies, events, process, sessions } = createHarness(
      createState(),
      {
        browser: {
          exitInputError: new Error("terminal write failed"),
        },
      }
    );

    const results = await runDar02(context, dependencies);
    const successfulFinalization = results.find(
      (result) => result.name === "successful-finalization"
    );

    expect(successfulFinalization?.status).toBe("failed");
    expect(successfulFinalization?.durationMs).toBe(1);
    expect(successfulFinalization?.message).toContain(
      "browser EXIT 0 failed: terminal write failed"
    );
    expect(browser.waitForSessionStatusCalls).toEqual([
      { id: SESSION_ID, status: "running" },
      { id: SESSION_ID, status: "running" },
    ]);
    expect(browser.sendTerminalLineCalls).toEqual([`CONTINUE ${RUN_ID}`, "EXIT 0"]);
    expect(sessions.waitForStatusCalls).toEqual([
      expect.objectContaining({ id: SESSION_ID, status: "running" }),
    ]);
    expect(events).not.toContain("scrollback.final");
    expect(clock.sleepCalls).toEqual([]);
    expect(process.killCalls).toBe(0);
  });

  test("records browser-only finalization inability when the page opens but terminal attach fails", async () => {
    const { browser, context, dependencies, process } = createHarness(createState(), {
      browser: {
        openTerminalError: new Error("terminal attach failed"),
      },
    });

    const results = await runDar02(context, dependencies);
    const successfulFinalization = results.find(
      (result) => result.name === "successful-finalization"
    );

    expect(results.find((result) => result.name === "midstream-attach")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("terminal attach failed"),
    });
    expect(successfulFinalization?.status).toBe("failed");
    expect(successfulFinalization?.message).toContain("terminal attach failed");
    expect(successfulFinalization?.message).toContain(
      "browser terminal unavailable for EXIT 0 session control"
    );
    expect(browser.waitForSessionStatusCalls).toEqual([{ id: SESSION_ID, status: "running" }]);
    expect(process.killCalls).toBe(0);
  });

  test("does not use the launcher as session control when the browser attach fails early", async () => {
    const { browser, context, dependencies, process } = createHarness(createState(), {
      browser: {
        openError: new Error("dashboard unavailable"),
      },
    });

    const results = await runDar02(context, dependencies);
    const successfulFinalization = results.find(
      (result) => result.name === "successful-finalization"
    );

    expect(results.find((result) => result.name === "midstream-attach")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("dashboard unavailable"),
    });
    expect(successfulFinalization?.status).toBe("failed");
    expect(successfulFinalization?.message).toContain("dashboard unavailable");
    expect(successfulFinalization?.message).toContain(
      "browser terminal unavailable for EXIT 0 session control"
    );
    expect(browser.sendTerminalLineCalls).toEqual([]);
    expect(process.killCalls).toBe(0);
  });

  test("kills a launcher that hangs after emitting the session id", async () => {
    let resolveKill!: () => void;
    let killResolved = false;
    const events: string[] = [];
    const { context, dependencies, sessions } = createHarness(createState());
    dependencies.spawnHeadlessProcess = async () => ({
      pid: 777,
      stdoutText: () => `${SESSION_ID}\n`,
      stderrText: () => "",
      async waitForExit() {
        throw new Error("Timed out waiting for headless process 777 to exit");
      },
      kill() {
        events.push("kill:start");
        return new Promise<void>((resolve) => {
          resolveKill = () => {
            killResolved = true;
            events.push("kill:done");
            resolve();
          };
        });
      },
    });

    let settled = false;
    const pending = runDar02(context, dependencies).then((value) => {
      settled = true;
      return value;
    });

    for (let index = 0; index < 100 && resolveKill === undefined; index += 1) {
      await Promise.resolve();
    }
    expect(resolveKill).toBeDefined();
    expect(sessions.trackCalls).toEqual([SESSION_ID]);
    expect(settled).toBe(false);
    expect(killResolved).toBe(false);

    resolveKill();
    const results = await pending;

    expect(killResolved).toBe(true);
    expect(settled).toBe(true);
    expect(events).toEqual(["kill:start", "kill:done"]);
    expect(results.find((result) => result.name === "headless-launch")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("Timed out waiting for headless process 777 to exit"),
    });
  });

  test("fails successful-finalization when completed metadata is missing completedAt or exitCode=0", async () => {
    const cases = [
      {
        name: "missing completedAt",
        onExit(state: ScenarioState) {
          state.meta.status = "completed";
          state.meta.exitCode = 0;
          delete state.meta.completedAt;
        },
        expectedMessage: "completedAt",
      },
      {
        name: "non-zero exitCode",
        onExit(state: ScenarioState) {
          state.meta.status = "completed";
          state.meta.exitCode = 7;
          state.meta.completedAt = "2026-07-31T20:00:00.000Z";
        },
        expectedMessage: "exitCode=0",
      },
    ] as const;

    for (const testCase of cases) {
      const { context, dependencies } = createHarness(createState(), {
        browser: { onExit: testCase.onExit },
      });

      const results = await runDar02(context, dependencies);

      expect(results.find((result) => result.name === "successful-finalization")).toMatchObject({
        status: "failed",
        message: expect.stringContaining(testCase.expectedMessage),
      });
    }
  });
});

describe("spawnHeadlessProcessWithChildProcess", () => {
  test("kills the detached Unix process group with a negative pid", async () => {
    const events: string[] = [];
    const stdoutChunks: Array<string | Buffer> = [];
    const stderrChunks: Array<string | Buffer> = [];
    const child = createSpawnedChild(stdoutChunks, stderrChunks);
    const dependencies = createSpawnDependencies(child, events);

    const process = await spawnHeadlessProcessWithChildProcess(
      {
        file: "/repo/bin/climon",
        args: ["run", "--headless", "fixture", "streaming"],
        cwd: "/repo",
        env: {},
        stdoutPath: "/repo/artifacts/cases/DAR-02/headless/stdout.log",
        stderrPath: "/repo/artifacts/cases/DAR-02/headless/stderr.log",
        shell: false,
        label: "climon-headless-launch",
        platform: "linux",
      },
      {
        runtime: {
          processes: {
            register: dependencies.register,
          },
        },
      } as unknown as Dar02Context,
      {
        now: () => 1_000,
        sleep: async () => {},
        pollIntervalMs: 5,
      },
      dependencies
    );

    await process.kill();

    expect(events).toContain("kill:-4242:SIGKILL");
    expect(dependencies.spawnOptions?.detached).toBe(true);
    expect(dependencies.registeredOwned?.processGroup).toBe(4242);
  });

  test("uses taskkill with exact Windows args for registration-failure cleanup", async () => {
    const events: string[] = [];
    const stdoutChunks: Array<string | Buffer> = [];
    const stderrChunks: Array<string | Buffer> = [];
    const child = createSpawnedChild(stdoutChunks, stderrChunks);
    const dependencies = createSpawnDependencies(child, events, {
      registerError: new Error("register failed"),
    });

    await expect(
      spawnHeadlessProcessWithChildProcess(
        {
          file: "/repo/bin/climon",
          args: ["run", "--headless", "fixture", "streaming"],
          cwd: "/repo",
          env: {},
          stdoutPath: "/repo/artifacts/cases/DAR-02/headless/stdout.log",
          stderrPath: "/repo/artifacts/cases/DAR-02/headless/stderr.log",
          shell: false,
          label: "climon-headless-launch",
          platform: "windows",
        },
        {
          runtime: {
            processes: {
              register: dependencies.register,
            },
          },
        } as unknown as Dar02Context,
        {
          now: () => 1_000,
          sleep: async () => {},
          pollIntervalMs: 5,
        },
        dependencies
      )
    ).rejects.toThrow("register failed");

    expect(dependencies.runCommandCalls).toEqual([
      {
        file: "taskkill",
        args: ["/PID", "4242", "/T", "/F"],
        options: { shell: false, windowsHide: true },
      },
    ]);
    expect(dependencies.spawnOptions?.detached).toBe(false);
    expect(dependencies.registeredOwned?.processGroup).toBeUndefined();
  });

  test("spawns the short-lived launcher with ignored stdin and no public writeLine seam", async () => {
    const events: string[] = [];
    const stdoutChunks: Array<string | Buffer> = [];
    const stderrChunks: Array<string | Buffer> = [];
    const child = createSpawnedChild(stdoutChunks, stderrChunks);
    const dependencies = createSpawnDependencies(child, events);

    const process = await spawnHeadlessProcessWithChildProcess(
      {
        file: "/repo/bin/climon",
        args: ["run", "--headless", "fixture", "streaming"],
        cwd: "/repo",
        env: {},
        stdoutPath: "/repo/artifacts/cases/DAR-02/headless/stdout.log",
        stderrPath: "/repo/artifacts/cases/DAR-02/headless/stderr.log",
        shell: false,
        label: "climon-headless-launch",
        platform: "linux",
      },
      {
        runtime: {
          processes: {
            register: dependencies.register,
          },
        },
      } as unknown as Dar02Context,
      {
        now: () => 1_000,
        sleep: async () => {},
        pollIntervalMs: 5,
      },
      dependencies
    );

    expect(dependencies.spawnOptions).toEqual({
      cwd: "/repo",
      env: {},
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect("writeLine" in process).toBe(false);
  });

  test("does not terminate an already exited launcher a second time", async () => {
    const events: string[] = [];
    const stdoutChunks: Array<string | Buffer> = [];
    const stderrChunks: Array<string | Buffer> = [];
    const child = createSpawnedChild(stdoutChunks, stderrChunks);
    const dependencies = createSpawnDependencies(child, events);

    const process = await spawnHeadlessProcessWithChildProcess(
      {
        file: "/repo/bin/climon",
        args: ["run", "--headless", "fixture", "streaming"],
        cwd: "/repo",
        env: {},
        stdoutPath: "/repo/artifacts/cases/DAR-02/headless/stdout.log",
        stderrPath: "/repo/artifacts/cases/DAR-02/headless/stderr.log",
        shell: false,
        label: "climon-headless-launch",
        platform: "linux",
      },
      {
        runtime: {
          processes: {
            register: dependencies.register,
          },
        },
      } as unknown as Dar02Context,
      {
        now: () => 1_000,
        sleep: async () => {},
        pollIntervalMs: 5,
      },
      dependencies
    );
    child.emitExit(0);

    await process.kill();

    expect(events.filter((event) => event.startsWith("kill:"))).toEqual([]);
    expect(dependencies.runCommandCalls).toEqual([]);
  });

  test("rejects invalid completedAt timestamps", async () => {
    const { context, dependencies } = createHarness(createState(), {
      browser: {
        onExit(state) {
          state.meta.status = "completed";
          state.meta.exitCode = 0;
          state.meta.completedAt = "not-a-timestamp";
        },
      },
    });

    const results = await runDar02(context, dependencies);

    expect(results.find((result) => result.name === "successful-finalization")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("completedAt"),
    });
  });
});

interface SpawnedChildLike {
  pid?: number;
  stdout: {
    on(event: "data", listener: (chunk: string | Uint8Array) => void): void;
  };
  stderr: {
    on(event: "data", listener: (chunk: string | Uint8Array) => void): void;
  };
  once(event: "error", listener: (error: unknown) => void): void;
  once(event: "exit", listener: (code: number | null) => void): void;
  emitExit(code: number | null): void;
  emitError(error: unknown): void;
}

function createSpawnedChild(
  stdoutChunks: Array<string | Uint8Array>,
  stderrChunks: Array<string | Uint8Array>
): SpawnedChildLike {
  const stdoutListeners = new Set<(chunk: string | Uint8Array) => void>();
  const stderrListeners = new Set<(chunk: string | Uint8Array) => void>();
  const errorListeners = new Set<(error: unknown) => void>();
  const exitListeners = new Set<(code: number | null) => void>();

  return {
    pid: 4242,
    stdout: {
      on(_event, listener) {
        stdoutListeners.add(listener);
        for (const chunk of stdoutChunks) {
          listener(chunk);
        }
      },
    },
    stderr: {
      on(_event, listener) {
        stderrListeners.add(listener);
        for (const chunk of stderrChunks) {
          listener(chunk);
        }
      },
    },
    once(event, listener) {
      if (event === "error") {
        errorListeners.add(listener as (error: unknown) => void);
        return;
      }
      exitListeners.add(listener as (code: number | null) => void);
    },
    emitExit(code) {
      for (const listener of exitListeners) {
        listener(code);
      }
    },
    emitError(error) {
      for (const listener of errorListeners) {
        listener(error);
      }
    },
  };
}

function createSpawnDependencies(
  child: SpawnedChildLike,
  events: string[],
  options: {
    registerError?: Error;
  } = {}
): DefaultHeadlessSpawnDependencies & {
  register: (owned: { pid: number; processGroup?: number }) => Promise<void>;
  registeredOwned?: { pid: number; processGroup?: number };
  runCommandCalls: Array<{
    file: string;
    args: string[];
    options: { shell: false; windowsHide: true };
  }>;
  spawnOptions?: {
    cwd: string;
    env: Record<string, string | undefined>;
    shell: false;
    detached: boolean;
    stdio: ["ignore", "pipe", "pipe"];
  };
} {
  const runCommandCalls: Array<{
    file: string;
    args: string[];
    options: { shell: false; windowsHide: true };
  }> = [];
  let spawnOptions:
    | {
        cwd: string;
        env: Record<string, string | undefined>;
        shell: false;
        detached: boolean;
        stdio: ["ignore", "pipe", "pipe"];
      }
    | undefined;
  let registeredOwned:
    | {
        pid: number;
        processGroup?: number;
      }
    | undefined;

  return {
    async mkdir() {},
    createWriteStream() {
      return {
        write() {},
        end() {},
      } as never;
    },
    kill(pid, signal) {
      events.push(`kill:${pid}:${signal}`);
    },
    runCommand(file, args, options) {
      runCommandCalls.push({
        file,
        args,
        options: { shell: options.shell, windowsHide: options.windowsHide },
      });
      return { status: 0 };
    },
    spawn(_file, _args, nextSpawnOptions) {
      spawnOptions = nextSpawnOptions;
      return child as never;
    },
    get runCommandCalls() {
      return runCommandCalls;
    },
    get registeredOwned() {
      return registeredOwned;
    },
    get spawnOptions() {
      return spawnOptions;
    },
    async register(owned) {
      events.push(`register:${owned.pid}`);
      registeredOwned = owned;
      if (options.registerError) {
        throw options.registerError;
      }
    },
  };
}
