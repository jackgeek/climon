import { describe, expect, test } from "bun:test";
import type { ScreenLike } from "../src/drivers/pty.js";
import {
  DAR_03_SUBCHECK_NAMES,
  runDar03,
  type Dar03BrowserDriver,
  type Dar03BrowserSurface,
  type Dar03Context,
  type Dar03Pty,
} from "../src/scenarios/dar-03.js";

const DAR_03_SUBCHECK_TITLES = [
  "Starts the attached local terminal as controller",
  "Transfers control and PTY sizing to the desktop dashboard",
  "Suppresses non-Space input from the displaced local terminal",
  "Makes the simulated PWA the newest active controller",
  "Reclaims control from the local terminal with Space",
  "Restores local terminal size as the authoritative PTY size",
] as const;

const RUN_ID = "abc123";
const SESSION_ID = "dar-03-session";
const LOCAL_COLS = 100;
const LOCAL_ROWS = 30;
const DESKTOP_COLS = 132;
const DESKTOP_ROWS = 44;
const PWA_COLS = 48;
const PWA_ROWS = 18;
const RESIZED_LOCAL_COLS = 140;
const RESIZED_LOCAL_ROWS = 46;
const OVERLAY_MESSAGE = "This session is being viewed on a climon dashboard.";
const OVERLAY_HINT = "Press Space to take control.";

interface ScenarioState {
  sessionId?: string;
  status: "running" | "completed";
  cols: number;
  rows: number;
  currentController: string;
  lastToken: string;
  resizeSequence: number;
  localOutput: string;
  localScreen: string;
  browserTranscript: string[];
  exited: boolean;
}

class FakeScreen implements ScreenLike {
  public constructor(
    private readonly frame: {
      contents: string;
      cursor: { col: number; row: number };
    }
  ) {}

  public async write(): Promise<void> {}

  public resize(): void {}

  public contents(): string {
    return this.frame.contents;
  }

  public cursor(): { col: number; row: number } {
    return this.frame.cursor;
  }
}

class FakePty implements Dar03Pty {
  public readonly callLog: string[] = [];
  public readonly writeTextCalls: string[] = [];
  public readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  public readonly waitForQuietCalls: Array<{ quietPeriodMs: number; deadline: number }> = [];
  public readonly waitForExitCalls: number[] = [];
  public killCalls = 0;

  public constructor(
    private readonly state: ScenarioState,
    private readonly options: {
      spawnMarker?: string;
      screenError?: Error;
      waitForExitError?: Error;
    } = {}
  ) {}

  public writeText(text: string): void {
    this.callLog.push(`writeText:${JSON.stringify(text)}`);
    this.writeTextCalls.push(text);

    if (text === " ") {
      if (this.state.currentController !== "local") {
        this.state.currentController = "local";
        this.state.cols = LOCAL_COLS;
        this.state.rows = LOCAL_ROWS;
        this.state.localScreen = renderProbeScreen(this.state.cols, this.state.rows, this.state.lastToken);
      }
      return;
    }

    if (text === "q") {
      this.state.exited = true;
      this.state.status = "completed";
      return;
    }

    if (this.state.currentController !== "local") {
      return;
    }

    if (text.endsWith("\r")) {
      const token = text.slice(0, -1);
      if (token.length === 0) {
        return;
      }
      this.state.lastToken = token;
      this.state.localOutput += `DAR_CONTROL_INPUT ${token}\n`;
      this.state.localScreen = renderProbeScreen(this.state.cols, this.state.rows, token);
    }
  }

  public resize(cols: number, rows: number): void {
    this.callLog.push(`resize:${cols}x${rows}`);
    this.resizeCalls.push({ cols, rows });
    if (this.state.currentController !== "local") {
      return;
    }
    this.state.cols = cols;
    this.state.rows = rows;
    this.state.resizeSequence += 1;
    this.state.localOutput += `DAR_CONTROL_RESIZE ${this.state.resizeSequence} ${cols} ${rows}\n`;
    this.state.localScreen = renderProbeScreen(cols, rows, this.state.lastToken);
  }

  public async expectRaw(marker: string): Promise<void> {
    this.callLog.push(`expectRaw:${marker}`);
    if (!this.state.localOutput.includes(marker)) {
      throw new Error(this.options.spawnMarker ?? `Missing raw marker: ${marker}`);
    }
  }

