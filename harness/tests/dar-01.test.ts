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
  public readonly waitForExitCalls: number[] = [];
  public killCalls = 0;

  public constructor(
    private readonly options: {
      rawFailures?: Record<string, Error>;
      screenFrames?: FakeScreenFrame[];
      waitForExitError?: Error;
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

  public waitForExit(deadline: number): Promise<number> {
    this.callLog.push("waitForExit");
    this.waitForExitCalls.push(deadline);
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

function buildOutput(
  platform: HarnessPlatform,
  sessionName: string,
  textMarker: string,
  options: { pendinChanged?: boolean | null; includeResult?: boolean } = {}
): string {
  const baseline = {
    command: [
      "/repo/bin/climon",
      "run",
      "--name",
      sessionName,
      "fixture",
      "interactive-tui",
    ],
    platform,
  };
  const result = {
    command: baseline.command,
    platform,
    childExitCode: 0,
    functionalRestored: true,
    pendinChanged: options.pendinChanged ?? false,
  };

  return [
    `DAR_MODE_BASELINE ${JSON.stringify(baseline)}`,
    "021 DAR_TUI_READY",
    `DAR_TUI_TEXT ${textMarker}`,
    "DAR_TUI_CONTROL Ctrl+C",
    "DAR_TUI_KEY ArrowUp",
    "DAR_TUI_MOUSE_PRESS Left 10 6",
    "DAR_TUI_MOUSE_RELEASE Left 10 6",
    "DAR_TUI_MOUSE_WHEEL_UP 10 6",
    "DAR_TUI_RESIZE 120 40",
    "040 DAR_TUI_EXIT",
    options.includeResult === false
      ? ""
      : `\u001b[?25h\u001b[?1049l${JSON.stringify(result)}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function passingScreens(): FakeScreenFrame[] {
  return [
    {
      contents:
        "DAR_TUI_READY\nevent=mouse:wheel-up:10:6\nlast-marker=DAR_TUI_MOUSE_WHEEL_UP 10 6\nsize=100x30",
      cursor: { col: 0, row: 3 },
    },
    {
      contents:
        "DAR_TUI_READY\nDAR_TUI_RESIZE 120 40\nevent=resize:120x40\nsize=120x40",
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
    const expectedText = `DAR-01-こんにちは-ß-${uuid}`;
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

    expect(spawnCalls).toEqual([
      {
        spec: {
          file: "/repo/bin/climon-harness-fixture",
          args: [
            "mode-probe",
            "--",
            "/repo/bin/climon",
            "run",
            "--name",
            "DAR-01-abc123",
            "fixture",
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
          appendText: context.runtime.artifacts.appendText,
        },
      },
    ]);

    expect(pty.callLog).toEqual([
      "expectRaw:DAR_MODE_BASELINE ",
      "expectRaw:021 DAR_TUI_READY",
      `writeText:${expectedText}`,
      `expectRaw:DAR_TUI_TEXT ${expectedText}`,
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
    expect(pty.writeTextCalls).toEqual([expectedText, "q"]);
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
      `DAR-01-こんにちは-ß-${uuid}`
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
        buildOutput(context.platform, `DAR-01-${uuid}`, `DAR-01-こんにちは-ß-${uuid}`, {
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

  test("allows macOS pendinChanged=true but fails terminal restoration on linux", async () => {
    const uuid = "pendin";
    const macos = await runDar01(createContext("macos"), {
      now: createClock(),
      createUuid: () => uuid,
      spawnPty: () => new FakePty({ screenFrames: passingScreens(), exitCode: 0 }),
      readArtifactText: async () =>
        buildOutput("macos", `DAR-01-${uuid}`, `DAR-01-こんにちは-ß-${uuid}`, {
          pendinChanged: true,
        }),
    });
    const linux = await runDar01(createContext("linux"), {
      now: createClock(),
      createUuid: () => uuid,
      spawnPty: () => new FakePty({ screenFrames: passingScreens(), exitCode: 0 }),
      readArtifactText: async () =>
        buildOutput("linux", `DAR-01-${uuid}`, `DAR-01-こんにちは-ß-${uuid}`, {
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
