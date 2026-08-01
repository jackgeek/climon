import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
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
const FIXTURE_TEST_TIMEOUT_MS = 120_000;
const LIVE_TUI_DISCONNECT_TIMEOUT_MS = 1_500;
const REAL_PTY_TEST_TIMEOUT_MS = 30_000;
const NODE_PATH = Bun.which("node");
const PYTHON3_PATH = Bun.which("python3");
const NODE_LIVE_TUI_DRIVER_SCRIPT = String.raw`
import nodePty from "node-pty";
import headless from "@xterm/headless";

const { spawn } = nodePty;
const { Terminal } = headless;

const fixturePath = process.argv[1];
const textInput = process.argv[2];
const timeoutMs = Number(process.argv[3]);
const terminal = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
let writeQueue = Promise.resolve();
let raw = "";
let exitCode = null;
let exitSignal = null;

function contents() {
  const active = terminal.buffer.active;
  const lines = [];
  const start =
    active.type === "alternate" ? 0 : Math.min(active.viewportY, active.baseY);
  const end = start + terminal.rows;

  for (let index = start; index < end; index += 1) {
    const line = active.getLine(index);
    if (!line) {
      lines.push("");
      continue;
    }

    let lastOccupied = -1;
    for (let column = terminal.cols - 1; column >= 0; column -= 1) {
      const cell = line.getCell(column);
      if (cell?.getChars() !== "") {
        lastOccupied = column;
        break;
      }
    }

    lines.push(
      lastOccupied >= 0 ? line.translateToString(false, 0, lastOccupied + 1) : ""
    );
  }

  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }

  return lines.join("\n");
}

function cursor() {
  const active = terminal.buffer.active;
  return { col: active.cursorX, row: active.cursorY };
}

async function waitFor(label, predicate) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await writeQueue;
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(
    "Timed out waiting for " +
      label +
      "; rawTail=" +
      JSON.stringify(raw.slice(-4000)) +
      "; screen=" +
      JSON.stringify(contents()) +
      "; cursor=" +
      JSON.stringify(cursor())
  );
}

async function main() {
  const child = spawn(fixturePath, ["interactive-tui"], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  const exitPromise = new Promise((resolve) => {
    child.onExit((event) => {
      exitCode = event.exitCode;
      exitSignal = event.signal ?? null;
      resolve();
    });
  });
  child.onData((data) => {
    raw += data;
    writeQueue = writeQueue.then(
      () =>
        new Promise((resolve) => {
          terminal.write(data, resolve);
        })
    );
  });

  let markerOffset = 0;
  const waitForMarker = async (marker) => {
    await waitFor("marker " + marker, () => {
      const index = raw.indexOf(marker, markerOffset);
      if (index < 0) {
        return false;
      }
      markerOffset = index + marker.length;
      return true;
    });
  };

  try {
    await waitForMarker("021 DAR_TUI_READY");
    await waitFor("initial frame", () => {
      const currentCursor = cursor();
      return (
        contents() === "DAR_TUI_READY\nsize=100x30\nlast=ready" &&
        currentCursor.col === 0 &&
        currentCursor.row === 3
      );
    });

    child.write(textInput);
    for (const character of textInput) {
      await waitForMarker("DAR_TUI_TEXT " + character);
    }

    child.write("\x1b[<64;10;6M");
    await waitForMarker("DAR_TUI_MOUSE_WHEEL_UP 10 6");
    await waitFor("mouse frame", () => {
      const currentCursor = cursor();
      return (
        contents() === "DAR_TUI_READY\nsize=100x30\nlast=mouse:wheel-up:10:6" &&
        currentCursor.col === 0 &&
        currentCursor.row === 3
      );
    });

    child.resize(120, 40);
    await waitForMarker("DAR_TUI_RESIZE 120 40");
    await waitFor("resize frame", () => {
      const currentCursor = cursor();
      return (
        contents() === "DAR_TUI_READY\nsize=120x40\nlast=resize:120x40" &&
        currentCursor.col === 0 &&
        currentCursor.row === 3
      );
    });

    child.kill();
    await exitPromise;

    console.log(
      JSON.stringify({
        childExited: true,
        exitCode,
        exitSignal,
        finalCursor: cursor(),
        finalScreen: contents(),
        rawTail: raw.slice(-4000),
      })
    );
  } catch (error) {
    child.kill();
    await exitPromise;
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
`;
const PYTHON_LIVE_TUI_DISCONNECT_SCRIPT = String.raw`
import json
import os
import pty
import select
import subprocess
import sys
import time

fixture_path = sys.argv[1]
disconnect_timeout = float(sys.argv[2]) / 1000.0
master_fd, slave_fd = pty.openpty()
child = subprocess.Popen(
    [fixture_path, "interactive-tui"],
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=subprocess.PIPE,
    close_fds=True,
)
os.close(slave_fd)
os.set_blocking(master_fd, False)
output = bytearray()
ready = False
timed_out = False
exit_code = None
start = time.monotonic()
try:
    ready_deadline = start + 5.0
    while time.monotonic() < ready_deadline:
        readable, _, _ = select.select([master_fd], [], [], 0.1)
        if master_fd not in readable:
            continue
        try:
            chunk = os.read(master_fd, 4096)
        except BlockingIOError:
            continue
        if not chunk:
            break
        output.extend(chunk)
        if b"021 DAR_TUI_READY" in output:
            ready = True
            break
    if ready:
        os.close(master_fd)
        master_fd = None
        try:
            exit_code = child.wait(timeout=disconnect_timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            child.kill()
            exit_code = child.wait(timeout=disconnect_timeout)
finally:
    if master_fd is not None:
        try:
            os.close(master_fd)
        except OSError:
            pass
stderr_text = child.stderr.read().decode("utf-8", "replace")
duration_ms = int((time.monotonic() - start) * 1000)
print(json.dumps({
    "durationMs": duration_ms,
    "exitCode": exit_code,
    "ready": ready,
    "stderr": stderr_text,
    "stdoutTail": output[-200:].decode("utf-8", "replace"),
    "timedOut": timed_out,
}))
sys.exit(0 if ready and not timed_out else 1)
`;
const PYTHON_LIVE_TUI_RESIZE_SCRIPT = String.raw`
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time

fixture_path = sys.argv[1]
master_fd, slave_fd = pty.openpty()
child = subprocess.Popen(
    [fixture_path, "interactive-tui"],
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=subprocess.PIPE,
    close_fds=True,
)
os.close(slave_fd)
os.set_blocking(master_fd, False)
output = bytearray()
ready = False
resized = False
try:
    ready_deadline = time.monotonic() + 5.0
    while time.monotonic() < ready_deadline:
        readable, _, _ = select.select([master_fd], [], [], 0.1)
        if master_fd not in readable:
            continue
        try:
            chunk = os.read(master_fd, 4096)
        except BlockingIOError:
            continue
        if not chunk:
            break
        output.extend(chunk)
        if b"021 DAR_TUI_READY" in output:
            ready = True
            break
    if ready:
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        resize_deadline = time.monotonic() + 1.5
        while time.monotonic() < resize_deadline:
            readable, _, _ = select.select([master_fd], [], [], 0.1)
            if master_fd not in readable:
                continue
            try:
                chunk = os.read(master_fd, 4096)
            except BlockingIOError:
                continue
            if not chunk:
                break
            output.extend(chunk)
            if b"DAR_TUI_RESIZE 100 30" in output:
                resized = True
                break
finally:
    child.kill()
    child.wait(timeout=1.5)
    os.close(master_fd)
stderr_text = child.stderr.read().decode("utf-8", "replace")
print(json.dumps({
    "ready": ready,
    "resized": resized,
    "stderr": stderr_text,
    "stdoutTail": output[-400:].decode("utf-8", "replace"),
}))
sys.exit(0 if ready and resized else 1)
`;
const PYTHON_LIVE_TUI_BATCH_INPUT_SCRIPT = String.raw`
import json
import os
import pty
import select
import subprocess
import sys
import time

fixture_path = sys.argv[1]
master_fd, slave_fd = pty.openpty()
child = subprocess.Popen(
    [fixture_path, "interactive-tui"],
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=subprocess.PIPE,
    close_fds=True,
)
os.close(slave_fd)
os.set_blocking(master_fd, False)
output = bytearray()
ready = False
exited = False
try:
    ready_deadline = time.monotonic() + 5.0
    while time.monotonic() < ready_deadline:
        readable, _, _ = select.select([master_fd], [], [], 0.1)
        if master_fd not in readable:
            continue
        try:
            chunk = os.read(master_fd, 4096)
        except BlockingIOError:
            continue
        if not chunk:
            break
        output.extend(chunk)
        if b"021 DAR_TUI_READY" in output:
            ready = True
            break
    if ready:
        os.write(master_fd, b"abq")
        exit_deadline = time.monotonic() + 1.5
        while time.monotonic() < exit_deadline:
            readable, _, _ = select.select([master_fd], [], [], 0.1)
            if master_fd not in readable:
                continue
            try:
                chunk = os.read(master_fd, 4096)
            except BlockingIOError:
                continue
            if not chunk:
                break
            output.extend(chunk)
            if b"040 DAR_TUI_EXIT" in output:
                exited = True
                break
finally:
    if child.poll() is None:
        child.kill()
    child.wait(timeout=1.5)
    os.close(master_fd)
stderr_text = child.stderr.read().decode("utf-8", "replace")
print(json.dumps({
    "exited": exited,
    "ready": ready,
    "stderr": stderr_text,
    "stdoutTail": output[-400:].decode("utf-8", "replace"),
}))
sys.exit(0 if ready and exited else 1)
`;
const NODE_CONTROL_PROBE_DRIVER_SCRIPT = String.raw`
import nodePty from "node-pty";
import headless from "@xterm/headless";

const { spawn } = nodePty;
const { Terminal } = headless;

const fixturePath = process.argv[1];
const mode = process.argv[2];
const timeoutMs = Number(process.argv[3]);
const terminal = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
let writeQueue = Promise.resolve();
let raw = "";
let exitCode = null;
let exitSignal = null;

function contents() {
  const active = terminal.buffer.active;
  const lines = [];
  const start =
    active.type === "alternate" ? 0 : Math.min(active.viewportY, active.baseY);
  const end = start + terminal.rows;

  for (let index = start; index < end; index += 1) {
    const line = active.getLine(index);
    if (!line) {
      lines.push("");
      continue;
    }

    let lastOccupied = -1;
    for (let column = terminal.cols - 1; column >= 0; column -= 1) {
      const cell = line.getCell(column);
      if (cell?.getChars() !== "") {
        lastOccupied = column;
        break;
      }
    }

    lines.push(
      lastOccupied >= 0 ? line.translateToString(false, 0, lastOccupied + 1) : ""
    );
  }

  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }

  return lines.join("\n");
}

async function waitFor(label, predicate) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await writeQueue;
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(
    "Timed out waiting for " +
      label +
      "; rawTail=" +
      JSON.stringify(raw.slice(-4000)) +
      "; screen=" +
      JSON.stringify(contents())
  );
}

async function main() {
  const child = spawn(fixturePath, ["control-probe"], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  const exitPromise = new Promise((resolve) => {
    child.onExit((event) => {
      exitCode = event.exitCode;
      exitSignal = event.signal ?? null;
      resolve();
    });
  });
  child.onData((data) => {
    raw += data;
    writeQueue = writeQueue.then(
      () =>
        new Promise((resolve) => {
          terminal.write(data, resolve);
        })
    );
  });

  let markerOffset = 0;
  const waitForMarker = async (marker) => {
    await waitFor("marker " + marker, () => {
      const index = raw.indexOf(marker, markerOffset);
      if (index < 0) {
        return false;
      }
      markerOffset = index + marker.length;
      return true;
    });
  };

  try {
    await waitForMarker("DAR_CONTROL_READY 100 30");
    await waitFor("initial frame", () =>
      contents() === "DAR_CONTROL_READY\nsize=100x30\nprevious=none\nlast=ready\nresizes=0"
    );

    child.write("surface-alpha\r");
    await waitForMarker("DAR_CONTROL_INPUT surface-alpha");
    await waitFor("input frame", () =>
      contents() ===
      "DAR_CONTROL_READY\nsize=100x30\nprevious=none\nlast=surface-alpha\nresizes=0"
    );

    if (mode === "resize" || mode === "resize-exit" || mode === "jiggle") {
      child.resize(120, 40);
      await waitForMarker("DAR_CONTROL_RESIZE 1 120 40");
      await waitFor("resize frame", () =>
        contents() ===
        "DAR_CONTROL_READY\nsize=120x40\nprevious=100x30\nlast=surface-alpha\nresizes=1"
      );
    }

    if (mode === "jiggle") {
      child.resize(119, 39);
      await waitForMarker("DAR_CONTROL_RESIZE 2 119 39");
      child.resize(120, 40);
      await waitForMarker("DAR_CONTROL_RESIZE 3 120 40");
      await waitFor("jiggle frame", () =>
        contents() ===
        "DAR_CONTROL_READY\nsize=120x40\nprevious=119x39\nlast=surface-alpha\nresizes=3"
      );
    }

    if (mode === "resize" || mode === "jiggle") {
      child.kill();
    } else {
      child.write("q");
      await waitFor("alternate-screen restore", () => {
        const leaveAlternateIndex = raw.indexOf("\u001b[?1049l", markerOffset);
        return leaveAlternateIndex >= 0 && contents() === "";
      });
    }
    await exitPromise;
    await writeQueue;

    console.log(
      JSON.stringify({
        exitCode,
        exitSignal,
        finalScreen: contents(),
        rawTail: raw.slice(-4000),
      })
    );
  } catch (error) {
    child.kill();
    await exitPromise;
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
`;