  public async expectScreen(
    predicate: (screen: ScreenLike) => boolean,
    _deadline: number
  ): Promise<void> {
    this.callLog.push("expectScreen");
    if (this.options.screenError) {
      throw this.options.screenError;
    }
    const screen = new FakeScreen({
      contents: this.state.localScreen,
      cursor: { col: 0, row: 0 },
    });
    if (!predicate(screen)) {
      throw new Error(`Screen predicate failed for ${JSON.stringify(this.state.localScreen)}`);
    }
  }

  public async waitForQuiet(quietPeriodMs: number, deadline: number): Promise<void> {
    this.callLog.push(`waitForQuiet:${quietPeriodMs}`);
    this.waitForQuietCalls.push({ quietPeriodMs, deadline });
  }

  public async waitForExit(deadline: number): Promise<number> {
    this.callLog.push("waitForExit");
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
    this.callLog.push("kill");
    this.killCalls += 1;
  }
}

class FakeSurface implements Dar03BrowserSurface {
  public readonly openCalls: string[] = [];
  public readonly openTerminalCalls: string[] = [];
  public readonly takeControlCalls: string[] = [];
  public readonly waitForTerminalTextCalls: string[] = [];
  public readonly sendTerminalLineCalls: string[] = [];
  public readonly closeCalls: string[] = [];

  public constructor(
    public readonly name: string,
    public readonly viewerId: string,
    private readonly state: ScenarioState,
    private readonly surfaceSize: { cols: number; rows: number },
    private readonly options: {
      takeControlError?: Error;
      closeError?: Error;
    } = {}
  ) {}

  public async open(baseUrl: string): Promise<void> {
    this.openCalls.push(baseUrl);
  }

  public async openTerminal(id: string): Promise<void> {
    this.openTerminalCalls.push(id);
  }

  public async takeControl(id: string): Promise<void> {
    this.takeControlCalls.push(id);
    if (this.options.takeControlError) {
      throw this.options.takeControlError;
    }
    this.state.currentController = this.viewerId;
    this.state.cols = this.surfaceSize.cols;
    this.state.rows = this.surfaceSize.rows;
    this.state.localScreen = `${OVERLAY_MESSAGE}\n${OVERLAY_HINT}`;
  }

  public async controllerId(): Promise<string> {
    return this.state.currentController;
  }

  public async waitForTerminalText(text: string): Promise<void> {
    this.waitForTerminalTextCalls.push(text);
    if (!(await this.terminalText()).includes(text)) {
      throw new Error(`Missing terminal text: ${text}`);
    }
  }

  public async sendTerminalLine(text: string): Promise<void> {
    this.sendTerminalLineCalls.push(text);
    if (this.state.currentController !== this.viewerId) {
      throw new Error(`${this.name} is not the controller`);
    }
    this.state.lastToken = text;
    this.state.browserTranscript.push(`DAR_CONTROL_INPUT ${text}`);
  }

  public async terminalText(): Promise<string> {
    return [
      renderProbeScreen(this.state.cols, this.state.rows, this.state.lastToken),
      ...this.state.browserTranscript,
    ].join("\n");
  }

  public async close(): Promise<void> {
    this.closeCalls.push(this.name);
    if (this.options.closeError) {
      throw this.options.closeError;
    }
  }
}

class FakeBrowserDriver implements Dar03BrowserDriver {
  public readonly createSurfaceCalls: Array<{
    name: string;
    viewport: { width: number; height: number };
    displayMode?: "browser" | "standalone";
  }> = [];

  public readonly desktop: FakeSurface;
  public readonly pwa: FakeSurface;

  public constructor(
    state: ScenarioState,
    options: {
      desktopTakeControlError?: Error;
      pwaTakeControlError?: Error;
      desktopCloseError?: Error;
      pwaCloseError?: Error;
    } = {}
  ) {
    this.desktop = new FakeSurface(
      "desktop",
      "surface-1-desktop",
      state,
      { cols: DESKTOP_COLS, rows: DESKTOP_ROWS },
      {
        takeControlError: options.desktopTakeControlError,
        closeError: options.desktopCloseError,
      }
    );
    this.pwa = new FakeSurface(
      "pwa",
      "surface-2-pwa",
      state,
      { cols: PWA_COLS, rows: PWA_ROWS },
      {
        takeControlError: options.pwaTakeControlError,
        closeError: options.pwaCloseError,
      }
    );
  }

  public async createSurface(options: {
    name: string;
    viewport: { width: number; height: number };
    displayMode?: "browser" | "standalone";
  }): Promise<Dar03BrowserSurface> {
    this.createSurfaceCalls.push(options);
    if (options.name === "desktop") {
      return this.desktop;
    }
    if (options.name === "pwa") {
      return this.pwa;
    }
    throw new Error(`Unexpected surface ${options.name}`);
  }
}

