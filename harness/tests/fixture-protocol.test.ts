import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ScreenModel } from "../src/drivers/screen-model.js";
import {
  controlChord,
  namedKey,
  sgrMouse,
} from "../src/drivers/terminal-input.js";

const ROOT = resolve(import.meta.dir, "..", "..");
const FIXTURE_ROOT = join(ROOT, "harness", "fixtures");
const FIXTURE_MANIFEST = join(FIXTURE_ROOT, "Cargo.toml");
const FIXTURE_TARGET = join(FIXTURE_ROOT, "target");
const FIXTURE_PROFILE = process.env.CLIMON_FIXTURE_PROFILE === "release" ? "release" : "debug";
const FIXTURE_PATH = join(
  FIXTURE_TARGET,
  FIXTURE_PROFILE,
  process.platform === "win32" ? "climon-harness-fixture.exe" : "climon-harness-fixture"
);

let fixtureBuildPromise: Promise<string> | undefined;

function futureDeadline(): number {
  return Date.now() + 10_000;
}

async function buildFixture(): Promise<string> {
  fixtureBuildPromise ??= new Promise<string>((resolvePath, reject) => {
    const args =
      FIXTURE_PROFILE === "release"
        ? ["build", "--release", "--manifest-path", FIXTURE_MANIFEST]
        : ["build", "--manifest-path", FIXTURE_MANIFEST];
    const child = spawn("cargo", args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null && existsSync(FIXTURE_PATH)) {
        resolvePath(FIXTURE_PATH);
        return;
      }

      reject(
        new Error(
          [
            `cargo ${args.join(" ")} failed`,
            `code=${String(code)} signal=${String(signal)}`,
            stdout.trim(),
            stderr.trim(),
          ]
            .filter((part) => part.length > 0)
            .join("\n")
        )
      );
    });
  });

  return fixtureBuildPromise;
}

function spawnFixture(args: string[]) {
  const child = spawn(FIXTURE_PATH, args, {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return child;
}

function collectProcessText(child: ReturnType<typeof spawnFixture>) {
  let stdout = "";
  let stderr = "";
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    stdoutBuffer += chunk;
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      stdoutLines.push(stdoutBuffer.slice(0, newline));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
    }
  });

  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    stderrBuffer += chunk;
    while (true) {
      const newline = stderrBuffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      stderrLines.push(stderrBuffer.slice(0, newline));
      stderrBuffer = stderrBuffer.slice(newline + 1);
    }
  });

  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    stdoutLines,
    stderrLines,
  };
}

async function waitForLine(lines: string[], expected: string): Promise<void> {
  const deadline = futureDeadline();
  while (Date.now() < deadline) {
    if (lines.includes(expected)) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for line: ${expected}\nSaw: ${JSON.stringify(lines)}`);
}

async function waitForSubstring(read: () => string, expected: string): Promise<void> {
  const deadline = futureDeadline();
  while (Date.now() < deadline) {
    if (read().includes(expected)) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for substring: ${expected}\nSaw: ${read()}`);
}

