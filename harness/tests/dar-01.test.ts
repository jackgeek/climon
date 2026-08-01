import { describe, expect, test } from "bun:test";
import type { HarnessPlatform } from "../src/types.js";
import {
  DAR_01_SUBCHECK_NAMES,
  runDar01,
  type Dar01Context,
  type Dar01Pty,
} from "../src/scenarios/dar-01.js";
import type { MouseEvent, NamedKey } from "../src/drivers/terminal-input.js";
import type {
  PtyDriverDependencies,
  PtySpawnSpec,
  ScreenLike,
} from "../src/drivers/pty.js";

interface FakeScreenFrame {
  contents: string;
  cursor: { col: number; row: number };
}

interface UnixConsoleStateJson {
  echo?: boolean | null;
  icanon?: boolean | null;
  isig?: boolean | null;
  iexten?: boolean | null;
  pendin?: boolean | null;
  error?: string | null;
}

interface WindowsConsoleStateJson {
  validHandle: boolean;
  mode?: number | null;
  echoInput?: boolean | null;
  lineInput?: boolean | null;
  processedInput?: boolean | null;
  extendedFlags?: boolean | null;
  vtInput?: boolean | null;
  processedOutput?: boolean | null;
  wrapAtEol?: boolean | null;
  vtOutput?: boolean | null;
  error?: string | null;
}

type PlatformSnapshotJson =
  | { kind: "unix"; stdin: UnixConsoleStateJson }
  | { kind: "windows"; input: WindowsConsoleStateJson; output: WindowsConsoleStateJson }
  | { kind: "unsupported"; error: string };

interface ModeProbeBaselineJson {
  command: string[];
  platform: HarnessPlatform;
  before: PlatformSnapshotJson;
}

interface ModeProbeResultJson {
  command: string[];
  platform: HarnessPlatform;
  before: PlatformSnapshotJson;
  after: PlatformSnapshotJson;
  childExitCode: number;
  functionalRestored: boolean | null;
  pendinChanged: boolean | null;
  spawnError: string | null;
}

class FakeScreen implements ScreenLike {
  public constructor(private readonly frame: FakeScreenFrame) {}

  public async write(): Promise<void> {}

  public resize(): void {}

  public contents(): string {
    return this.frame.contents;
  }

  public cursor(): { col: number; row: number } {
    return this.frame.cursor;
  }
}

class FakePty implements Dar01Pty {
  public readonly callLog: string[] = [];
  public readonly writeTextCalls: string[] = [];
  public readonly sendControlCalls: string[] = [];
  public readonly sendKeyCalls: NamedKey[] = [];
  public readonly sendMouseCalls: MouseEvent[] = [];
  public readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  public readonly expectRawCalls: Array<{ marker: string; deadline: number }> = [];
  public readonly waitForQuietCalls: Array<{ quietPeriodMs: number; deadline: number }> = [];
  public readonly waitForExitCalls: number[] = [];
  public killCalls = 0;

  public constructor(
    private readonly options: {
      rawFailures?: Record<string, Error>;
      screenFrames?: FakeScreenFrame[];
      waitForExitError?: Error;
      waitForExitResults?: Array<number | Error>;
      exitCode?: number;
    } = {}
  ) {}

  public writeText(text: string): void {
    this.callLog.push(`writeText:${text}`);
    this.writeTextCalls.push(text);
  }

  public sendControl(key: string): void {
    this.callLog.push(`sendControl:${key}`);
    this.sendControlCalls.push(key);
  }

  public sendKey(key: NamedKey): void {
    this.callLog.push(`sendKey:${key}`);
    this.sendKeyCalls.push(key);
  }

  public sendMouse(event: MouseEvent): void {
    this.callLog.push(`sendMouse:${event.kind}:${event.col}:${event.row}`);
    this.sendMouseCalls.push(event);
  }

  public resize(cols: number, rows: number): void {
    this.callLog.push(`resize:${cols}x${rows}`);
    this.resizeCalls.push({ cols, rows });
  }