function renderProbeScreen(cols: number, rows: number, lastToken: string): string {
  return `DAR_CONTROL_READY\nsize=${cols}x${rows}\nlast=${lastToken}\nresizes=0`;
}

function createState(): ScenarioState {
  return {
    sessionId: SESSION_ID,
    status: "running",
    cols: LOCAL_COLS,
    rows: LOCAL_ROWS,
    currentController: "local",
    lastToken: "ready",
    resizeSequence: 0,
    localOutput: [
      `DAR_MODE_BASELINE {"platform":"linux"}`,
      `DAR_CONTROL_READY ${LOCAL_COLS} ${LOCAL_ROWS}`,
    ].join("\n"),
    localScreen: renderProbeScreen(LOCAL_COLS, LOCAL_ROWS, "ready"),
    browserTranscript: [],
    exited: false,
  };
}

function createContext(): Dar03Context {
  return {
    platform: "linux",
    overallDeadline: 99_999,
    build: {
      clientPath: "/repo/bin/climon",
      fixturePath: "/repo/bin/climon-harness-fixture",
    },
    runtime: {
      root: "/repo",
      home: "/repo/.climon",
      baseUrl: "http://127.0.0.1:43123/",
      env: {
        TERM: "xterm-256color",
        CLIMON_HOME: "/repo/.climon",
      },
      artifacts: {
        dir: "/repo/artifacts/cases/dar-03",
        async appendText(): Promise<void> {},
      },
      sessions: {
        track() {},
        async waitForStatus() {
          return { id: SESSION_ID, status: "running" };
        },
        async read() {
          return { id: SESSION_ID, status: "running", cols: LOCAL_COLS, rows: LOCAL_ROWS };
        },
      },
    },
  };
}