function futureDeadline(): number {
  return Date.now() + 10_000;
}

function createFixtureBuilder(build: () => Promise<string>): () => Promise<string> {
  let buildPromise: Promise<string> | undefined;
  return () => {
    if (buildPromise) {
      return buildPromise;
    }

    let nextBuildPromise: Promise<string>;
    try {
      nextBuildPromise = build();
    } catch (error) {
      return Promise.reject(error);
    }

    const currentBuildPromise = nextBuildPromise.catch((error) => {
      if (buildPromise === currentBuildPromise) {
        buildPromise = undefined;
      }
      throw error;
    });
    buildPromise = currentBuildPromise;
    return currentBuildPromise;
  };
}

const buildFixture = createFixtureBuilder(
  () =>
    new Promise<string>((resolvePath, reject) => {
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
    })
);

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

function collectProcessText(child: { stdout: Readable; stderr: Readable }) {
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

describe("fixture build memoization", () => {
  test("retries after a rejected build and memoizes the first successful retry", async () => {
    let attempts = 0;
    let resolveRetry!: (path: string) => void;
    const retryResult = new Promise<string>((resolve) => {
      resolveRetry = resolve;
    });
    const build = createFixtureBuilder(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("first build failed");
      }
      return retryResult;
    });

    await expect(build()).rejects.toThrow("first build failed");

    const retriedBuild = build();
    const concurrentRetry = build();
    expect(attempts).toBe(2);

    resolveRetry("/fixture/path");

    await expect(retriedBuild).resolves.toBe("/fixture/path");
    await expect(concurrentRetry).resolves.toBe("/fixture/path");
    await expect(build()).resolves.toBe("/fixture/path");
    expect(attempts).toBe(2);
  });
});