  public expectRaw(marker: string, deadline: number): Promise<void> {
    this.callLog.push(`expectRaw:${marker}`);
    this.expectRawCalls.push({ marker, deadline });
    const error = this.options.rawFailures?.[marker];
    return error ? Promise.reject(error) : Promise.resolve();
  }

  public expectScreen(
    predicate: (screen: ScreenLike) => boolean,
    _deadline: number
  ): Promise<void> {
    this.callLog.push("expectScreen");
    const frame =
      this.options.screenFrames?.shift() ??
      this.options.screenFrames?.[0] ?? {
        contents: "",
        cursor: { col: 0, row: 0 },
      };
    return predicate(new FakeScreen(frame))
      ? Promise.resolve()
      : Promise.reject(new Error(`Screen predicate failed for ${JSON.stringify(frame)}`));
  }

  public waitForQuiet(quietPeriodMs: number, deadline: number): Promise<void> {
    this.callLog.push(`waitForQuiet:${quietPeriodMs}`);
    this.waitForQuietCalls.push({ quietPeriodMs, deadline });
    return Promise.resolve();
  }

  public waitForExit(deadline: number): Promise<number> {
    this.callLog.push("waitForExit");
    this.waitForExitCalls.push(deadline);
    const nextResult = this.options.waitForExitResults?.shift();
    if (nextResult instanceof Error) {
      return Promise.reject(nextResult);
    }
    if (typeof nextResult === "number") {
      return Promise.resolve(nextResult);
    }
    if (this.options.waitForExitError) {
      return Promise.reject(this.options.waitForExitError);
    }
    return Promise.resolve(this.options.exitCode ?? 0);
  }

  public kill(): void {
    this.callLog.push("kill");
    this.killCalls += 1;
  }
}

function createClock(start = 10_000): () => number {
  let current = start;
  return () => {
    current += 1;
    return current;
  };
}

function createContext(platform: HarnessPlatform = "linux"): Dar01Context {
  return {
    platform,
    overallDeadline: 99_999,
    build: {
      clientPath: "/repo/bin/climon",
      fixturePath: "/repo/bin/climon-harness-fixture",
    },
    runtime: {
      root: "/repo",
      env: {
        TERM: "xterm-256color",
        CLIMON_HOME: "/repo/.climon",
      },
      artifacts: {
        dir: "/repo/artifacts/cases/dar-01",
        async appendText(): Promise<void> {},
      },
    },
  };
}

function unixSnapshot(overrides: Partial<UnixConsoleStateJson> = {}): PlatformSnapshotJson {
  return {
    kind: "unix",
    stdin: {
      echo: true,
      icanon: true,
      isig: true,
      iexten: true,
      pendin: false,
      error: null,
      ...overrides,
    },
  };
}

function windowsInputState(
  overrides: Partial<WindowsConsoleStateJson> = {}
): WindowsConsoleStateJson {
  return {
    validHandle: true,
    mode: 39,
    echoInput: true,
    lineInput: true,
    processedInput: true,
    extendedFlags: true,
    vtInput: false,
    error: null,
    ...overrides,
  };
}

function windowsOutputState(
  overrides: Partial<WindowsConsoleStateJson> = {}
): WindowsConsoleStateJson {
  return {
    validHandle: true,
    mode: 3,
    processedOutput: true,
    wrapAtEol: true,
    vtOutput: false,
    error: null,
    ...overrides,
  };
}

function windowsSnapshot(options: {
  input?: Partial<WindowsConsoleStateJson>;
  output?: Partial<WindowsConsoleStateJson>;
} = {}): PlatformSnapshotJson {
  return {
    kind: "windows",
    input: windowsInputState(options.input),
    output: windowsOutputState(options.output),
  };
}

function textMarkers(text: string): string[] {
  return Array.from(text, (character) => `DAR_TUI_TEXT ${character}`);
}

