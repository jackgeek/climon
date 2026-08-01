import { describe, expect, test } from "bun:test";
import type { ScreenLike } from "../src/drivers/pty.js";
import {
  DAR_04_SUBCHECK_NAMES,
  runDar04,
  type Dar04BrowserDriver,
  type Dar04BrowserSurface,
  type Dar04Context,
  type Dar04Pty,
} from "../src/scenarios/dar-04.js";

const DAR_04_SUBCHECK_TITLES = [
  "larger browser displaces local",
  "local restore jiggles both dimensions",
  "local restore complete authoritative repaint",
  "same-size browser control jiggle",
  "same-size complete repaint",
] as const;

const RUN_ID = "abc123";
const SESSION_ID = "dar-04-session";
const LOCAL_COLS = 100;
const LOCAL_ROWS = 30;
const LARGE_COLS = 132;
const LARGE_ROWS = 44;
const SAME_SIZE_COLS = 118;
const SAME_SIZE_ROWS = 36;
const OVERLAY_MESSAGE = "This session is being viewed on a climon dashboard.";
const OVERLAY_HINT = "Press Space to take control.";

interface ResizeMarker {
  sequence: number;
  cols: number;
  rows: number;
  raw: string;
}

interface ScenarioState {
  sessionId?: string;
  status: "running" | "completed";
  cols: number;
  rows: number;
  localCols: number;
  localRows: number;
  localControllerId: string;
  currentController: string;
  lastToken: string;
  resizeSequence: number;
  localOutput: string;
  localScreen: string;
  pendingScreens: string[];
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

function renderProbeScreen(
  cols: number,
  rows: number,
  lastToken: string,
  resizeSequence: number
): string {
  return `DAR_CONTROL_READY\nsize=${cols}x${rows}\nlast=${lastToken}\nresizes=${resizeSequence}`;
}

function overlayScreen(): string {
  return `${OVERLAY_MESSAGE}\n${OVERLAY_HINT}`;
}

function queueScreen(state: ScenarioState, screen: string): void {
  state.pendingScreens.push(screen);
  state.localScreen = screen;
}

function appendResize(state: ScenarioState, cols: number, rows: number): ResizeMarker {
  state.cols = cols;
  state.rows = rows;
  state.resizeSequence += 1;
  const raw = `DAR_CONTROL_RESIZE ${state.resizeSequence} ${cols} ${rows}`;
  state.localOutput += `${raw}\n`;
  return {
    sequence: state.resizeSequence,
    cols,
    rows,
    raw,
  };
}

function wrapTerminalText(text: string, cols: number): string {
  return text
    .split("\n")
    .flatMap((line) => {
      if (line.length <= cols) {
        return [line];
      }
      const wrapped: string[] = [];
      for (let start = 0; start < line.length; start += cols) {
        wrapped.push(line.slice(start, start + cols));
      }
      return wrapped;
    })
    .join("\n");
}

class FakePty implements Dar04Pty {
  public readonly callLog: string[] = [];
  public readonly writeTextCalls: string[] = [];
  public readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  public readonly waitForQuietCalls: Array<{ quietPeriodMs: number; deadline: number }> = [];
  public readonly waitForExitCalls: number[] = [];
  public killCalls = 0;

  public constructor(
    private readonly state: ScenarioState,
    private readonly options: {
      requireQuietBeforeResizeAfterReclaim?: boolean;
      requireQuietBeforeExitAfterReclaim?: boolean;
      takeControlError?: Error;
      waitForExitError?: Error;
    } = {}
  ) {}

  private requiresQuietBeforeResize = false;
  private requiresQuietBeforeExit = false;

  private localOwnsControl(): boolean {
    return this.state.currentController === this.state.localControllerId;
  }

  public writeText(text: string): void {
    this.callLog.push(`writeText:${JSON.stringify(text)}`);
    this.writeTextCalls.push(text);

    if (text === " ") {
      if (!this.localOwnsControl()) {
        this.state.currentController = this.state.localControllerId;
        const shrink = appendResize(this.state, this.state.localCols - 1, this.state.localRows - 1);
        queueScreen(
          this.state,
          renderProbeScreen(shrink.cols, shrink.rows, this.state.lastToken, shrink.sequence)
        );
        const restore = appendResize(this.state, this.state.localCols, this.state.localRows);
        queueScreen(
          this.state,
          renderProbeScreen(restore.cols, restore.rows, this.state.lastToken, restore.sequence)
        );
      }
      this.requiresQuietBeforeResize ||= this.options.requireQuietBeforeResizeAfterReclaim ?? false;
      this.requiresQuietBeforeExit ||= this.options.requireQuietBeforeExitAfterReclaim ?? false;
      return;
    }

    if (!this.localOwnsControl()) {
      return;
    }

    if (text === "q") {
      if (this.requiresQuietBeforeExit) {
        return;
      }
      this.state.exited = true;
      this.state.status = "completed";
      return;
    }

    if (text.endsWith("\r")) {
      const token = text.slice(0, -1);
      this.state.lastToken = token;
      this.state.localOutput += `DAR_CONTROL_INPUT ${token}\n`;
      queueScreen(
        this.state,
        renderProbeScreen(this.state.cols, this.state.rows, token, this.state.resizeSequence)
      );
    }
  }