describe("climon-harness-fixture stream protocol", () => {
  test("streams the approved replay/ready/live/exit handshake in exact order with no echoed control lines", async () => {
    await buildFixture();
    const child = spawnFixture(["streaming"]);
    const exitPromise = once(child, "exit");
    const text = collectProcessText(child);

    const replayMarkers = Array.from({ length: 20 }, (_, index) => {
      const phase = String(index + 1).padStart(3, "0");
      return `DAR_STREAM_REPLAY ${phase}`;
    });
    const readyMarker = "DAR_STREAM_READY";
    const liveMarkers = Array.from({ length: 20 }, (_, index) => {
      const phase = String(index + 21).padStart(3, "0");
      return `DAR_STREAM_LIVE ${phase}`;
    });
    const continueLine = "CONTINUE continue-token";
    const exitLine = "EXIT 7";
    const exitMarker = "DAR_STREAM_EXIT 7";

    for (const marker of replayMarkers) {
      await waitForLine(text.stdoutLines, marker);
    }
    await waitForLine(text.stdoutLines, readyMarker);
    expect(text.stdoutLines).toEqual([...replayMarkers, readyMarker]);

    await writeChunks(child.stdin, [`${continueLine}\n`]);
    for (const marker of liveMarkers) {
      await waitForLine(text.stdoutLines, marker);
    }
    expect(text.stdoutLines).toEqual([...replayMarkers, readyMarker, ...liveMarkers]);

    await writeChunks(child.stdin, [`${exitLine}\n`]);
    await waitForLine(text.stdoutLines, exitMarker);

    const [code, signal] = await exitPromise;
    expect(code).toBe(7);
    expect(signal).toBeNull();
    expect(text.stderr).toBe("");
    expect(text.stdoutLines).toEqual([
      ...replayMarkers,
      readyMarker,
      ...liveMarkers,
      exitMarker,
    ]);
    expect(text.stdoutLines).not.toContain(continueLine);
    expect(text.stdoutLines).not.toContain(exitLine);
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("rejects malformed CONTINUE handshake with stable stderr and exit 2", async () => {
    await buildFixture();
    const child = spawnFixture(["streaming"]);
    const exitPromise = once(child, "exit");
    const text = collectProcessText(child);
    const replayMarkers = Array.from({ length: 20 }, (_, index) => {
      const phase = String(index + 1).padStart(3, "0");
      return `DAR_STREAM_REPLAY ${phase}`;
    });
    const readyMarker = "DAR_STREAM_READY";

    await waitForLine(text.stdoutLines, readyMarker);
    await writeChunks(child.stdin, ["CONTINUE\n"]);

    const [code, signal] = await exitPromise;
    expect(code).toBe(2);
    expect(signal).toBeNull();
    expect(text.stdoutLines).toEqual([...replayMarkers, readyMarker]);
    expect(text.stderr).toBe("Malformed stream input: CONTINUE\n");
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("rejects EOF before the CONTINUE handshake with stable stderr and exit 2", async () => {
    await buildFixture();
    const child = spawnFixture(["streaming"]);
    const exitPromise = once(child, "exit");
    const text = collectProcessText(child);
    const replayMarkers = Array.from({ length: 20 }, (_, index) => {
      const phase = String(index + 1).padStart(3, "0");
      return `DAR_STREAM_REPLAY ${phase}`;
    });
    const readyMarker = "DAR_STREAM_READY";

    await waitForLine(text.stdoutLines, readyMarker);
    child.stdin.end();

    const [code, signal] = await exitPromise;
    expect(code).toBe(2);
    expect(signal).toBeNull();
    expect(text.stdoutLines).toEqual([...replayMarkers, readyMarker]);
    expect(text.stderr).toBe("Malformed stream input: expected CONTINUE <token>\n");
  }, FIXTURE_TEST_TIMEOUT_MS);
});

describe("climon-harness-fixture terminal modes and TUI", () => {
  test("emits DAR_MODE_BASELINE then DAR_MODE_RESULT lines and returns the child exit code", async () => {
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
    expect(text.stdoutLines[1]?.startsWith("DAR_MODE_RESULT ")).toBe(true);

    const baseline = JSON.parse(text.stdoutLines[0]!.slice("DAR_MODE_BASELINE ".length)) as {
      command: string[];
      platform: string;
    };
    const result = JSON.parse(text.stdoutLines[1]!.slice("DAR_MODE_RESULT ".length)) as {
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
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("renders exact 021..040 markers for TUI input and exits only on plain q", async () => {
    await buildFixture();
    const child = spawnFixture(["interactive-tui"]);
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
        "DAR_TUI_READY\nsize=80x24\nlast=ready"
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
        "DAR_TUI_READY\nsize=100x30\nlast=key:Delete"
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
  }, FIXTURE_TEST_TIMEOUT_MS);

  test.skipIf(!NODE_PATH)(
    "streams per-character markers and preserves the approved stable frame through node-pty",
    async () => {
      await buildFixture();
      const textInput = `dar01-é-${randomUUID()}`;
      const child = spawn(NODE_PATH!, [
        "--input-type=module",
        "-e",
        NODE_LIVE_TUI_DRIVER_SCRIPT,
        FIXTURE_PATH,
        textInput,
        String(REAL_PTY_TEST_TIMEOUT_MS),
      ], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      const exitPromise = once(child, "exit");
      const text = collectProcessText(child);

      const [code, signal] = await exitPromise;
      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(text.stderr).toBe("");

      const result = JSON.parse(text.stdout.trim()) as {
        childExited: boolean;
        exitCode: number | null;
        exitSignal: number | null;
        finalCursor: { col: number; row: number };
        finalScreen: string;
        rawTail: string;
      };

      expect(result.childExited).toBe(true);
      expect(result.finalCursor).toEqual({ col: 0, row: 3 });
      expect(result.finalScreen).toBe("DAR_TUI_READY\nsize=120x40\nlast=resize:120x40");
      expect(result.rawTail).toContain("021 DAR_TUI_READY");
      for (const character of textInput) {
        expect(result.rawTail).toContain(`DAR_TUI_TEXT ${character}`);
      }
      expect(result.rawTail).toContain("DAR_TUI_MOUSE_WHEEL_UP 10 6");
      expect(result.rawTail).toContain("DAR_TUI_RESIZE 120 40");
    },
    REAL_PTY_TEST_TIMEOUT_MS
  );

  test.skipIf(process.platform === "win32" || !PYTHON3_PATH)(
    "drains multiple live events buffered in a single PTY write",
    async () => {
      await buildFixture();
      const child = spawn(PYTHON3_PATH!, [
        "-c",
        PYTHON_LIVE_TUI_BATCH_INPUT_SCRIPT,
        FIXTURE_PATH,
      ], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      const exitPromise = once(child, "exit");
      const text = collectProcessText(child);

      const [code, signal] = await exitPromise;
      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(text.stderr).toBe("");

      const result = JSON.parse(text.stdout.trim()) as {
        exited: boolean;
        ready: boolean;
        stderr: string;
        stdoutTail: string;
      };

      expect(result.ready).toBe(true);
      expect(result.exited).toBe(true);
      expect(result.stderr).toBe("");
      expect(result.stdoutTail).toContain("022 DAR_TUI_TEXT a");
      expect(result.stdoutTail).toContain("023 DAR_TUI_TEXT b");
      expect(result.stdoutTail).toContain("040 DAR_TUI_EXIT");
    },
    FIXTURE_TEST_TIMEOUT_MS
  );

  test.skipIf(process.platform === "win32" || !PYTHON3_PATH)(
    "emits a live resize marker after the PTY size changes",
    async () => {
      await buildFixture();
      const child = spawn(PYTHON3_PATH!, [
        "-c",
        PYTHON_LIVE_TUI_RESIZE_SCRIPT,
        FIXTURE_PATH,
      ], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      const exitPromise = once(child, "exit");
      const text = collectProcessText(child);

      const [code, signal] = await exitPromise;
      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(text.stderr).toBe("");

      const result = JSON.parse(text.stdout.trim()) as {
        ready: boolean;
        resized: boolean;
        stderr: string;
        stdoutTail: string;
      };

      expect(result.ready).toBe(true);
      expect(result.resized).toBe(true);
      expect(result.stderr).toBe("");
      expect(result.stdoutTail).toContain("DAR_TUI_RESIZE 100 30");
    },
    FIXTURE_TEST_TIMEOUT_MS
  );

  test.skipIf(process.platform === "win32" || !PYTHON3_PATH)(
    "exits promptly when a live TUI stdin PTY disconnects",
    async () => {
      await buildFixture();
      const child = spawn(PYTHON3_PATH!, [
        "-c",
        PYTHON_LIVE_TUI_DISCONNECT_SCRIPT,
        FIXTURE_PATH,
        String(LIVE_TUI_DISCONNECT_TIMEOUT_MS),
      ], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      const exitPromise = once(child, "exit");
      const text = collectProcessText(child);

      const [code, signal] = await exitPromise;
      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(text.stderr).toBe("");

      const result = JSON.parse(text.stdout.trim()) as {
        durationMs: number;
        exitCode: number | null;
        ready: boolean;
        stderr: string;
        stdoutTail: string;
        timedOut: boolean;
      };

      expect(result.ready).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeLessThanOrEqual(LIVE_TUI_DISCONNECT_TIMEOUT_MS + 500);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdoutTail).toContain("021 DAR_TUI_READY");
    },
    FIXTURE_TEST_TIMEOUT_MS
  );
});

describe("climon-harness-fixture DAR control, metadata, and lifecycle protocols", () => {
  test("drives control-probe through scripted input, resize markers, and q exit", async () => {
    await buildFixture();
    const child = spawnFixture(["control-probe"]);
    const exitPromise = once(child, "exit");
    const text = collectProcessText(child);
    const screen = new ScreenModel(80, 24);
    let screenWrites = Promise.resolve();
    child.stdout.on("data", (chunk: string) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForSubstring(() => text.stdout, "DAR_CONTROL_READY 80 24");
      await screenWrites;
      await waitForScreen(
        () => screen.contents(),
        "DAR_CONTROL_READY\nsize=80x24\nprevious=none\nlast=ready\nresizes=0"
      );

      await writeChunks(child.stdin, ["surface-alpha\r"]);
      await waitForSubstring(() => text.stdout, "DAR_CONTROL_INPUT surface-alpha");
      await screenWrites;
      await waitForScreen(
        () => screen.contents(),
        "DAR_CONTROL_READY\nsize=80x24\nprevious=none\nlast=surface-alpha\nresizes=0"
      );

      await writeChunks(child.stdin, ["\x1b[8;30;100t"]);
      await waitForSubstring(() => text.stdout, "DAR_CONTROL_RESIZE 1 100 30");
      await screenWrites;
      await waitForScreen(
        () => screen.contents(),
        "DAR_CONTROL_READY\nsize=100x30\nprevious=80x24\nlast=surface-alpha\nresizes=1"
      );

      await writeChunks(child.stdin, ["browser-token\r", "q"]);
      await waitForSubstring(() => text.stdout, "DAR_CONTROL_INPUT browser-token");
      await expect(exitPromise).resolves.toEqual([0, null]);
      expect(text.stderr).toBe("");
      await screenWrites;
      expect(screen.contents()).toBe(
        "DAR_CONTROL_READY\nsize=100x30\nprevious=80x24\nlast=browser-token\nresizes=1"
      );
      expect(text.stdout).toContain("DAR_CONTROL_READY 80 24");
      expect(text.stdout).toContain("DAR_CONTROL_INPUT surface-alpha");
      expect(text.stdout).toContain("DAR_CONTROL_RESIZE 1 100 30");
      expect(text.stdout).toContain("DAR_CONTROL_INPUT browser-token");
    } finally {
      screen.dispose();
    }
  }, FIXTURE_TEST_TIMEOUT_MS);

  test.skipIf(!NODE_PATH)(
    "streams alternate-screen control-probe frames and live resize markers through node-pty",
    async () => {
      await buildFixture();
      const child = spawn(NODE_PATH!, [
        "--input-type=module",
        "-e",
        NODE_CONTROL_PROBE_DRIVER_SCRIPT,
        FIXTURE_PATH,
        "resize",
        String(REAL_PTY_TEST_TIMEOUT_MS),
      ], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      const exitPromise = once(child, "exit");
      const text = collectProcessText(child);

      const [code] = await exitPromise;
      expect(code).toBe(0);
      expect(text.stderr).toBe("");

      const result = JSON.parse(text.stdout.trim()) as {
        exitCode: number | null;
        exitSignal: number | null;
        finalScreen: string;
        rawTail: string;
      };

      expect(result.exitCode === null || result.exitCode !== 0 || result.exitSignal !== null).toBe(
        true
      );
      expect(result.finalScreen).toBe(
        "DAR_CONTROL_READY\nsize=120x40\nprevious=100x30\nlast=surface-alpha\nresizes=1"
      );
      expect(result.rawTail).toContain("\u001b[?1049h");
      expect(result.rawTail).toContain("DAR_CONTROL_READY 100 30");
      expect(result.rawTail).toContain("DAR_CONTROL_INPUT surface-alpha");
      expect(result.rawTail).toContain("DAR_CONTROL_RESIZE 1 120 40");
    },
    REAL_PTY_TEST_TIMEOUT_MS
  );

  test.skipIf(!NODE_PATH)(
    "resizes then restores control-probe alternate-screen state on q through node-pty",
    async () => {
      await buildFixture();
      const child = spawn(NODE_PATH!, [
        "--input-type=module",
        "-e",
        NODE_CONTROL_PROBE_DRIVER_SCRIPT,
        FIXTURE_PATH,
        "resize-exit",
        String(REAL_PTY_TEST_TIMEOUT_MS),
      ], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      const exitPromise = once(child, "exit");
      const text = collectProcessText(child);

      const [code, signal] = await exitPromise;
      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(text.stderr).toBe("");

      const result = JSON.parse(text.stdout.trim()) as {
        exitCode: number | null;
        exitSignal: number | null;
        finalScreen: string;
        rawTail: string;
      };

      expect(result.exitCode).toBe(0);
      expect(result.exitSignal === null || result.exitSignal === 0).toBe(true);
      expect(result.finalScreen).toBe("");
      expect(result.rawTail).toContain("\u001b[?1049h");
      expect(result.rawTail).toContain("DAR_CONTROL_RESIZE 1 120 40");
      expect(result.rawTail).toContain("\u001b[?1049l");
      expect(result.rawTail).toContain("DAR_CONTROL_INPUT surface-alpha");
      expect(result.rawTail.indexOf("\u001b[?1049l")).toBeGreaterThan(
        result.rawTail.indexOf("DAR_CONTROL_RESIZE 1 120 40")
      );
    },
    REAL_PTY_TEST_TIMEOUT_MS
  );

  test.skipIf(!NODE_PATH)(
    "retains the immediately previous resize target in the durable frame through node-pty",
    async () => {
      await buildFixture();
      const child = spawn(NODE_PATH!, [
        "--input-type=module",
        "-e",
        NODE_CONTROL_PROBE_DRIVER_SCRIPT,
        FIXTURE_PATH,
        "jiggle",
        String(REAL_PTY_TEST_TIMEOUT_MS),
      ], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      const exitPromise = once(child, "exit");
      const text = collectProcessText(child);

      const [code] = await exitPromise;
      expect(code).toBe(0);
      expect(text.stderr).toBe("");

      const result = JSON.parse(text.stdout.trim()) as {
        exitCode: number | null;
        exitSignal: number | null;
        finalScreen: string;
        rawTail: string;
      };

      expect(result.finalScreen).toBe(
        "DAR_CONTROL_READY\nsize=120x40\nprevious=119x39\nlast=surface-alpha\nresizes=3"
      );
      expect(result.rawTail).toContain("DAR_CONTROL_RESIZE 2 119 39");
      expect(result.rawTail).toContain("DAR_CONTROL_RESIZE 3 120 40");
    },
    REAL_PTY_TEST_TIMEOUT_MS
  );

  test("emits metadata markers and raw OSC passthrough in command order", async () => {
    await buildFixture();
    const child = spawnFixture(["metadata-probe"]);
    const exitPromise = once(child, "exit");
    const text = collectProcessText(child);

    await waitForLine(text.stdoutLines, "DAR_METADATA_STATIC");
    await writeChunks(child.stdin, [
      "STATIC\n",
      "CHANGE token-alpha\n",
      "TITLE0 title-zero\n",
      "TITLE2 title-two\n",
      "PROGRESS 1 42\n",
      "PROGRESS 3 0\n",
      "CLEAR_PROGRESS\n",
      "EXIT\n",
    ]);

    const [code, signal] = await exitPromise;
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(text.stderr).toBe("");
    expect(text.stdout).toBe(
      [
        "DAR_METADATA_STATIC\n",
        "DAR_METADATA_STATIC\n",
        "DAR_METADATA_BODY_CHANGED token-alpha\n",
        "\u001b]0;title-zero\u0007DAR_METADATA_OSC_EMITTED TITLE0\n",
        "\u001b]2;title-two\u0007DAR_METADATA_OSC_EMITTED TITLE2\n",
        "\u001b]9;4;1;42\u0007DAR_METADATA_OSC_EMITTED PROGRESS 1 42\n",
        "\u001b]9;4;3;0\u0007DAR_METADATA_OSC_EMITTED PROGRESS 3 0\n",
        "\u001b]9;4;0;0\u0007DAR_METADATA_OSC_EMITTED CLEAR_PROGRESS\n",
      ].join("")
    );
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("runs lifecycle fast-success, failed-exit, and engine-echo commands", async () => {
    await buildFixture();

    for (const [args, expectedExit, expectedStdout] of [
      [["lifecycle-probe", "fast-success"], 0, "DAR_LIFECYCLE_EARLY success\n"],
      [["lifecycle-probe", "failed-exit"], 7, "DAR_LIFECYCLE_EARLY failure\n"],
      [["lifecycle-probe", "engine-echo"], 0, "DAR_ENGINE_ECHO\n"],
    ] as const) {
      const child = spawnFixture([...args]);
      const exitPromise = once(child, "exit");
      const text = collectProcessText(child);

      const [code, signal] = await exitPromise;
      expect(code).toBe(expectedExit);
      expect(signal).toBeNull();
      expect(text.stdout).toBe(expectedStdout);
      expect(text.stderr).toBe("");
    }
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("gates lifecycle flood output on a matching CONTINUE token", async () => {
    await buildFixture();
    const child = spawnFixture(["lifecycle-probe", "flood", "6", "gate-token"]);
    const exitPromise = once(child, "exit");
    const text = collectProcessText(child);

    await waitForLine(text.stdoutLines, "DAR_LIFECYCLE_FLOOD 000003");
    await Bun.sleep(150);
    expect(text.stdoutLines).toEqual([
      "DAR_LIFECYCLE_FLOOD 000001",
      "DAR_LIFECYCLE_FLOOD 000002",
      "DAR_LIFECYCLE_FLOOD 000003",
    ]);

    await writeChunks(child.stdin, ["CONTINUE gate-token\n"]);

    const [code, signal] = await exitPromise;
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(text.stderr).toBe("");
    expect(text.stdoutLines).toEqual([
      "DAR_LIFECYCLE_FLOOD 000001",
      "DAR_LIFECYCLE_FLOOD 000002",
      "DAR_LIFECYCLE_FLOOD 000003",
      "DAR_LIFECYCLE_FLOOD 000004",
      "DAR_LIFECYCLE_FLOOD 000005",
      "DAR_LIFECYCLE_FLOOD 000006",
    ]);
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("holds for signals after printing lifecycle readiness", async () => {
    await buildFixture();
    const child = spawnFixture(["lifecycle-probe", "signal-hold"]);
    const exitPromise = once(child, "exit");
    const text = collectProcessText(child);

    await waitForLine(text.stdoutLines, "DAR_LIFECYCLE_HOLD_READY");
    child.kill("SIGTERM");

    const [code, signal] = await exitPromise;
    expect(text.stdout).toBe("DAR_LIFECYCLE_HOLD_READY\n");
    expect(text.stderr).toBe("");
    expect(code === null || code !== 0 || signal !== null).toBe(true);
  }, FIXTURE_TEST_TIMEOUT_MS);
});

describe("climon-harness-fixture command dispatch", () => {
  test("advertises the exact approved public commands when no command is provided", async () => {
    await buildFixture();
    const child = spawnFixture([]);
    const exitPromise = once(child, "exit");
    const text = collectProcessText(child);

    const [code, signal] = await exitPromise;
    expect(code).toBe(2);
    expect(signal).toBeNull();
    expect(text.stdout).toBe("");
    expect(text.stderr).toBe(
      "Expected one of: streaming, interactive-tui, mode-probe -- <executable> [args...], control-probe, metadata-probe, lifecycle-probe <fast-success|failed-exit|flood|signal-hold|engine-echo>\n"
    );
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("rejects removed public aliases with stable stderr and exit 2", async () => {
    await buildFixture();

    for (const command of ["tui", "stream-protocol"]) {
      const child = spawnFixture([command]);
      const exitPromise = once(child, "exit");
      const text = collectProcessText(child);

      const [code, signal] = await exitPromise;
      expect(code).toBe(2);
      expect(signal).toBeNull();
      expect(text.stdout).toBe("");
      expect(text.stderr).toBe(`Unknown command: ${command}\n`);
    }
  }, FIXTURE_TEST_TIMEOUT_MS);

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
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("rejects lifecycle-probe calls without a valid mode", async () => {
    await buildFixture();

    for (const args of [
      ["lifecycle-probe"],
      ["lifecycle-probe", "bogus"],
      ["lifecycle-probe", "flood"],
      ["lifecycle-probe", "flood", "0", "gate-token"],
    ]) {
      const child = spawnFixture(args);
      const exitPromise = once(child, "exit");
      const text = collectProcessText(child);

      const [code, signal] = await exitPromise;
      expect(code).toBe(2);
      expect(signal).toBeNull();
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain("lifecycle-probe requires");
    }
  }, FIXTURE_TEST_TIMEOUT_MS);
});
