import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PtyDriver, type PtyDriverDependencies, type PtySpawnSpec, type ScreenLike } from "../drivers/pty.js";
import type { MouseEvent, NamedKey } from "../drivers/terminal-input.js";
import type { RuntimeContext } from "../runtime-supervisor.js";
import type { BuildArtifacts } from "../build-cache.js";
import type { HarnessPlatform, SubcheckResult } from "../types.js";

const PTY_COLS = 100;
const PTY_ROWS = 30;
const RESIZED_COLS = 120;
const RESIZED_ROWS = 40;
const PTY_INPUT_ARTIFACT = "pty/input.log";
const PTY_OUTPUT_ARTIFACT = "pty/output.log";
const QUIT_TEXT = "q";
const EXPECTED_CURSOR = { col: 0, row: 3 };
const UNIQUE_TEXT_PREFIX = "DAR-01-こんにちは-ß-";
const MOUSE_COORDINATES = { col: 10, row: 6 } as const;
const SUBCHECK_TIMEOUTS_MS = {
  "baseline-terminal-mode": 10_000,
  "attached-startup": 30_000,
  "text-input-output": 10_000,
  "control-and-key-input": 10_000,
  "mouse-input": 10_000,
  "alternate-screen-render": 10_000,
  "resize-repaint": 10_000,
  "clean-exit": 10_000,
  "terminal-mode-restoration": 10_000,
} as const;

export const DAR_01_SUBCHECK_NAMES = [
  "baseline-terminal-mode",
  "attached-startup",
  "text-input-output",
  "control-and-key-input",
  "mouse-input",
  "alternate-screen-render",
  "resize-repaint",
  "clean-exit",
  "terminal-mode-restoration",
] as const;

export type Dar01SubcheckName = (typeof DAR_01_SUBCHECK_NAMES)[number];

export interface Dar01Context {
  platform: HarnessPlatform;
  overallDeadline: number | Date;
  build: Pick<BuildArtifacts, "clientPath" | "fixturePath">;
  runtime: Pick<RuntimeContext, "root" | "env"> & {
    artifacts: Pick<RuntimeContext["artifacts"], "dir" | "appendText">;
  };
}

export interface Dar01Pty {
  writeText(text: string): void;
  sendControl(key: string): void;
  sendKey(key: NamedKey): void;
  sendMouse(event: MouseEvent): void;
  resize(cols: number, rows: number): void;
  expectRaw(marker: string, deadline: number): Promise<void>;
  expectScreen(predicate: (screen: ScreenLike) => boolean, deadline: number): Promise<void>;
  waitForExit(deadline: number): Promise<number>;
  kill(): void;
}

export interface Dar01Dependencies {
  now?: () => number;
  createUuid?: () => string;
  spawnPty?: (spec: PtySpawnSpec, dependencies: PtyDriverDependencies) => Dar01Pty;
  readArtifactText?: (artifactPath: string, artifactsDir: string) => Promise<string>;
}

interface ModeProbeBaseline {
  command: string[];
  platform: string;
  before: PlatformSnapshot;
}

interface ModeProbeResult {
  command: string[];
  platform: string;
  before: PlatformSnapshot;
  after: PlatformSnapshot;
  childExitCode: number;
  functionalRestored: boolean | null;
  pendinChanged: boolean | null;
  spawnError?: string | null;
}

interface UnixConsoleState {
  echo?: boolean | null;
  icanon?: boolean | null;
  isig?: boolean | null;
  iexten?: boolean | null;
  pendin?: boolean | null;
  error?: string | null;
}

interface UnixSnapshot {
  kind: "unix";
  stdin: UnixConsoleState;
}