describe("runDar03", () => {
  test("runs all DAR-03 subchecks in order with exact mode-probe, browser-surface, and control-probe evidence", async () => {
    const state = createState();
    const context = createContext();
    const browser = new FakeBrowserDriver(state);
    const pty = new FakePty(state);
    const spawnSpecs: Array<{ file: string; args: string[] }> = [];

    const results = await runDar03(context, {
      now: (() => {
        let current = 1_000;
        return () => ++current;
      })(),
      sleep: async () => {},
      pollIntervalMs: 5,
      createUuid: () => RUN_ID,
      createBrowserDriver: () => browser,
      spawnPty: (spec) => {
        spawnSpecs.push({ file: spec.file, args: spec.args });
        return pty;
      },
      findSession: async () => ({ id: SESSION_ID, status: "running", cols: state.cols, rows: state.rows }),
      readLocalOutput: async () => state.localOutput,
      readSessionMeta: async () => ({
        id: SESSION_ID,
        status: state.status,
        cols: state.cols,
        rows: state.rows,
      }),
    });

    expect(results.map((result) => result.name)).toEqual([...DAR_03_SUBCHECK_NAMES]);
    expect(results.map((result) => result.title)).toEqual([...DAR_03_SUBCHECK_TITLES]);
    expect(results.map((result) => result.status)).toEqual(Array(6).fill("passed"));
    expect(results.every((result) => result.durationMs > 0)).toBe(true);
    expect(spawnSpecs).toEqual([
      {
        file: "/repo/bin/climon-harness-fixture",
        args: [
          "mode-probe",
          "--",
          "/repo/bin/climon",
          "run",
          "--name",
          "DAR-03-abc123",
          "/repo/bin/climon-harness-fixture",
          "control-probe",
        ],
      },
    ]);
    expect(browser.createSurfaceCalls).toEqual([
      {
        name: "desktop",
        viewport: { width: 1440, height: 960 },
        displayMode: "browser",
      },
      {
        name: "pwa",
        viewport: { width: 390, height: 844 },
        displayMode: "standalone",
      },
    ]);
    expect(browser.desktop.sendTerminalLineCalls).toEqual([`dar03-desktop-${RUN_ID}`]);
    expect(browser.pwa.sendTerminalLineCalls).toEqual([`dar03-pwa-${RUN_ID}`]);
    expect(pty.writeTextCalls).toEqual([
      `dar03-local-suppressed-${RUN_ID}\r`,
      " ",
      `dar03-local-${RUN_ID}\r`,
      "q",
    ]);
    expect(results[0]?.evidence).toEqual(
      expect.arrayContaining([
        "pty/input.log",
        "pty/output.log",
        `home/sessions/${SESSION_ID}.json`,
        `home/logs/daemon/${SESSION_ID}.log`,
        `DAR_CONTROL_READY ${LOCAL_COLS} ${LOCAL_ROWS}`,
      ])
    );
    expect(results[1]?.evidence).toEqual(
      expect.arrayContaining([
        `DAR_CONTROL_INPUT dar03-desktop-${RUN_ID}`,
        `${DESKTOP_COLS}x${DESKTOP_ROWS}`,
      ])
    );
    expect(results[2]?.message).toContain(`dar03-local-suppressed-${RUN_ID}`);
    expect(results[3]?.evidence).toEqual(
      expect.arrayContaining([
        `DAR_CONTROL_INPUT dar03-pwa-${RUN_ID}`,
        `${PWA_COLS}x${PWA_ROWS}`,
      ])
    );
    expect(results[4]?.evidence).toEqual(
      expect.arrayContaining([
        "local",
        `DAR_CONTROL_INPUT dar03-local-${RUN_ID}`,
      ])
    );
    expect(results[5]?.evidence).toEqual(
      expect.arrayContaining([
        `DAR_CONTROL_RESIZE 1 ${RESIZED_LOCAL_COLS} ${RESIZED_LOCAL_ROWS}`,
      ])
    );
    expect(pty.killCalls).toBe(0);
  });

  test("reports explicit dependent failures after a desktop take-control error", async () => {
    const state = createState();
    const context = createContext();
    const browser = new FakeBrowserDriver(state, {
      desktopTakeControlError: new Error("desktop refused control"),
    });

    const results = await runDar03(context, {
      now: (() => {
        let current = 1_000;
        return () => ++current;
      })(),
      sleep: async () => {},
      pollIntervalMs: 5,
      createUuid: () => RUN_ID,
      createBrowserDriver: () => browser,
      spawnPty: () => new FakePty(state),
      findSession: async () => ({ id: SESSION_ID, status: "running", cols: state.cols, rows: state.rows }),
      readLocalOutput: async () => state.localOutput,
      readSessionMeta: async () => ({
        id: SESSION_ID,
        status: state.status,
        cols: state.cols,
        rows: state.rows,
      }),
    });

    expect(results.map((result) => result.status)).toEqual([
      "passed",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(results[1]?.message).toContain("desktop refused control");
    expect(results[2]?.message).toContain(
      "desktop-transfers-control-and-pty-size did not establish a displaced local terminal"
    );
    expect(results[3]?.message).toContain(
      "desktop-transfers-control-and-pty-size did not establish a displaced local terminal"
    );
    expect(results[4]?.message).toContain(
      "pwa-newest-controller-wins did not leave the local terminal displaced"
    );
    expect(results[5]?.message).toContain(
      "local-space-reclaims-control did not restore local control"
    );
  });

  test("aggregates cleanup failures after the first surface close error and still cleans the PTY", async () => {
    const state = createState();
    const context = createContext();
    const browser = new FakeBrowserDriver(state, {
      pwaCloseError: new Error("pwa close failed"),
    });
    const pty = new FakePty(state, {
      waitForExitError: new Error("pty cleanup wait failed"),
    });

    await expect(
      runDar03(context, {
        now: (() => {
          let current = 1_000;
          return () => ++current;
        })(),
        sleep: async () => {},
        pollIntervalMs: 5,
        createUuid: () => RUN_ID,
        createBrowserDriver: () => browser,
        spawnPty: () => pty,
        findSession: async () => ({
          id: SESSION_ID,
          status: "running",
          cols: state.cols,
          rows: state.rows,
        }),
        readLocalOutput: async () =>
          state.localOutput
            .split("\n")
            .filter((line) => !line.startsWith("DAR_CONTROL_RESIZE "))
            .join("\n"),
        readSessionMeta: async () => ({
          id: SESSION_ID,
          status: state.status,
          cols: state.cols,
          rows: state.rows,
        }),
      })
    ).rejects.toThrow(
      "PWA surface close failed: pwa close failed; PTY cleanup failed: pty cleanup wait failed"
    );

    expect(browser.pwa.closeCalls).toEqual(["pwa"]);
    expect(browser.desktop.closeCalls).toEqual(["desktop"]);
    expect(pty.writeTextCalls).toContain("q");
    expect(pty.killCalls).toBe(1);
  });
});