function buildOutput(
  platform: HarnessPlatform,
  sessionName: string,
  text: string,
  options: {
    baselineBefore?: PlatformSnapshotJson;
    resultBefore?: PlatformSnapshotJson;
    resultAfter?: PlatformSnapshotJson;
    childExitCode?: number;
    functionalRestored?: boolean | null;
    pendinChanged?: boolean | null;
    includeResult?: boolean;
    resultPrefix?: string;
    baselineLine?: string;
    resultLine?: string;
    extraLines?: string[];
  } = {}
): string {
  const baselineBefore =
    options.baselineBefore ?? (platform === "windows" ? windowsSnapshot() : unixSnapshot());
  const baseline: ModeProbeBaselineJson = {
    command: [
      "/repo/bin/climon",
      "run",
      "--name",
      sessionName,
      "/repo/bin/climon-harness-fixture",
      "interactive-tui",
    ],
    platform,
    before: baselineBefore,
  };
  const result: ModeProbeResultJson = {
    command: baseline.command,
    platform,
    before: options.resultBefore ?? baselineBefore,
    after: options.resultAfter ?? options.resultBefore ?? baselineBefore,
    childExitCode: options.childExitCode ?? 0,
    functionalRestored: options.functionalRestored ?? true,
    pendinChanged: options.pendinChanged ?? false,
    spawnError: null,
  };

  return [
    options.baselineLine ?? `DAR_MODE_BASELINE ${JSON.stringify(baseline)}`,
    "021 DAR_TUI_READY",
    ...textMarkers(text),
    "DAR_TUI_CONTROL Ctrl+C",
    "DAR_TUI_KEY ArrowUp",
    "DAR_TUI_MOUSE_PRESS Left 10 6",
    "DAR_TUI_MOUSE_RELEASE Left 10 6",
    "DAR_TUI_MOUSE_WHEEL_UP 10 6",
    "DAR_TUI_RESIZE 120 40",
    "040 DAR_TUI_EXIT",
    ...(options.extraLines ?? []),
    options.includeResult === false
      ? ""
      : options.resultLine ??
        `\u001b[?25h\u001b[?1049l${options.resultPrefix ?? "DAR_MODE_RESULT "}${JSON.stringify(result)}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function passingScreens(): FakeScreenFrame[] {
  return [
    {
      contents: "DAR_TUI_READY\nsize=100x30\nlast=mouse:wheel-up:10:6",
      cursor: { col: 0, row: 3 },
    },
    {
      contents: "DAR_TUI_READY\nsize=120x40\nlast=resize:120x40",
      cursor: { col: 0, row: 3 },
    },
  ];
}

describe("runDar01", () => {
  test("runs all DAR-01 subchecks in order with exact spawn and terminal interactions", async () => {
    const context = createContext();
    const clock = createClock();
    const pty = new FakePty({ screenFrames: passingScreens(), exitCode: 0 });
    const spawnCalls: Array<{ spec: PtySpawnSpec; deps: PtyDriverDependencies }> = [];
    const uuid = "abc123";
    const expectedText = `dar01-é-${uuid}`;
    const output = buildOutput(context.platform, `DAR-01-${uuid}`, expectedText);

    const results = await runDar01(context, {
      now: clock,
      createUuid: () => uuid,
      spawnPty(spec, deps) {
        spawnCalls.push({ spec, deps });
        return pty;
      },
      readArtifactText: async () => output,
    });

    expect(results.map((result) => result.name)).toEqual([...DAR_01_SUBCHECK_NAMES]);
    expect(results.map((result) => result.status)).toEqual([
      "passed",
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
    expect(results.every((result) => result.evidence?.includes("pty/input.log"))).toBe(true);
    expect(results.every((result) => result.evidence?.includes("pty/output.log"))).toBe(true);
    expect(results[0]).toMatchObject({
      name: "baseline-terminal-mode",
      status: "passed",
      message: expect.stringContaining("before.kind=unix"),
      evidence: expect.arrayContaining([expect.stringContaining("DAR_MODE_BASELINE ")]),
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      spec: {
        file: "/repo/bin/climon-harness-fixture",
        args: [
          "mode-probe",
          "--",
          "/repo/bin/climon",
          "run",
          "--name",
          "DAR-01-abc123",
          "/repo/bin/climon-harness-fixture",
          "interactive-tui",
        ],
        cwd: "/repo",
        env: context.runtime.env,
        cols: 100,
        rows: 30,
        inputPath: "pty/input.log",
        outputPath: "pty/output.log",
      },
      deps: {
        now: clock,
        appendText: expect.any(Function),
      },
    });

    expect(pty.callLog).toEqual([
      "expectRaw:DAR_MODE_BASELINE ",
      "expectRaw:021 DAR_TUI_READY",
      `writeText:${expectedText}`,
      ...Array.from(expectedText, (character) => `expectRaw:DAR_TUI_TEXT ${character}`),
      "sendControl:c",
      "expectRaw:DAR_TUI_CONTROL Ctrl+C",
      "sendKey:ArrowUp",
      "expectRaw:DAR_TUI_KEY ArrowUp",
      "sendMouse:press:10:6",
      "expectRaw:DAR_TUI_MOUSE_PRESS Left 10 6",
      "sendMouse:release:10:6",
      "expectRaw:DAR_TUI_MOUSE_RELEASE Left 10 6",
      "sendMouse:wheel-up:10:6",
      "expectRaw:DAR_TUI_MOUSE_WHEEL_UP 10 6",
      "expectScreen",
      "resize:120x40",
      "expectRaw:DAR_TUI_RESIZE 120 40",
      "expectScreen",
      "waitForQuiet:500",
      "writeText:q",
      "waitForExit",
    ]);
    expect(pty.sendControlCalls).toEqual(["c"]);
    expect(pty.sendKeyCalls).toEqual(["ArrowUp"]);
    expect(pty.sendMouseCalls).toEqual([
      { kind: "press", button: 0, col: 10, row: 6 },
      { kind: "release", button: 0, col: 10, row: 6 },
      { kind: "wheel-up", col: 10, row: 6 },
    ]);
    expect(pty.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
    expect(pty.waitForQuietCalls).toHaveLength(1);
    expect(pty.writeTextCalls).toEqual([expectedText, "q"]);
  });

  test("retries q after a late duplicate resize surfaces during clean exit", async () => {
    const context = createContext();
    const clock = createClock();
    const pty = new FakePty({
      screenFrames: passingScreens(),
      waitForExitResults: [new Error("Timed out waiting for process exit"), 0],
    });
    const uuid = "late-resize";

    const results = await runDar01(context, {
      now: clock,
      createUuid: () => uuid,
      spawnPty: () => pty,
      readArtifactText: async () =>
        buildOutput(context.platform, `DAR-01-${uuid}`, `dar01-é-${uuid}`),
    });

    expect(results.find((result) => result.name === "clean-exit")).toMatchObject({
      status: "passed",
    });
    expect(results.find((result) => result.name === "terminal-mode-restoration")).toMatchObject({
      status: "passed",
    });
    expect(pty.callLog.slice(-6)).toEqual([
      "waitForQuiet:500",
      "writeText:q",
      "waitForExit",
      "waitForQuiet:500",
      "writeText:q",
      "waitForExit",
    ]);
    expect(pty.writeTextCalls.filter((call) => call === "q")).toHaveLength(2);
  });

  test("continues to clean exit and restoration after mouse-input fails", async () => {
    const context = createContext();
    const pty = new FakePty({
      rawFailures: {
        "DAR_TUI_MOUSE_WHEEL_UP 10 6": new Error("mouse marker missing"),
      },
      screenFrames: passingScreens(),
      exitCode: 0,
    });
    const uuid = "mouse-failure";
    const output = buildOutput(
      context.platform,
      `DAR-01-${uuid}`,
      `dar01-é-${uuid}`
    );

    const results = await runDar01(context, {
      now: createClock(),
      createUuid: () => uuid,
      spawnPty: (spec) => {
        expect(spec.args[5]).toBe(`DAR-01-${uuid}`);
        return pty;
      },
      readArtifactText: async () => output,
    });

    expect(results.map((result) => [result.name, result.status])).toEqual([
      ["baseline-terminal-mode", "passed"],
      ["attached-startup", "passed"],
      ["text-input-output", "passed"],
      ["control-and-key-input", "passed"],
      ["mouse-input", "failed"],
      ["alternate-screen-render", "passed"],
      ["resize-repaint", "passed"],
      ["clean-exit", "passed"],
      ["terminal-mode-restoration", "passed"],
    ]);
    expect(pty.writeTextCalls.at(-1)).toBe("q");
    expect(pty.waitForExitCalls).toHaveLength(1);
    expect(pty.killCalls).toBe(0);
  });

  test("passes a bound artifact appender to the PTY driver", async () => {
    const context = createContext();
    const writes: Array<{ dir: string; artifactPath: string; text: string }> = [];
    let appendPromise: Promise<void> | undefined;
    context.runtime.artifacts = {
      dir: "/repo/artifacts/cases/dar-01",
      async appendText(
        this: { dir: string },
        artifactPath: string,
        text: string
      ): Promise<void> {
        writes.push({ dir: this.dir, artifactPath, text });
      },
    };
    const uuid = "bound-artifacts";

    await runDar01(context, {
      now: createClock(),
      createUuid: () => uuid,
      spawnPty(_spec, deps) {
        appendPromise = deps.appendText?.("probe.log", "ok");
        return new FakePty({ screenFrames: passingScreens(), exitCode: 0 });
      },
      readArtifactText: async () =>
        buildOutput(context.platform, `DAR-01-${uuid}`, `dar01-é-${uuid}`),
    });

    await appendPromise;
    expect(writes).toEqual([
      {
        dir: "/repo/artifacts/cases/dar-01",
        artifactPath: "probe.log",
        text: "ok",
      },
    ]);
  });

  test("fails baseline-terminal-mode when the unix baseline is not functionally cooked", async () => {
    const uuid = "unix-baseline";
    const results = await runDar01(createContext("linux"), {
      now: createClock(),
      createUuid: () => uuid,
      spawnPty: () => new FakePty({ screenFrames: passingScreens(), exitCode: 0 }),
      readArtifactText: async () =>
        buildOutput("linux", `DAR-01-${uuid}`, `dar01-é-${uuid}`, {
          baselineBefore: unixSnapshot({ echo: false }),
        }),
    });

    expect(results.find((result) => result.name === "baseline-terminal-mode")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("stdin.echo=true"),
    });
  });

  test("fails baseline-terminal-mode when the windows baseline is not functionally cooked", async () => {
    const uuid = "windows-baseline";
    const results = await runDar01(createContext("windows"), {
      now: createClock(),
      createUuid: () => uuid,
      spawnPty: () => new FakePty({ screenFrames: passingScreens(), exitCode: 0 }),
      readArtifactText: async () =>
        buildOutput("windows", `DAR-01-${uuid}`, `dar01-é-${uuid}`, {
          baselineBefore: windowsSnapshot({ output: { wrapAtEol: false } }),
        }),
    });

    expect(results.find((result) => result.name === "baseline-terminal-mode")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("output.wrapAtEol=true"),
    });
  });

  test("kills the PTY when clean exit fails", async () => {
    const context = createContext();
    const uuid = "exit-timeout";
    const pty = new FakePty({
      screenFrames: passingScreens(),
      waitForExitError: new Error("exit timed out"),
    });

    const results = await runDar01(context, {
      now: createClock(),
      createUuid: () => uuid,
      spawnPty: () => pty,
      readArtifactText: async () =>
        buildOutput(context.platform, `DAR-01-${uuid}`, `dar01-é-${uuid}`, {
          includeResult: false,
        }),
    });

    expect(results.find((result) => result.name === "clean-exit")).toMatchObject({
      status: "failed",
    });
    expect(results.find((result) => result.name === "terminal-mode-restoration")).toMatchObject({
      status: "failed",
    });
    expect(pty.writeTextCalls.filter((call) => call === "q")).toHaveLength(1);
    expect(pty.killCalls).toBe(1);
  });

  test("requires the exact DAR_MODE_RESULT prefix instead of accepting bare JSON", async () => {
    const uuid = "result-prefix";
    const results = await runDar01(createContext("linux"), {
      now: createClock(),
      createUuid: () => uuid,
      spawnPty: () => new FakePty({ screenFrames: passingScreens(), exitCode: 0 }),
      readArtifactText: async () =>
        buildOutput("linux", `DAR-01-${uuid}`, `dar01-é-${uuid}`, {
          resultPrefix: "",
        }),
    });

    expect(results.find((result) => result.name === "terminal-mode-restoration")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("Missing DAR_MODE_RESULT marker"),
    });
  });

  test("rejects malformed and duplicate mode markers", async () => {
    const cases = [
      {
        name: "duplicate baseline marker",
        output: buildOutput("linux", "DAR-01-duplicate-baseline", "dar01-é-duplicate-baseline", {
          extraLines: [
            `DAR_MODE_BASELINE ${JSON.stringify({
              command: ["/repo/bin/climon", "run"],
              platform: "linux",
              before: unixSnapshot(),
            })}`,
          ],
        }),
        expectedSubcheck: "baseline-terminal-mode",
        expectedMessage: "Expected exactly one DAR_MODE_BASELINE marker, found 2",
      },
      {
        name: "malformed baseline marker",
        output: buildOutput("linux", "DAR-01-malformed-baseline", "dar01-é-malformed-baseline", {
          baselineLine: "DAR_MODE_BASELINE {not-json}",
        }),
        expectedSubcheck: "baseline-terminal-mode",
        expectedMessage: "Malformed DAR_MODE_BASELINE marker JSON",
      },
      {
        name: "duplicate result marker",
        output: buildOutput("linux", "DAR-01-duplicate-result", "dar01-é-duplicate-result", {
          extraLines: [
            `DAR_MODE_RESULT ${JSON.stringify({
              command: ["/repo/bin/climon", "run"],
              platform: "linux",
              before: unixSnapshot(),
              after: unixSnapshot(),
              childExitCode: 0,
              functionalRestored: true,
              pendinChanged: false,
              spawnError: null,
            })}`,
          ],
        }),
        expectedSubcheck: "terminal-mode-restoration",
        expectedMessage: "Expected exactly one DAR_MODE_RESULT marker, found 2",
      },
      {
        name: "malformed result marker",
        output: buildOutput("linux", "DAR-01-malformed-result", "dar01-é-malformed-result", {
          resultLine: "DAR_MODE_RESULT {not-json}",
        }),
        expectedSubcheck: "terminal-mode-restoration",
        expectedMessage: "Malformed DAR_MODE_RESULT marker JSON",
      },
    ] as const;

    for (const testCase of cases) {
      const results = await runDar01(createContext("linux"), {
        now: createClock(),
        createUuid: () => testCase.name,
        spawnPty: () => new FakePty({ screenFrames: passingScreens(), exitCode: 0 }),
        readArtifactText: async () => testCase.output,
      });

      expect(results.find((result) => result.name === testCase.expectedSubcheck)).toMatchObject({
        status: "failed",
        message: expect.stringContaining(testCase.expectedMessage),
      });
    }
  });

  test("allows macOS pendinChanged=true but fails terminal restoration on linux", async () => {
    const uuid = "pendin";
    const macos = await runDar01(createContext("macos"), {
      now: createClock(),
      createUuid: () => uuid,
      spawnPty: () => new FakePty({ screenFrames: passingScreens(), exitCode: 0 }),
      readArtifactText: async () =>
        buildOutput("macos", `DAR-01-${uuid}`, `dar01-é-${uuid}`, {
          pendinChanged: true,
        }),
    });
    const linux = await runDar01(createContext("linux"), {
      now: createClock(),
      createUuid: () => uuid,
      spawnPty: () => new FakePty({ screenFrames: passingScreens(), exitCode: 0 }),
      readArtifactText: async () =>
        buildOutput("linux", `DAR-01-${uuid}`, `dar01-é-${uuid}`, {
          pendinChanged: true,
        }),
    });

    expect(macos.find((result) => result.name === "terminal-mode-restoration")).toMatchObject({
      status: "passed",
      message: expect.stringContaining("pendinChanged=true"),
    });
    expect(linux.find((result) => result.name === "terminal-mode-restoration")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("pendinChanged=true"),
    });
  });
});