async function waitForScreen(
  read: () => string,
  expected: string
): Promise<void> {
  const deadline = futureDeadline();
  while (Date.now() < deadline) {
    if (read() === expected) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for screen: ${expected}\nSaw: ${read()}`);
}

async function writeChunks(
  stdin: NonNullable<ReturnType<typeof spawnFixture>["stdin"]>,
  chunks: string[]
): Promise<void> {
  for (const chunk of chunks) {
    const accepted = stdin.write(chunk);
    if (!accepted) {
      await once(stdin, "drain");
    }
  }
}

function markerList(raw: string): string[] {
  const plain = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  return Array.from(
    plain.matchAll(/^0(?:0[1-9]|1\d|20|2\d|3\d|40) [^\r\n]+$/gm),
    (match) => match[0].trim()
  );
}

describe("climon-harness-fixture stream protocol", () => {
  test("streams exact 001..020 markers in order and exits after the exit handshake", async () => {
    await buildFixture();
    const child = spawnFixture(["stream-protocol"]);
    const exitPromise = once(child, "exit");
    const text = collectProcessText(child);

    await waitForLine(text.stdoutLines, "001 DAR_STREAM_READY");

    const commands: Array<[string[], string]> = [
      [["HE", "LLO handshake\n"], "002 DAR_STREAM_HELLO handshake"],
      [["TEXT ", "alpha\n"], "003 DAR_STREAM_TEXT alpha"],
      [["TEXT two", " words\n"], "004 DAR_STREAM_TEXT two words"],
      [["TEXT utf8", " ✓\n"], "005 DAR_STREAM_TEXT utf8 ✓"],
      [["KEY Arrow", "Up\n"], "006 DAR_STREAM_KEY ArrowUp"],
      [["KEY Arrow", "Left\n"], "007 DAR_STREAM_KEY ArrowLeft"],
      [["KEY En", "ter\n"], "008 DAR_STREAM_KEY Enter"],
      [["KEY Esc", "ape\n"], "009 DAR_STREAM_KEY Escape"],
      [["CTRL C", "\n"], "010 DAR_STREAM_CONTROL Ctrl+C"],
      [["CTRL Q", "\n"], "011 DAR_STREAM_CONTROL Ctrl+Q"],
      [["MOUSE PRESS left 1", " 1\n"], "012 DAR_STREAM_MOUSE_PRESS left 1 1"],
      [["MOUSE RELEASE left ", "1 1\n"], "013 DAR_STREAM_MOUSE_RELEASE left 1 1"],
      [["MOUSE WHEEL up 2 ", "3\n"], "014 DAR_STREAM_MOUSE_WHEEL_UP 2 3"],
      [["MOUSE WHEEL down ", "2 3\n"], "015 DAR_STREAM_MOUSE_WHEEL_DOWN 2 3"],
      [["MOUSE MOVE left 4", " 5\n"], "016 DAR_STREAM_MOUSE_MOVE left 4 5"],
      [["RESIZE 100", " 30\n"], "017 DAR_STREAM_RESIZE 100 30"],
      [["STATUS\n"], "018 DAR_STREAM_STATUS ok"],
      [["TEXT final marker\n"], "019 DAR_STREAM_TEXT final marker"],
      [["EXIT 0", "\n"], "020 DAR_STREAM_EXIT 0"],
    ];

    for (const [chunks, expected] of commands) {
      await writeChunks(child.stdin, chunks);
      if (expected === "020 DAR_STREAM_EXIT 0") {
        child.stdin.end();
      }
      await waitForLine(text.stdoutLines, expected);
    }

    const [code, signal] = await exitPromise;
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(text.stderr).toBe("");
    expect(text.stdoutLines).toEqual([
      "001 DAR_STREAM_READY",
      "002 DAR_STREAM_HELLO handshake",
      "003 DAR_STREAM_TEXT alpha",
      "004 DAR_STREAM_TEXT two words",
      "005 DAR_STREAM_TEXT utf8 ✓",
      "006 DAR_STREAM_KEY ArrowUp",
      "007 DAR_STREAM_KEY ArrowLeft",
      "008 DAR_STREAM_KEY Enter",
      "009 DAR_STREAM_KEY Escape",
      "010 DAR_STREAM_CONTROL Ctrl+C",
      "011 DAR_STREAM_CONTROL Ctrl+Q",
      "012 DAR_STREAM_MOUSE_PRESS left 1 1",
      "013 DAR_STREAM_MOUSE_RELEASE left 1 1",
      "014 DAR_STREAM_MOUSE_WHEEL_UP 2 3",
      "015 DAR_STREAM_MOUSE_WHEEL_DOWN 2 3",
      "016 DAR_STREAM_MOUSE_MOVE left 4 5",
      "017 DAR_STREAM_RESIZE 100 30",
      "018 DAR_STREAM_STATUS ok",
      "019 DAR_STREAM_TEXT final marker",
      "020 DAR_STREAM_EXIT 0",
    ]);
  });

  test("rejects malformed stream input with stable stderr and exit 2", async () => {
    await buildFixture();
    const child = spawnFixture(["stream-protocol"]);
    const exitPromise = once(child, "exit");
    const text = collectProcessText(child);

    await waitForLine(text.stdoutLines, "001 DAR_STREAM_READY");
    await writeChunks(child.stdin, ["MOUSE PRESS left nope 1\n"]);

    const [code, signal] = await exitPromise;
    expect(code).toBe(2);
    expect(signal).toBeNull();
    expect(text.stdoutLines).toEqual(["001 DAR_STREAM_READY"]);
    expect(text.stderr).toBe("Malformed stream input: MOUSE PRESS left nope 1\n");
  });
});

describe("climon-harness-fixture terminal modes and TUI", () => {
  test("emits the baseline marker before mode probing and returns the child exit code", async () => {
    await buildFixture();
    const child = spawnFixture([
      "mode-probe",
      "--",
      "node",
      "-e",
      "process.exit(7)",
    ]);
    const exitPromise = once(child, "exit");
    const text = collectProcessText(child);

    const [code, signal] = await exitPromise;
    expect(code).toBe(7);
    expect(signal).toBeNull();
    expect(text.stderr).toBe("");
    expect(text.stdoutLines).toHaveLength(2);
    expect(text.stdoutLines[0]?.startsWith("DAR_MODE_BASELINE ")).toBe(true);

    const baseline = JSON.parse(text.stdoutLines[0]!.slice("DAR_MODE_BASELINE ".length)) as {
      command: string[];
      platform: string;
    };
    const result = JSON.parse(text.stdoutLines[1]!) as {
      childExitCode: number;
      command: string[];
      functionalRestored: boolean | null;
      pendinChanged: boolean | null;
      platform: string;
    };

    expect(baseline.command).toEqual(["node", "-e", "process.exit(7)"]);
    expect(result.command).toEqual(["node", "-e", "process.exit(7)"]);
    expect(result.childExitCode).toBe(7);
    expect(result.platform).toBe(baseline.platform);
    expect(typeof result.functionalRestored === "boolean" || result.functionalRestored === null).toBe(
      true
    );
    expect(typeof result.pendinChanged === "boolean" || result.pendinChanged === null).toBe(true);
  });

  test("renders exact 021..040 markers for TUI input and exits only on plain q", async () => {
    await buildFixture();
    const child = spawnFixture(["tui"]);
    const exitPromise = once(child, "exit");
    const text = collectProcessText(child);
    const screen = new ScreenModel(80, 24);
    let screenWrites = Promise.resolve();
    child.stdout.on("data", (chunk: string) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForSubstring(() => text.stdout, "021 DAR_TUI_READY");
      await screenWrites;
      await waitForScreen(
        () => screen.contents(),
        "021 DAR_TUI_READY\nevent=ready\nsize=80x24"
      );

      const steps: Array<[string, string]> = [
        ["a", "022 DAR_TUI_TEXT a"],
        ["Z", "023 DAR_TUI_TEXT Z"],
        [" ", "024 DAR_TUI_TEXT space"],
        [namedKey("ArrowUp"), "025 DAR_TUI_KEY ArrowUp"],
        [namedKey("ArrowLeft"), "026 DAR_TUI_KEY ArrowLeft"],
        [namedKey("Enter"), "027 DAR_TUI_KEY Enter"],
        [namedKey("Home"), "028 DAR_TUI_KEY Home"],
        [controlChord("c"), "029 DAR_TUI_CONTROL Ctrl+C"],
        [controlChord("q"), "030 DAR_TUI_CONTROL Ctrl+Q"],
        [sgrMouse({ kind: "press", button: 0, col: 1, row: 1 }), "031 DAR_TUI_MOUSE_PRESS Left 1 1"],
        [
          sgrMouse({ kind: "release", button: 0, col: 1, row: 1 }),
          "032 DAR_TUI_MOUSE_RELEASE Left 1 1",
        ],
        [sgrMouse({ kind: "wheel-up", col: 2, row: 3 }), "033 DAR_TUI_MOUSE_WHEEL_UP 2 3"],
        [sgrMouse({ kind: "wheel-down", col: 2, row: 3 }), "034 DAR_TUI_MOUSE_WHEEL_DOWN 2 3"],
        [sgrMouse({ kind: "move", button: 0, col: 4, row: 5 }), "035 DAR_TUI_MOUSE_MOVE Left 4 5"],
        [namedKey("Backspace"), "036 DAR_TUI_KEY Backspace"],
        ["\x1b[8;30;100t", "037 DAR_TUI_RESIZE 100 30"],
        ["✓", "038 DAR_TUI_TEXT ✓"],
        [namedKey("Delete"), "039 DAR_TUI_KEY Delete"],
      ];

      for (const [input, expected] of steps) {
        await writeChunks(child.stdin, [input]);
        await waitForSubstring(() => text.stdout, expected);
      }

      await screenWrites;
      await waitForScreen(
        () => screen.contents(),
        "039 DAR_TUI_KEY Delete\nevent=key:Delete\nsize=100x30"
      );

      await writeChunks(child.stdin, ["q"]);
      child.stdin.end();
      await waitForSubstring(() => text.stdout, "040 DAR_TUI_EXIT");

      await expect(exitPromise).resolves.toEqual([0, null]);
      expect(markerList(text.stdout)).toEqual([
        "021 DAR_TUI_READY",
        "022 DAR_TUI_TEXT a",
        "023 DAR_TUI_TEXT Z",
        "024 DAR_TUI_TEXT space",
        "025 DAR_TUI_KEY ArrowUp",
        "026 DAR_TUI_KEY ArrowLeft",
        "027 DAR_TUI_KEY Enter",
        "028 DAR_TUI_KEY Home",
        "029 DAR_TUI_CONTROL Ctrl+C",
        "030 DAR_TUI_CONTROL Ctrl+Q",
        "031 DAR_TUI_MOUSE_PRESS Left 1 1",
        "032 DAR_TUI_MOUSE_RELEASE Left 1 1",
        "033 DAR_TUI_MOUSE_WHEEL_UP 2 3",
        "034 DAR_TUI_MOUSE_WHEEL_DOWN 2 3",
        "035 DAR_TUI_MOUSE_MOVE Left 4 5",
        "036 DAR_TUI_KEY Backspace",
        "037 DAR_TUI_RESIZE 100 30",
        "038 DAR_TUI_TEXT ✓",
        "039 DAR_TUI_KEY Delete",
        "040 DAR_TUI_EXIT",
      ]);
    } finally {
      screen.dispose();
    }
  });
});

describe("climon-harness-fixture command dispatch", () => {
  test("rejects an unknown subcommand with stable stderr and exit 2", async () => {
    await buildFixture();
    const child = spawnFixture(["bogus"]);
    const exitPromise = once(child, "exit");
    const text = collectProcessText(child);

    const [code, signal] = await exitPromise;
    expect(code).toBe(2);
    expect(signal).toBeNull();
    expect(text.stdout).toBe("");
    expect(text.stderr).toBe("Unknown command: bogus\n");
  });
});