interface WindowsConsoleState {
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

interface WindowsSnapshot {
  kind: "windows";
  input: WindowsConsoleState;
  output: WindowsConsoleState;
}

interface UnsupportedSnapshot {
  kind: "unsupported";
  error: string;
}

type PlatformSnapshot = UnixSnapshot | WindowsSnapshot | UnsupportedSnapshot;

interface ParsedMarker<T> {
  line: string;
  value: T;
}

interface ScreenSnapshot {
  contents: string;
  cursor: { col: number; row: number };
}

function asAbsoluteDeadline(deadline: number | Date): number {
  return deadline instanceof Date ? deadline.getTime() : deadline;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function stringifyError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function defaultSpawnPty(spec: PtySpawnSpec, dependencies: PtyDriverDependencies): Dar01Pty {
  return PtyDriver.spawn(spec, dependencies);
}

async function defaultReadArtifactText(
  artifactPath: string,
  artifactsDir: string
): Promise<string> {
  return readFile(join(artifactsDir, artifactPath), "utf8");
}

function normalizeSubcheckError(name: Dar01SubcheckName, error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(`${name} failed: ${String(error)}`);
}

function parseSinglePrefixedJson<T>(
  rawOutput: string,
  prefix: string,
  label: string
): ParsedMarker<T> {
  const markers = rawOutput
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line.startsWith(prefix));

  if (markers.length === 0) {
    throw new Error(`Missing ${label} marker`);
  }
  if (markers.length !== 1) {
    throw new Error(`Expected exactly one ${label} marker, found ${markers.length}`);
  }

  try {
    return {
      line: markers[0]!,
      value: JSON.parse(markers[0]!.slice(prefix.length)) as T,
    };
  } catch (error) {
    throw new Error(`Malformed ${label} marker JSON: ${stringifyError(error)}`);
  }
}

function expectTrue(field: string, value: boolean | null | undefined): void {
  if (value !== true) {
    throw new Error(`Expected ${field}=true, received ${String(value)}`);
  }
}

function expectErrorAbsent(field: string, value: string | null | undefined): void {
  if (value != null) {
    throw new Error(`Expected ${field} to be absent, received ${JSON.stringify(value)}`);
  }
}

function validateUnixBaseline(snapshot: UnixSnapshot): string {
  expectErrorAbsent("stdin.error", snapshot.stdin.error);
  expectTrue("stdin.echo", snapshot.stdin.echo);
  expectTrue("stdin.icanon", snapshot.stdin.icanon);
  expectTrue("stdin.isig", snapshot.stdin.isig);
  expectTrue("stdin.iexten", snapshot.stdin.iexten);
  return "baseline before.kind=unix stdin.echo=true stdin.icanon=true stdin.isig=true stdin.iexten=true";
}

function validateWindowsBaseline(snapshot: WindowsSnapshot): string {
  expectTrue("input.validHandle", snapshot.input.validHandle);
  expectErrorAbsent("input.error", snapshot.input.error);
  expectTrue("input.echoInput", snapshot.input.echoInput);
  expectTrue("input.lineInput", snapshot.input.lineInput);
  expectTrue("input.processedInput", snapshot.input.processedInput);
  expectTrue("input.extendedFlags", snapshot.input.extendedFlags);
  expectTrue("output.validHandle", snapshot.output.validHandle);
  expectErrorAbsent("output.error", snapshot.output.error);
  expectTrue("output.processedOutput", snapshot.output.processedOutput);
  expectTrue("output.wrapAtEol", snapshot.output.wrapAtEol);
  return "baseline before.kind=windows input.validHandle=true input.echoInput=true input.lineInput=true input.processedInput=true input.extendedFlags=true output.validHandle=true output.processedOutput=true output.wrapAtEol=true";
}

function validateBaseline(baseline: ModeProbeBaseline, platform: HarnessPlatform): string {
  if (baseline.platform !== platform) {
    throw new Error(`Expected baseline platform=${platform}, received ${baseline.platform}`);
  }

  if (platform === "windows") {
    if (baseline.before.kind !== "windows") {
      throw new Error(`Expected before.kind=windows, received before.kind=${baseline.before.kind}`);
    }
    return validateWindowsBaseline(baseline.before);
  }

  if (baseline.before.kind === "unsupported") {
    throw new Error(`Unsupported baseline snapshot: ${baseline.before.error}`);
  }
  if (baseline.before.kind !== "unix") {
    throw new Error(`Expected before.kind=unix, received before.kind=${baseline.before.kind}`);
  }
  return validateUnixBaseline(baseline.before);
}

async function captureScreen(
  pty: Dar01Pty,
  deadline: number,
  predicate: (snapshot: ScreenSnapshot) => boolean
): Promise<ScreenSnapshot> {
  let latest: ScreenSnapshot = {
    contents: "",
    cursor: { col: 0, row: 0 },
  };

  await pty.expectScreen((screen) => {
    latest = {
      contents: screen.contents(),
      cursor: screen.cursor(),
    };
    return predicate(latest);
  }, deadline);

  return latest;
}

function expectedUniqueText(runId: string): string {
  return `${UNIQUE_TEXT_PREFIX}${runId}`;
}

function sessionName(runId: string): string {
  return `DAR-01-${runId}`;
}

function ptySpec(context: Dar01Context, runId: string): PtySpawnSpec {
  return {
    file: context.build.fixturePath,
    args: [
      "mode-probe",
      "--",
      context.build.clientPath,
      "run",
      "--name",
      sessionName(runId),
      "fixture",
      "interactive-tui",
    ],
    cwd: context.runtime.root,
    env: context.runtime.env,
    cols: PTY_COLS,
    rows: PTY_ROWS,
    inputPath: PTY_INPUT_ARTIFACT,
    outputPath: PTY_OUTPUT_ARTIFACT,
  };
}

function withEvidence(
  status: "passed" | "failed",
  name: Dar01SubcheckName,
  durationMs: number,
  options: { message?: string; evidence?: string[] } = {}
): SubcheckResult {
  return {
    name,
    status,
    durationMs,
    message: options.message,
    evidence: [PTY_INPUT_ARTIFACT, PTY_OUTPUT_ARTIFACT, ...(options.evidence ?? [])],
  };
}

function remainingDeadline(
  name: Dar01SubcheckName,
  overallDeadline: number,
  now: () => number
): number {
  const startedAt = now();
  return Math.min(overallDeadline, startedAt + SUBCHECK_TIMEOUTS_MS[name]);
}

async function runSubcheck(
  name: Dar01SubcheckName,
  now: () => number,
  action: () => Promise<{ message?: string; evidence?: string[] }>
): Promise<SubcheckResult> {
  const startedAt = now();

  try {
    const outcome = await action();
    return withEvidence("passed", name, Math.max(0, now() - startedAt), outcome);
  } catch (error) {
    return withEvidence("failed", name, Math.max(0, now() - startedAt), {
      message: stringifyError(normalizeSubcheckError(name, error)),
    });
  }
}

function impossibleMessage(reason: string): string {
  return `Unable to run subcheck: ${reason}`;
}

function restoreMessage(result: ModeProbeResult, platform: HarnessPlatform): string | undefined {
  if (platform === "macos" && result.pendinChanged === true) {
    return "childExitCode=0 functionalRestored=true pendinChanged=true (accepted on macOS)";
  }
  return undefined;
}

export async function runDar01(
  context: Dar01Context,
  dependencies: Dar01Dependencies = {}
): Promise<SubcheckResult[]> {
  const now = dependencies.now ?? (() => Date.now());
  const createUuid = dependencies.createUuid ?? randomUUID;
  const spawnPty = dependencies.spawnPty ?? defaultSpawnPty;
  const readArtifactText = dependencies.readArtifactText ?? defaultReadArtifactText;
  const overallDeadline = asAbsoluteDeadline(context.overallDeadline);
  const runId = createUuid();
  const uniqueText = expectedUniqueText(runId);
  const screenMouseEvent = `event=mouse:wheel-up:${MOUSE_COORDINATES.col}:${MOUSE_COORDINATES.row}`;
  const mouseMarker = `DAR_TUI_MOUSE_WHEEL_UP ${MOUSE_COORDINATES.col} ${MOUSE_COORDINATES.row}`;
  const results: SubcheckResult[] = [];
  let pty: Dar01Pty | undefined;
  let spawnFailure: string | undefined;
  let startupReady = false;
  let quitSent = false;

  try {
    pty = spawnPty(ptySpec(context, runId), {
      now,
      appendText: context.runtime.artifacts.appendText,
    });
  } catch (error) {
    spawnFailure = `Failed to spawn DAR-01 PTY: ${stringifyError(error)}`;
  }

  const readOutput = () => readArtifactText(PTY_OUTPUT_ARTIFACT, context.runtime.artifacts.dir);

  results.push(
    await runSubcheck("baseline-terminal-mode", now, async () => {
      if (!pty) {
        throw new Error(impossibleMessage(spawnFailure ?? "PTY unavailable"));
      }

      const deadline = remainingDeadline("baseline-terminal-mode", overallDeadline, now);
      await pty.expectRaw("DAR_MODE_BASELINE ", deadline);
      const baseline = parseSinglePrefixedJson<ModeProbeBaseline>(
        await readOutput(),
        "DAR_MODE_BASELINE ",
        "DAR_MODE_BASELINE"
      );
      return {
        message: validateBaseline(baseline.value, context.platform),
        evidence: [baseline.line],
      };
    })
  );

  results.push(
    await runSubcheck("attached-startup", now, async () => {
      if (!pty) {
        throw new Error(impossibleMessage(spawnFailure ?? "PTY unavailable"));
      }

      const deadline = remainingDeadline("attached-startup", overallDeadline, now);
      await pty.expectRaw("021 DAR_TUI_READY", deadline);
      startupReady = true;
      return { message: "Attached TUI reported DAR_TUI_READY" };
    })
  );

  const startupBlocked = () =>
    !pty
      ? spawnFailure ?? "PTY unavailable"
      : startupReady
        ? undefined
        : "attached-startup did not reach DAR_TUI_READY";

  results.push(
    await runSubcheck("text-input-output", now, async () => {
      const blocked = startupBlocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline("text-input-output", overallDeadline, now);
      pty!.writeText(uniqueText);
      await pty!.expectRaw(`DAR_TUI_TEXT ${uniqueText}`, deadline);
      return { message: `Verified UTF-8 text echo for ${uniqueText}` };
    })
  );

  results.push(
    await runSubcheck("control-and-key-input", now, async () => {
      const blocked = startupBlocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline("control-and-key-input", overallDeadline, now);
      pty!.sendControl("c");
      await pty!.expectRaw("DAR_TUI_CONTROL Ctrl+C", deadline);
      pty!.sendKey("ArrowUp");
      await pty!.expectRaw("DAR_TUI_KEY ArrowUp", deadline);
      return { message: "Verified Ctrl+C and ArrowUp markers" };
    })
  );

  results.push(
    await runSubcheck("mouse-input", now, async () => {
      const blocked = startupBlocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline("mouse-input", overallDeadline, now);
      pty!.sendMouse({ kind: "press", button: 0, ...MOUSE_COORDINATES });
      await pty!.expectRaw(`DAR_TUI_MOUSE_PRESS Left ${MOUSE_COORDINATES.col} ${MOUSE_COORDINATES.row}`, deadline);
      pty!.sendMouse({ kind: "release", button: 0, ...MOUSE_COORDINATES });
      await pty!.expectRaw(
        `DAR_TUI_MOUSE_RELEASE Left ${MOUSE_COORDINATES.col} ${MOUSE_COORDINATES.row}`,
        deadline
      );
      pty!.sendMouse({ kind: "wheel-up", ...MOUSE_COORDINATES });
      await pty!.expectRaw(mouseMarker, deadline);
      return { message: `Verified press/release/wheel-up at ${MOUSE_COORDINATES.col},${MOUSE_COORDINATES.row}` };
    })
  );

  results.push(
    await runSubcheck("alternate-screen-render", now, async () => {
      const blocked = startupBlocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline("alternate-screen-render", overallDeadline, now);
      const snapshot = await captureScreen(pty!, deadline, ({ contents, cursor }) =>
        contents.includes("DAR_TUI_READY") &&
        contents.includes(screenMouseEvent) &&
        contents.includes(`last-marker=${mouseMarker}`) &&
        contents.includes(`size=${PTY_COLS}x${PTY_ROWS}`) &&
        cursor.col === EXPECTED_CURSOR.col &&
        cursor.row === EXPECTED_CURSOR.row
      );
      return {
        message: `cursor=(${snapshot.cursor.col},${snapshot.cursor.row})`,
      };
    })
  );

  results.push(
    await runSubcheck("resize-repaint", now, async () => {
      const blocked = startupBlocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline("resize-repaint", overallDeadline, now);
      pty!.resize(RESIZED_COLS, RESIZED_ROWS);
      await pty!.expectRaw(`DAR_TUI_RESIZE ${RESIZED_COLS} ${RESIZED_ROWS}`, deadline);
      const snapshot = await captureScreen(pty!, deadline, ({ contents, cursor }) =>
        contents.includes("DAR_TUI_READY") &&
        contents.includes(`DAR_TUI_RESIZE ${RESIZED_COLS} ${RESIZED_ROWS}`) &&
        contents.includes(`size=${RESIZED_COLS}x${RESIZED_ROWS}`) &&
        cursor.col === EXPECTED_CURSOR.col &&
        cursor.row === EXPECTED_CURSOR.row
      );
      return {
        message: `cursor=(${snapshot.cursor.col},${snapshot.cursor.row}) size=${RESIZED_COLS}x${RESIZED_ROWS}`,
      };
    })
  );

  results.push(
    await runSubcheck("clean-exit", now, async () => {
      if (!pty) {
        throw new Error(impossibleMessage(spawnFailure ?? "PTY unavailable"));
      }

      const deadline = remainingDeadline("clean-exit", overallDeadline, now);

      try {
        if (!quitSent) {
          pty.writeText(QUIT_TEXT);
          quitSent = true;
        }
        const exitCode = await pty.waitForExit(deadline);
        if (exitCode !== 0) {
          throw new Error(`Expected exit code 0, received ${exitCode}`);
        }
        return { message: "Client exited cleanly with code 0" };
      } catch (error) {
        pty.kill();
        throw error;
      }
    })
  );

  results.push(
    await runSubcheck("terminal-mode-restoration", now, async () => {
      if (!pty) {
        throw new Error(impossibleMessage(spawnFailure ?? "PTY unavailable"));
      }

      const rawOutput = await readOutput();
      const result = parseSinglePrefixedJson<ModeProbeResult>(
        rawOutput,
        "DAR_MODE_RESULT ",
        "DAR_MODE_RESULT"
      ).value;
      if (result.spawnError) {
        throw new Error(`mode-probe child spawn error: ${result.spawnError}`);
      }
      if (result.childExitCode !== 0) {
        throw new Error(`Expected childExitCode=0, received ${result.childExitCode}`);
      }
      if (result.functionalRestored !== true) {
        throw new Error(`Expected functionalRestored=true, received ${String(result.functionalRestored)}`);
      }
      if (context.platform !== "macos" && result.pendinChanged === true) {
        throw new Error("Expected pendinChanged=false outside macOS, received pendinChanged=true");
      }
      return {
        message: restoreMessage(result, context.platform),
      };
    })
  );

  return results;
}