  public resize(cols: number, rows: number): void {
    this.callLog.push(`resize:${cols}x${rows}`);
    this.resizeCalls.push({ cols, rows });
    if (!this.localOwnsControl() || this.requiresQuietBeforeResize) {
      return;
    }
    this.state.localCols = cols;
    this.state.localRows = rows;
    const resize = appendResize(this.state, cols, rows);
    queueScreen(
      this.state,
      renderProbeScreen(cols, rows, this.state.lastToken, resize.sequence)
    );
  }

  public async expectRaw(marker: string): Promise<void> {
    this.callLog.push(`expectRaw:${marker}`);
    if (!this.state.localOutput.includes(marker)) {
      throw new Error(`Missing raw marker: ${marker}`);
    }
  }

  public async expectScreen(
    predicate: (screen: ScreenLike) => boolean,
    _deadline: number
  ): Promise<void> {
    this.callLog.push("expectScreen");
    while (this.state.pendingScreens.length > 0) {
      const next = this.state.pendingScreens.shift()!;
      this.state.localScreen = next;
      const queued = new FakeScreen({
        contents: next,
        cursor: { col: 0, row: 0 },
      });
      if (predicate(queued)) {
        return;
      }
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
    this.requiresQuietBeforeResize = false;
    this.requiresQuietBeforeExit = false;
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

class FakeSurface implements Dar04BrowserSurface {
  public readonly openCalls: string[] = [];
  public readonly openTerminalCalls: string[] = [];
  public readonly takeControlCalls: string[] = [];
  public readonly controllerIdCalls: string[] = [];
  public readonly waitForTerminalTextCalls: string[] = [];
  public readonly resizeViewportCalls: Array<{ width: number; height: number }> = [];
  public readonly closeCalls: string[] = [];
  private takeControlCount = 0;
  private resizedSinceDisplaced = false;

  public constructor(
    public readonly name: string,
    public readonly viewerId: string,
    private readonly state: ScenarioState,
    private readonly size: { cols: number; rows: number },
    private readonly options: {
      takeControlError?: Error;
      requireResizeViewportBeforeSecondTakeControl?: boolean;
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
    this.takeControlCount += 1;
    if (this.options.takeControlError) {
      throw this.options.takeControlError;
    }
    this.state.currentController = this.viewerId;
    const sameSize =
      this.state.cols === this.size.cols &&
      this.state.rows === this.size.rows &&
      (!this.options.requireResizeViewportBeforeSecondTakeControl ||
        this.takeControlCount === 1 ||
        this.resizedSinceDisplaced);
    if (sameSize) {
      const shrink = appendResize(this.state, this.size.cols - 1, this.size.rows - 1);
      queueScreen(
        this.state,
        renderProbeScreen(shrink.cols, shrink.rows, this.state.lastToken, shrink.sequence)
      );
      const restore = appendResize(this.state, this.size.cols, this.size.rows);
      queueScreen(
        this.state,
        renderProbeScreen(restore.cols, restore.rows, this.state.lastToken, restore.sequence)
      );
    } else {
      appendResize(this.state, this.size.cols, this.size.rows);
    }
    this.resizedSinceDisplaced = false;
    queueScreen(this.state, overlayScreen());
  }

  public async controllerId(): Promise<string> {
    this.controllerIdCalls.push(this.state.currentController);
    return this.state.currentController;
  }

  public async waitForDisplaced(): Promise<string> {
    this.controllerIdCalls.push(this.state.currentController);
    if (this.state.currentController === this.viewerId) {
      throw new Error(`${this.name} still controls the session`);
    }
    return this.state.currentController;
  }

  public async waitForTerminalText(text: string): Promise<void> {
    this.waitForTerminalTextCalls.push(text);
    if (!(await this.terminalText()).includes(text)) {
      throw new Error(`Missing terminal text: ${text}`);
    }
  }

  public async resizeViewport(width: number, height: number): Promise<void> {
    this.resizeViewportCalls.push({ width, height });
    this.resizedSinceDisplaced = true;
  }

  public async terminalText(): Promise<string> {
    return wrapTerminalText(
      renderProbeScreen(
        this.state.cols,
        this.state.rows,
        this.state.lastToken,
        this.state.resizeSequence
      ),
      this.state.cols
    );
  }

  public async sendTerminalLine(text: string): Promise<void> {
    this.state.lastToken = text;
  }

  public async close(): Promise<void> {
    this.closeCalls.push(this.name);
  }
}

class FakeBrowserDriver implements Dar04BrowserDriver {
  public readonly createSurfaceCalls: Array<{
    name: string;
    viewport: { width: number; height: number };
    displayMode?: "browser" | "standalone";
  }> = [];

  public readonly larger: FakeSurface;
  public readonly sameSize: FakeSurface;

  public constructor(
    private readonly state: ScenarioState,
    private readonly options: { largerTakeControlError?: Error } = {}
  ) {
    this.larger = new FakeSurface(
      "larger-browser",
      "surface-1-larger",
      this.state,
      { cols: LARGE_COLS, rows: LARGE_ROWS },
      { takeControlError: this.options.largerTakeControlError }
    );
    this.sameSize = new FakeSurface(
      "same-size-browser",
      "surface-2-same-size",
      this.state,
      { cols: SAME_SIZE_COLS, rows: SAME_SIZE_ROWS },
      { requireResizeViewportBeforeSecondTakeControl: true }
    );
  }

  public async createSurface(options: {
    name: string;
    viewport: { width: number; height: number };
    displayMode?: "browser" | "standalone";
  }): Promise<Dar04BrowserSurface> {
    this.createSurfaceCalls.push(options);
    if (options.name === "larger-browser") {
      return this.larger;
    }
    if (options.name === "same-size-browser") {
      return this.sameSize;
    }
    throw new Error(`Unexpected surface ${options.name}`);
  }
}

function createState(overrides: Partial<ScenarioState> = {}): ScenarioState {
  const localControllerId = overrides.localControllerId ?? "local";
  return {
    sessionId: SESSION_ID,
    status: "running",
    cols: LOCAL_COLS,
    rows: LOCAL_ROWS,
    localCols: LOCAL_COLS,
    localRows: LOCAL_ROWS,
    localControllerId,
    currentController: overrides.currentController ?? localControllerId,
    lastToken: "ready",
    resizeSequence: 0,
    localOutput: [
      `DAR_MODE_BASELINE {"platform":"linux"}`,
      `DAR_CONTROL_READY ${LOCAL_COLS} ${LOCAL_ROWS}`,
    ].join("\n"),
    localScreen: renderProbeScreen(LOCAL_COLS, LOCAL_ROWS, "ready", 0),
    pendingScreens: [],
    exited: false,
    ...overrides,
  };
}

function createContext(): Dar04Context {
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
        dir: "/repo/artifacts/cases/dar-04",
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

describe("runDar04", () => {
  test("runs all DAR-04 subchecks in order with marker-based jiggle assertions across both restore phases", async () => {
    const state = createState();
    const context = createContext();
    const browser = new FakeBrowserDriver(state);
    const pty = new FakePty(state);

    const results = await runDar04(context, {
      now: (() => {
        let current = 1_000;
        return () => ++current;
      })(),
      sleep: async () => {},
      pollIntervalMs: 5,
      createUuid: () => RUN_ID,
      createBrowserDriver: () => browser,
      spawnPty: () => pty,
      findSession: async () => ({ id: SESSION_ID, status: "running", cols: state.cols, rows: state.rows }),
      readLocalOutput: async () => state.localOutput,
      readSessionMeta: async () => ({
        id: SESSION_ID,
        status: state.status,
        cols: state.cols,
        rows: state.rows,
      }),
    });

    expect(results.map((result) => result.name)).toEqual([...DAR_04_SUBCHECK_NAMES]);
    expect(results.map((result) => result.title)).toEqual([...DAR_04_SUBCHECK_TITLES]);
    expect(results.map((result) => result.status)).toEqual(Array(5).fill("passed"));
    expect(browser.createSurfaceCalls).toEqual([
      {
        name: "larger-browser",
        viewport: { width: 1440, height: 960 },
        displayMode: "browser",
      },
      {
        name: "same-size-browser",
        viewport: { width: 1280, height: 820 },
        displayMode: "browser",
      },
    ]);
    expect(browser.larger.takeControlCalls).toEqual([SESSION_ID]);
    expect(browser.sameSize.takeControlCalls).toEqual([SESSION_ID, SESSION_ID]);
    expect(browser.sameSize.resizeViewportCalls.length).toBeGreaterThan(0);
    expect(results[0]?.evidence).toEqual(
      expect.arrayContaining([
        "DAR_CONTROL_RESIZE 1 132 44",
        "last=dar04-browser-large-abc123",
      ])
    );
    expect(results[1]?.evidence).toEqual(
      expect.arrayContaining([
        "DAR_CONTROL_RESIZE 2 99 29",
        "DAR_CONTROL_RESIZE 3 100 30",
      ])
    );
    expect(results[2]?.evidence).toEqual(
      expect.arrayContaining([
        "DAR_CONTROL_READY\nsize=100x30\nlast=dar04-browser-large-abc123\nresizes=3",
      ])
    );
    expect(results[3]?.evidence).toEqual(
      expect.arrayContaining([
        "DAR_CONTROL_RESIZE 8 117 35",
        "DAR_CONTROL_RESIZE 9 118 36",
      ])
    );
    expect(results[4]?.evidence).toEqual(
      expect.arrayContaining([
        "DAR_CONTROL_READY\nsize=118x36\nlast=dar04-same-size-abc123\nresizes=9",
      ])
    );
    expect(pty.writeTextCalls).toEqual([" ", " ", "dar04-same-size-abc123\r", " ", "q"]);
    expect(pty.killCalls).toBe(0);
  });

  test("waits for PTY quiet before resizing the local terminal after reclaim settles", async () => {
    const state = createState();
    const context = createContext();
    const browser = new FakeBrowserDriver(state);
    const pty = new FakePty(state, {
      requireQuietBeforeResizeAfterReclaim: true,
    });

    const results = await runDar04(context, {
      now: (() => {
        let current = 1_000;
        return () => ++current;
      })(),
      sleep: async () => {},
      pollIntervalMs: 5,
      createUuid: () => RUN_ID,
      createBrowserDriver: () => browser,
      spawnPty: () => pty,
      findSession: async () => ({ id: SESSION_ID, status: "running", cols: state.cols, rows: state.rows }),
      readLocalOutput: async () => state.localOutput,
      readSessionMeta: async () => ({
        id: SESSION_ID,
        status: state.status,
        cols: state.cols,
        rows: state.rows,
      }),
    });

    expect(results.map((result) => result.status)).toEqual(Array(5).fill("passed"));
    const quietIndex = pty.callLog.findIndex((entry) => entry === "waitForQuiet:500");
    const resizeIndex = pty.callLog.findIndex((entry) => entry === "resize:118x36");
    expect(quietIndex).toBeGreaterThan(-1);
    expect(resizeIndex).toBeGreaterThan(quietIndex);
  });

  test("waits for PTY quiet before final q during displaced cleanup after the same-size repaint", async () => {
    const state = createState();
    const context = createContext();
    const browser = new FakeBrowserDriver(state);
    const pty = new FakePty(state, {
      requireQuietBeforeExitAfterReclaim: true,
    });

    const results = await runDar04(context, {
      now: (() => {
        let current = 1_000;
        return () => ++current;
      })(),
      sleep: async () => {},
      pollIntervalMs: 5,
      createUuid: () => RUN_ID,
      createBrowserDriver: () => browser,
      spawnPty: () => pty,
      findSession: async () => ({ id: SESSION_ID, status: "running", cols: state.cols, rows: state.rows }),
      readLocalOutput: async () => state.localOutput,
      readSessionMeta: async () => ({
        id: SESSION_ID,
        status: state.status,
        cols: state.cols,
        rows: state.rows,
      }),
    });

    expect(results.map((result) => result.status)).toEqual(Array(5).fill("passed"));
    expect(pty.callLog.slice(-5)).toEqual([
      `writeText:${JSON.stringify(" ")}`,
      "expectScreen",
      "waitForQuiet:500",
      `writeText:${JSON.stringify("q")}`,
      "waitForExit",
    ]);
  });

  test("reports dependent failures after the larger browser cannot take control", async () => {
    const state = createState();
    const context = createContext();
    const browser = new FakeBrowserDriver(state, {
      largerTakeControlError: new Error("larger browser refused control"),
    });

    const results = await runDar04(context, {
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
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(results[0]?.message).toContain("larger browser refused control");
    expect(results[1]?.message).toContain(
      "larger-browser-displaces-local did not leave the local terminal displaced by a larger browser"
    );
    expect(results[2]?.message).toContain(
      "local-restore-jiggles-both-dimensions did not finish the restore jiggle"
    );
    expect(results[3]?.message).toContain(
      "local-restore-complete-authoritative-repaint did not verify the restored local frame"
    );
    expect(results[4]?.message).toContain(
      "same-size-browser-control-jiggle did not finish the same-size browser jiggle"
    );
  });
});
