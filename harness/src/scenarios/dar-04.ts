import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BuildArtifacts } from "../build-cache.js";
import { PtyDriver, type PtyDriverDependencies, type PtySpawnSpec, type ScreenLike } from "../drivers/pty.js";
import type { RuntimeContext } from "../runtime-supervisor.js";
import type { SessionLedger, SessionStatus } from "../session-ledger.js";
import type { SubcheckDefinition } from "../subchecks.js";
import type { HarnessPlatform, SubcheckResult } from "../types.js";

const LOCAL_COLS = 100;
const LOCAL_ROWS = 30;
const LARGER_BROWSER_VIEWPORT = { width: 1440, height: 960 } as const;
const SAME_SIZE_BROWSER_VIEWPORT = { width: 1280, height: 820 } as const;
const PTY_INPUT_ARTIFACT = "pty/input.log";
const PTY_OUTPUT_ARTIFACT = "pty/output.log";
const MODE_BASELINE_PREFIX = "DAR_MODE_BASELINE ";
const READY_MARKER = `DAR_CONTROL_READY ${LOCAL_COLS} ${LOCAL_ROWS}`;
const OVERLAY_HINT = "Press Space to take control.";
const LOCAL_QUIET_PERIOD_MS = 500;
const SUBCHECK_TIMEOUTS_MS = {
  "larger-browser-displaces-local": 30_000,
  "local-restore-jiggles-both-dimensions": 30_000,
  "local-restore-complete-authoritative-repaint": 30_000,
  "same-size-browser-control-jiggle": 30_000,
  "same-size-complete-repaint": 30_000,
} as const;

export const DAR_04_SUBCHECKS = [
  {
    name: "larger-browser-displaces-local",
    title: "larger browser displaces local",
  },
  {
    name: "local-restore-jiggles-both-dimensions",
    title: "local restore jiggles both dimensions",
  },
  {
    name: "local-restore-complete-authoritative-repaint",
    title: "local restore complete authoritative repaint",
  },
  {
    name: "same-size-browser-control-jiggle",
    title: "same-size browser control jiggle",
  },
  {
    name: "same-size-complete-repaint",
    title: "same-size complete repaint",
  },
] as const satisfies readonly SubcheckDefinition[];

export type Dar04SubcheckName = (typeof DAR_04_SUBCHECKS)[number]["name"];

export const DAR_04_SUBCHECK_NAMES: readonly Dar04SubcheckName[] = DAR_04_SUBCHECKS.map(
  (subcheck) => subcheck.name
);

const DAR_04_SUBCHECKS_BY_NAME = new Map(
  DAR_04_SUBCHECKS.map((subcheck) => [subcheck.name, subcheck] as const)
);

export interface Dar04BrowserSurface {
  readonly name: string;
  readonly viewerId: string;
  open(baseUrl: string, deadline: number): Promise<void>;
  openTerminal(id: string, deadline: number): Promise<void>;
  takeControl(id: string, deadline: number): Promise<void>;
  controllerId(id: string, deadline: number): Promise<string>;
  waitForDisplaced(id: string, deadline: number): Promise<string>;
  waitForTerminalText(text: string, deadline: number): Promise<void>;
  terminalText(): Promise<string>;
  sendTerminalLine(text: string): Promise<void>;
  resizeViewport(width: number, height: number): Promise<void>;
  close(): Promise<void>;
}

export interface Dar04BrowserDriver {
  createSurface(options: {
    name: string;
    viewport: { width: number; height: number };
    displayMode?: "browser" | "standalone";
  }): Promise<Dar04BrowserSurface>;
}

export interface Dar04Context {
  platform: HarnessPlatform;
  overallDeadline: number | Date;
  build: Pick<BuildArtifacts, "clientPath" | "fixturePath">;
  runtime: Pick<RuntimeContext, "root" | "home" | "baseUrl" | "env"> & {
    artifacts: Pick<RuntimeContext["artifacts"], "dir" | "appendText">;
    sessions: Pick<SessionLedger, "track" | "waitForStatus" | "read">;
  };
}

export interface Dar04Pty {
  writeText(text: string): void;
  resize(cols: number, rows: number): void;
  expectRaw(marker: string, deadline: number): Promise<void>;
  expectScreen(predicate: (screen: ScreenLike) => boolean, deadline: number): Promise<void>;
  waitForQuiet(quietPeriodMs: number, deadline: number): Promise<void>;
  waitForExit(deadline: number): Promise<number>;
  kill(): void;
}

interface SessionMetaLike extends Record<string, unknown> {
  id: string;
  status: SessionStatus;
  cols?: number;
  rows?: number;
  name?: string;
}

interface FindSessionOptions {
  home: string;
  expectedName: string;
}

interface SurfaceSize {
  cols: number;
  rows: number;
  marker: string;
}

interface ResizeMarker {
  sequence: number;
  cols: number;
  rows: number;
  raw: string;
}

interface JiggleMarkers {
  shrink: ResizeMarker;
  restore: ResizeMarker;
}

export interface Dar04Dependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  createUuid?: () => string;
  createBrowserDriver?: (context: Dar04Context) => Dar04BrowserDriver;
  spawnPty?: (spec: PtySpawnSpec, dependencies: PtyDriverDependencies) => Dar04Pty;
  findSession?: (options: FindSessionOptions) => Promise<SessionMetaLike | undefined>;
  readSessionMeta?: (sessionId: string, home: string) => Promise<SessionMetaLike | undefined>;
  readLocalOutput?: (artifactsDir: string) => Promise<string>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawnPty(spec: PtySpawnSpec, dependencies: PtyDriverDependencies): Dar04Pty {
  return PtyDriver.spawn(spec, dependencies);
}

async function readText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function defaultReadLocalOutput(artifactsDir: string): Promise<string> {
  return readText(join(artifactsDir, PTY_OUTPUT_ARTIFACT));
}

async function defaultReadSessionMeta(
  sessionId: string,
  home: string
): Promise<SessionMetaLike | undefined> {
  try {
    const raw = await readFile(join(home, "sessions", `${sessionId}.json`), "utf8");
    return JSON.parse(raw) as SessionMetaLike;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function defaultFindSession(
  options: FindSessionOptions
): Promise<SessionMetaLike | undefined> {
  let entries: string[];
  try {
    entries = await readdir(join(options.home, "sessions"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const candidates: SessionMetaLike[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const id = entry.slice(0, -".json".length);
    const meta = await defaultReadSessionMeta(id, options.home);
    if (!meta) {
      continue;
    }
    if (meta.name === options.expectedName || meta.id === options.expectedName) {
      candidates.push(meta);
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one session metadata file for ${options.expectedName}, found ${candidates.length}`
    );
  }
  return candidates[0];
}

function asAbsoluteDeadline(deadline: number | Date): number {
  return deadline instanceof Date ? deadline.getTime() : deadline;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function sessionName(runId: string): string {
  return `DAR-04-${runId}`;
}

function tokenSuffix(runId: string): string {
  const condensed = runId.replaceAll("-", "");
  return (condensed.length > 0 ? condensed : runId).slice(0, 8);
}

function ptySpec(context: Dar04Context, runId: string): PtySpawnSpec {
  const fixturePath = resolve(context.build.fixturePath);
  return {
    file: fixturePath,
    args: [
      "mode-probe",
      "--",
      context.build.clientPath,
      "run",
      "--name",
      sessionName(runId),
      fixturePath,
      "control-probe",
    ],
    cwd: context.runtime.root,
    env: context.runtime.env,
    cols: LOCAL_COLS,
    rows: LOCAL_ROWS,
    inputPath: PTY_INPUT_ARTIFACT,
    outputPath: PTY_OUTPUT_ARTIFACT,
  };
}

function impossibleMessage(reason: string): string {
  return `Unable to run subcheck: ${reason}`;
}

function remainingDeadline(
  name: Dar04SubcheckName,
  overallDeadline: number,
  now: () => number
): number {
  const startedAt = now();
  return Math.min(overallDeadline, startedAt + SUBCHECK_TIMEOUTS_MS[name]);
}

function withEvidence(
  status: "passed" | "failed",
  name: Dar04SubcheckName,
  durationMs: number,
  baseEvidence: string[],
  options: { message?: string; evidence?: string[] } = {}
): SubcheckResult {
  const definition = DAR_04_SUBCHECKS_BY_NAME.get(name);
  if (!definition) {
    throw new Error(`Unknown DAR-04 subcheck: ${name}`);
  }

  return {
    name,
    title: definition.title,
    status,
    durationMs,
    message: options.message,
    evidence: [...baseEvidence, ...(options.evidence ?? [])],
  };
}

async function runSubcheck(
  name: Dar04SubcheckName,
  now: () => number,
  baseEvidence: () => string[],
  action: () => Promise<{ message?: string; evidence?: string[] }>
): Promise<SubcheckResult> {
  const startedAt = now();

  try {
    const outcome = await action();
    return withEvidence("passed", name, Math.max(0, now() - startedAt), baseEvidence(), outcome);
  } catch (error) {
    return withEvidence("failed", name, Math.max(0, now() - startedAt), baseEvidence(), {
      message: stringifyError(error),
    });
  }
}

async function waitForValue<T>(
  deadline: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  producer: () => Promise<T | undefined>,
  timeoutMessage: string
): Promise<T> {
  while (true) {
    const value = await producer();
    if (value !== undefined) {
      return value;
    }
    if (now() >= deadline) {
      throw new Error(timeoutMessage);
    }
    await sleep(Math.max(1, Math.min(pollIntervalMs, deadline - now())));
  }
}

function parseProbeSize(text: string): SurfaceSize | undefined {
  const match = /size=(\d+)x(\d+)/.exec(text);
  if (!match) {
    return undefined;
  }
  return {
    cols: Number.parseInt(match[1]!, 10),
    rows: Number.parseInt(match[2]!, 10),
    marker: `${match[1]}x${match[2]}`,
  };
}

function parseProbeResizeSequence(text: string): number | undefined {
  const match = /resizes=(\d+)/.exec(text);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function readMetaSize(meta: SessionMetaLike): { cols: number; rows: number } | undefined {
  if (
    typeof meta.cols === "number" &&
    Number.isInteger(meta.cols) &&
    meta.cols > 0 &&
    typeof meta.rows === "number" &&
    Number.isInteger(meta.rows) &&
    meta.rows > 0
  ) {
    return { cols: meta.cols, rows: meta.rows };
  }
  return undefined;
}

function lastTokenMarker(token: string): string {
  return `last=${token}`;
}

function expectedFrame(
  cols: number,
  rows: number,
  lastToken: string,
  resizeSequence: number
): string {
  return `DAR_CONTROL_READY\nsize=${cols}x${rows}\nlast=${lastToken}\nresizes=${resizeSequence}`;
}

function parseResizeMarkers(output: string): ResizeMarker[] {
  const matches = output.matchAll(/DAR_CONTROL_RESIZE (\d+) (\d+) (\d+)/g);
  return Array.from(matches, (match) => ({
    sequence: Number.parseInt(match[1]!, 10),
    cols: Number.parseInt(match[2]!, 10),
    rows: Number.parseInt(match[3]!, 10),
    raw: match[0],
  }));
}

function parseDisplayedResizeSequences(output: string): number[] {
  const matches = output.matchAll(/resizes=(\d+)/g);
  return Array.from(matches, (match) => Number.parseInt(match[1]!, 10));
}

async function readLatestResizeSequence(
  artifactsDir: string,
  readLocalOutput: (artifactsDir: string) => Promise<string>
): Promise<number> {
  const output = await readLocalOutput(artifactsDir);
  const markers = parseResizeMarkers(output);
  const displayed = parseDisplayedResizeSequences(output);
  return Math.max(markers.at(-1)?.sequence ?? 0, displayed.at(-1) ?? 0);
}

function normalizeSnapshot(snapshot: string): string {
  return snapshot.replace(/\r/g, "").split("\n").filter((line) => line.length > 0).join("\n");
}

async function alignSurfaceViewportToGrid(
  surface: Dar04BrowserSurface,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  viewport: { width: number; height: number },
  target: { cols: number; rows: number }
): Promise<{ width: number; height: number }> {
  let currentViewport = { ...viewport };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const snapshot = await surface.terminalText();
    const size = parseProbeSize(snapshot);
    if (size && size.cols === target.cols && size.rows === target.rows) {
      await surface.resizeViewport(currentViewport.width, currentViewport.height);
      return currentViewport;
    }

    const basisCols = size?.cols ?? target.cols;
    const basisRows = size?.rows ?? target.rows;
    const estimatedCellWidth = currentViewport.width / Math.max(1, basisCols);
    const estimatedCellHeight = currentViewport.height / Math.max(1, basisRows);
    let nextWidth = Math.max(320, Math.round(target.cols * estimatedCellWidth));
    let nextHeight = Math.max(240, Math.round(target.rows * estimatedCellHeight));

    if (nextWidth === currentViewport.width) {
      nextWidth += target.cols >= basisCols ? 8 : -8;
    }
    if (nextHeight === currentViewport.height) {
      nextHeight += target.rows >= basisRows ? 8 : -8;
    }

    currentViewport = { width: nextWidth, height: nextHeight };
    await surface.resizeViewport(currentViewport.width, currentViewport.height);

    if (attempt < 7) {
      await sleep(Math.max(1, pollIntervalMs));
    }
  }

  return currentViewport;
}

async function waitForJiggleMarkers(
  artifactsDir: string,
  deadline: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  readLocalOutput: (artifactsDir: string) => Promise<string>,
  afterSequence: number,
  target: { cols: number; rows: number },
): Promise<JiggleMarkers> {
  return waitForValue(
    deadline,
    now,
    sleep,
    pollIntervalMs,
    async () => {
      const markers = parseResizeMarkers(await readLocalOutput(artifactsDir)).filter(
        (marker) => marker.sequence > afterSequence
      );
      for (const shrink of markers) {
        if (shrink.cols !== target.cols - 1 || shrink.rows !== target.rows - 1) {
          continue;
        }
        const restore = markers.find(
          (marker) =>
            marker.sequence > shrink.sequence &&
            marker.cols === target.cols &&
            marker.rows === target.rows
        );
        if (restore) {
          return { shrink, restore };
        }
      }
      return undefined;
    },
    `Timed out waiting for jiggle markers ${target.cols - 1}x${target.rows - 1} -> ${target.cols}x${target.rows}`
  );
}

async function waitForSessionSize(
  sessionId: string,
  home: string,
  deadline: number,
  expected: { cols: number; rows: number },
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  readSessionMeta: (sessionId: string, home: string) => Promise<SessionMetaLike | undefined>
): Promise<SurfaceSize> {
  return waitForValue(
    deadline,
    now,
    sleep,
    pollIntervalMs,
    async () => {
      const meta = await readSessionMeta(sessionId, home);
      if (!meta) {
        return undefined;
      }
      const size = readMetaSize(meta);
      if (!size) {
        return undefined;
      }
      if (size.cols === expected.cols && size.rows === expected.rows) {
        return { ...size, marker: `${size.cols}x${size.rows}` };
      }
      return undefined;
    },
    `Timed out waiting for session ${sessionId} size ${expected.cols}x${expected.rows}`
  );
}

async function waitForControlledSurfaceSize(
  surface: Dar04BrowserSurface,
  sessionId: string,
  home: string,
  expectedControllerId: string,
  deadline: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  readSessionMeta: (sessionId: string, home: string) => Promise<SessionMetaLike | undefined>,
  predicate?: (size: SurfaceSize) => boolean
): Promise<SurfaceSize> {
  return waitForValue(
    deadline,
    now,
    sleep,
    pollIntervalMs,
    async () => {
      const controllerId = await surface.controllerId(sessionId, deadline);
      if (controllerId !== expectedControllerId) {
        return undefined;
      }
      const snapshot = await surface.terminalText();
      const size = parseProbeSize(snapshot);
      if (!size) {
        return undefined;
      }
      if (predicate && !predicate(size)) {
        return undefined;
      }
      const meta = await readSessionMeta(sessionId, home);
      const metaSize = meta ? readMetaSize(meta) : undefined;
      if (!metaSize) {
        return undefined;
      }
      if (metaSize.cols !== size.cols || metaSize.rows !== size.rows) {
        return undefined;
      }
      return size;
    },
    `Timed out waiting for controller ${expectedControllerId} to own the shared PTY size`
  );
}

async function waitForBrowserFrame(
  surface: Dar04BrowserSurface,
  deadline: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  expected: string
): Promise<void> {
  await waitForValue(
    deadline,
    now,
    sleep,
    pollIntervalMs,
    async () =>
      normalizeSnapshot(await surface.terminalText()) === normalizeSnapshot(expected)
        ? true
        : undefined,
    `Timed out waiting for browser frame ${JSON.stringify(expected)}`
  );
}

function surfaceEvidence(createdLarger: boolean, createdSameSize: boolean): string[] {
  const evidence: string[] = [];
  if (createdLarger) {
    evidence.push(
      "browser-surfaces/01-larger-browser/trace.zip",
      "browser-surfaces/01-larger-browser/console.log",
      "browser-surfaces/01-larger-browser/failed-requests.log",
      "browser-surfaces/01-larger-browser/closing.png"
    );
  }
  if (createdSameSize) {
    evidence.push(
      "browser-surfaces/02-same-size-browser/trace.zip",
      "browser-surfaces/02-same-size-browser/console.log",
      "browser-surfaces/02-same-size-browser/failed-requests.log",
      "browser-surfaces/02-same-size-browser/closing.png"
    );
  }
  return evidence;
}

function daemonLogEvidencePath(id: string): string {
  return `home/logs/daemon/${id}.log`;
}

function sessionMetaEvidencePath(id: string): string {
  return `home/sessions/${id}.json`;
}

function cleanupFailure(message: string, error: unknown): Error {
  return new Error(`${message}: ${stringifyError(error)}`, { cause: error });
}

function throwCleanupErrors(errors: Error[], aggregateMessage: string): void {
  if (errors.length === 0) {
    return;
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  throw new Error(errors.map((error) => error.message).join("; "), {
    cause: new AggregateError(errors, aggregateMessage),
  });
}

async function closeSurface(
  surface: Dar04BrowserSurface | undefined,
  label: string,
  cleanupErrors: Error[]
): Promise<void> {
  if (!surface) {
    return;
  }
  try {
    await surface.close();
  } catch (error) {
    cleanupErrors.push(cleanupFailure(`${label} close failed`, error));
  }
}

async function cleanupPty(
  pty: Dar04Pty | undefined,
  exitSent: boolean,
  localDisplaced: boolean,
  waitForQuietBeforeExit: boolean,
  trackedSessionId: string | undefined,
  surfaces: Dar04BrowserSurface[],
  localSize: { cols: number; rows: number },
  home: string,
  overallDeadline: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  readSessionMeta: (sessionId: string, home: string) => Promise<SessionMetaLike | undefined>,
  cleanupErrors: Error[]
): Promise<void> {
  if (!pty || exitSent) {
    return;
  }

  const cleanupDeadline = Math.min(overallDeadline, now() + 5_000);
  let shouldWaitForQuietBeforeExit = waitForQuietBeforeExit;

  if (localDisplaced) {
    pty.writeText(" ");
    shouldWaitForQuietBeforeExit = true;

    try {
      await pty.expectScreen(
        (screen) =>
          screen.contents().includes("DAR_CONTROL_READY") &&
          !screen.contents().includes(OVERLAY_HINT),
        cleanupDeadline
      );
    } catch (error) {
      cleanupErrors.push(cleanupFailure("PTY cleanup reclaim wait failed", error));
    }

    if (trackedSessionId) {
      try {
        await waitForSessionSize(
          trackedSessionId,
          home,
          cleanupDeadline,
          localSize,
          now,
          sleep,
          pollIntervalMs,
          readSessionMeta
        );
      } catch (error) {
        cleanupErrors.push(cleanupFailure("PTY cleanup reclaim wait failed", error));
      }

      for (const surface of surfaces) {
        try {
          await surface.waitForDisplaced(trackedSessionId, cleanupDeadline);
        } catch (error) {
          cleanupErrors.push(cleanupFailure("PTY cleanup reclaim wait failed", error));
        }
      }
    }
  }

  if (shouldWaitForQuietBeforeExit) {
    try {
      await pty.waitForQuiet(LOCAL_QUIET_PERIOD_MS, cleanupDeadline);
    } catch (error) {
      cleanupErrors.push(cleanupFailure("PTY cleanup quiet wait failed", error));
    }
  }

  try {
    pty.writeText("q");
    await pty.waitForExit(cleanupDeadline);
  } catch (error) {
    cleanupErrors.push(cleanupFailure("PTY cleanup failed", error));
    try {
      pty.kill();
    } catch (killError) {
      cleanupErrors.push(cleanupFailure("PTY cleanup failed", killError));
    }
  }
}

export async function runDar04(
  context: Dar04Context,
  dependencies: Dar04Dependencies = {}
): Promise<SubcheckResult[]> {
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? defaultSleep;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 50;
  const createUuid = dependencies.createUuid ?? randomUUID;
  const createBrowserDriver = dependencies.createBrowserDriver;
  const spawnPty = dependencies.spawnPty ?? defaultSpawnPty;
  const findSession = dependencies.findSession ?? defaultFindSession;
  const readSessionMeta = dependencies.readSessionMeta ?? defaultReadSessionMeta;
  const readLocalOutput = dependencies.readLocalOutput ?? defaultReadLocalOutput;
  const overallDeadline = asAbsoluteDeadline(context.overallDeadline);
  const runId = createUuid();
  const runToken = tokenSuffix(runId);
  const largerBrowserToken = `dar04-browser-large-${runToken}`;
  const sameSizeToken = `dar04-same-size-${runToken}`;
  const results: SubcheckResult[] = [];
  let browser: Dar04BrowserDriver | undefined;
  let largerBrowser: Dar04BrowserSurface | undefined;
  let sameSizeBrowser: Dar04BrowserSurface | undefined;
  let pty: Dar04Pty | undefined;
  let spawnFailure: string | undefined;
  let trackedSessionId: string | undefined;
  let createdLargerBrowser = false;
  let createdSameSizeBrowser = false;
  let localDisplaced = false;
  let exitSent = false;
  let waitForQuietBeforeExit = false;
  let authoritativeLocalSize = { cols: LOCAL_COLS, rows: LOCAL_ROWS };
  let largerBrowserReady = false;
  let localRestoreJiggle: JiggleMarkers | undefined;
  let localRestoreFrame: string | undefined;
  let sameSizeJiggle: JiggleMarkers | undefined;
  let sameSizeFrame: string | undefined;
  let sameSizeViewport: { width: number; height: number } = { ...SAME_SIZE_BROWSER_VIEWPORT };

  const baseEvidence = () => {
    const evidence = [PTY_INPUT_ARTIFACT, PTY_OUTPUT_ARTIFACT];
    if (trackedSessionId) {
      evidence.push(
        sessionMetaEvidencePath(trackedSessionId),
        daemonLogEvidencePath(trackedSessionId)
      );
    }
    evidence.push(...surfaceEvidence(createdLargerBrowser, createdSameSizeBrowser));
    return evidence;
  };

  try {
    pty = spawnPty(ptySpec(context, runId), {
      now,
      appendText: context.runtime.artifacts.appendText.bind(context.runtime.artifacts),
    });
  } catch (error) {
    spawnFailure = `Failed to spawn DAR-04 PTY: ${stringifyError(error)}`;
  }

  results.push(
    await runSubcheck("larger-browser-displaces-local", now, baseEvidence, async () => {
      if (!pty) {
        throw new Error(impossibleMessage(spawnFailure ?? "PTY unavailable"));
      }

      const deadline = remainingDeadline("larger-browser-displaces-local", overallDeadline, now);
      await pty.expectRaw(MODE_BASELINE_PREFIX, deadline);
      await pty.expectRaw(READY_MARKER, deadline);

      const session = await waitForValue(
        deadline,
        now,
        sleep,
        pollIntervalMs,
        async () =>
          findSession({
            home: context.runtime.home,
            expectedName: sessionName(runId),
          }),
        `Timed out waiting for DAR-04 metadata for ${sessionName(runId)}`
      );

      trackedSessionId = session.id;
      context.runtime.sessions.track(trackedSessionId);
      await context.runtime.sessions.waitForStatus(trackedSessionId, "running", deadline);
      await waitForSessionSize(
        trackedSessionId,
        context.runtime.home,
        deadline,
        authoritativeLocalSize,
        now,
        sleep,
        pollIntervalMs,
        readSessionMeta
      );

      if (!createBrowserDriver) {
        throw new Error("DAR-04 requires createBrowserDriver()");
      }
      browser ??= createBrowserDriver(context);
      largerBrowser ??= await browser.createSurface({
        name: "larger-browser",
        viewport: { ...LARGER_BROWSER_VIEWPORT },
        displayMode: "browser",
      });
      createdLargerBrowser = true;
      await largerBrowser.open(context.runtime.baseUrl, deadline);
      await largerBrowser.openTerminal(trackedSessionId, deadline);
      await largerBrowser.takeControl(trackedSessionId, deadline);
      localDisplaced = true;
      await pty.expectScreen(
        (screen) => screen.contents().includes(OVERLAY_HINT),
        deadline
      );
      await largerBrowser.sendTerminalLine(largerBrowserToken);
      await largerBrowser.waitForTerminalText(lastTokenMarker(largerBrowserToken), deadline);
      const largerSize = await waitForControlledSurfaceSize(
        largerBrowser,
        trackedSessionId,
        context.runtime.home,
        largerBrowser.viewerId,
        deadline,
        now,
        sleep,
        pollIntervalMs,
        readSessionMeta,
        (size) => size.cols > LOCAL_COLS && size.rows > LOCAL_ROWS
      );
      largerBrowserReady = true;
      return {
        message: `Larger browser ${largerBrowser.viewerId} displaced local at ${largerSize.marker}`,
        evidence: [
          `DAR_CONTROL_RESIZE 1 ${largerSize.cols} ${largerSize.rows}`,
          lastTokenMarker(largerBrowserToken),
          largerSize.marker,
        ],
      };
    })
  );

  const largerBrowserBlocked = () =>
    largerBrowserReady && trackedSessionId && pty && largerBrowser
      ? undefined
      : "larger-browser-displaces-local did not leave the local terminal displaced by a larger browser";

  results.push(
    await runSubcheck(
      "local-restore-jiggles-both-dimensions",
      now,
      baseEvidence,
      async () => {
        const blocked = largerBrowserBlocked();
        if (blocked) {
          throw new Error(impossibleMessage(blocked));
        }

        const deadline = remainingDeadline(
          "local-restore-jiggles-both-dimensions",
          overallDeadline,
          now
        );
        const baselineSequence = await readLatestResizeSequence(
          context.runtime.artifacts.dir,
          readLocalOutput
        );
        pty!.writeText(" ");
        localDisplaced = false;
        waitForQuietBeforeExit = true;
        localRestoreJiggle = await waitForJiggleMarkers(
          context.runtime.artifacts.dir,
          deadline,
          now,
          sleep,
          pollIntervalMs,
          readLocalOutput,
          baselineSequence,
          authoritativeLocalSize,
        );
        await waitForSessionSize(
          trackedSessionId!,
          context.runtime.home,
          deadline,
          authoritativeLocalSize,
          now,
          sleep,
          pollIntervalMs,
          readSessionMeta
        );
        await largerBrowser!.waitForDisplaced(trackedSessionId!, deadline);
        return {
          message: `Local restore jiggled ${localRestoreJiggle.shrink.cols}x${localRestoreJiggle.shrink.rows} -> ${localRestoreJiggle.restore.cols}x${localRestoreJiggle.restore.rows}`,
          evidence: [localRestoreJiggle.shrink.raw, localRestoreJiggle.restore.raw],
        };
      }
    )
  );

  const localRestoreBlocked = () =>
    localRestoreJiggle ? undefined : "local-restore-jiggles-both-dimensions did not finish the restore jiggle";

  results.push(
    await runSubcheck(
      "local-restore-complete-authoritative-repaint",
      now,
      baseEvidence,
      async () => {
        const blocked = localRestoreBlocked();
        if (blocked) {
          throw new Error(impossibleMessage(blocked));
        }

        const deadline = remainingDeadline(
          "local-restore-complete-authoritative-repaint",
          overallDeadline,
          now
        );
        localRestoreFrame = expectedFrame(
          authoritativeLocalSize.cols,
          authoritativeLocalSize.rows,
          largerBrowserToken,
          localRestoreJiggle!.restore.sequence
        );
        await pty!.expectScreen((screen) => screen.contents() === localRestoreFrame, deadline);
        return {
          message: `Local restore repainted ${authoritativeLocalSize.cols}x${authoritativeLocalSize.rows}`,
          evidence: [localRestoreFrame],
        };
      }
    )
  );

  const localRestoreFrameBlocked = () =>
    localRestoreFrame
      ? undefined
      : "local-restore-complete-authoritative-repaint did not verify the restored local frame";

  results.push(
    await runSubcheck(
      "same-size-browser-control-jiggle",
      now,
      baseEvidence,
      async () => {
        const blocked = localRestoreFrameBlocked();
        if (blocked) {
          throw new Error(impossibleMessage(blocked));
        }

        const deadline = remainingDeadline("same-size-browser-control-jiggle", overallDeadline, now);
        if (!createBrowserDriver) {
          throw new Error("DAR-04 requires createBrowserDriver()");
        }
        browser ??= createBrowserDriver(context);
        sameSizeBrowser ??= await browser.createSurface({
          name: "same-size-browser",
          viewport: { ...sameSizeViewport },
          displayMode: "browser",
        });
        createdSameSizeBrowser = true;
        await sameSizeBrowser.open(context.runtime.baseUrl, deadline);
        await sameSizeBrowser.openTerminal(trackedSessionId!, deadline);

        await sameSizeBrowser.takeControl(trackedSessionId!, deadline);
        localDisplaced = true;
        const calibratedSize = await waitForControlledSurfaceSize(
          sameSizeBrowser,
          trackedSessionId!,
          context.runtime.home,
          sameSizeBrowser.viewerId,
          deadline,
          now,
          sleep,
          pollIntervalMs,
          readSessionMeta
        );

        pty!.writeText(" ");
        localDisplaced = false;
        waitForQuietBeforeExit = true;
        await waitForSessionSize(
          trackedSessionId!,
          context.runtime.home,
          deadline,
          authoritativeLocalSize,
          now,
          sleep,
          pollIntervalMs,
          readSessionMeta
        );
        await sameSizeBrowser.waitForDisplaced(trackedSessionId!, deadline);

        if (waitForQuietBeforeExit) {
          await pty!.waitForQuiet(LOCAL_QUIET_PERIOD_MS, deadline);
          waitForQuietBeforeExit = false;
        }

        const beforeLocalResize = await readLatestResizeSequence(
          context.runtime.artifacts.dir,
          readLocalOutput
        );
        if (
          authoritativeLocalSize.cols !== calibratedSize.cols ||
          authoritativeLocalSize.rows !== calibratedSize.rows
        ) {
          pty!.resize(calibratedSize.cols, calibratedSize.rows);
          authoritativeLocalSize = { cols: calibratedSize.cols, rows: calibratedSize.rows };
          await waitForValue(
            deadline,
            now,
            sleep,
            pollIntervalMs,
            async () => {
              const markers = parseResizeMarkers(await readLocalOutput(context.runtime.artifacts.dir));
              return markers.find(
                (marker) =>
                  marker.sequence > beforeLocalResize &&
                  marker.cols === calibratedSize.cols &&
                  marker.rows === calibratedSize.rows
              )?.raw;
            },
            `Timed out waiting for local resize marker ${calibratedSize.cols}x${calibratedSize.rows}`
          );
          await waitForSessionSize(
            trackedSessionId!,
            context.runtime.home,
            deadline,
            authoritativeLocalSize,
            now,
            sleep,
            pollIntervalMs,
            readSessionMeta
          );
        }

        pty!.writeText(`${sameSizeToken}\r`);
        await pty!.expectRaw(`DAR_CONTROL_INPUT ${sameSizeToken}`, deadline);
        let baselineSequence: number | undefined;
        await pty!.expectScreen((screen) => {
          const contents = screen.contents();
          if (
            !contents.includes(`last=${sameSizeToken}`) ||
            !contents.includes(`size=${authoritativeLocalSize.cols}x${authoritativeLocalSize.rows}`)
          ) {
            return false;
          }
          baselineSequence = parseProbeResizeSequence(contents);
          return baselineSequence !== undefined;
        }, deadline);
        if (baselineSequence === undefined) {
          throw new Error("Unable to read local resize sequence before same-size browser control");
        }
        sameSizeViewport = await alignSurfaceViewportToGrid(
          sameSizeBrowser,
          sleep,
          pollIntervalMs,
          sameSizeViewport,
          authoritativeLocalSize
        );
        await sameSizeBrowser.takeControl(trackedSessionId!, deadline);
        localDisplaced = true;
        waitForQuietBeforeExit = true;
        sameSizeJiggle = await waitForJiggleMarkers(
          context.runtime.artifacts.dir,
          deadline,
          now,
          sleep,
          pollIntervalMs,
          readLocalOutput,
          baselineSequence,
          authoritativeLocalSize,
        );
        await waitForSessionSize(
          trackedSessionId!,
          context.runtime.home,
          deadline,
          authoritativeLocalSize,
          now,
          sleep,
          pollIntervalMs,
          readSessionMeta
        );
        return {
          message: `Same-size browser jiggled ${sameSizeJiggle.shrink.cols}x${sameSizeJiggle.shrink.rows} -> ${sameSizeJiggle.restore.cols}x${sameSizeJiggle.restore.rows}`,
          evidence: [sameSizeJiggle.shrink.raw, sameSizeJiggle.restore.raw],
        };
      }
    )
  );

  const sameSizeBlocked = () =>
    sameSizeJiggle ? undefined : "same-size-browser-control-jiggle did not finish the same-size browser jiggle";

  results.push(
    await runSubcheck(
      "same-size-complete-repaint",
      now,
      baseEvidence,
      async () => {
        const blocked = sameSizeBlocked();
        if (blocked) {
          throw new Error(impossibleMessage(blocked));
        }

        const deadline = remainingDeadline("same-size-complete-repaint", overallDeadline, now);
        sameSizeFrame = expectedFrame(
          authoritativeLocalSize.cols,
          authoritativeLocalSize.rows,
          sameSizeToken,
          sameSizeJiggle!.restore.sequence
        );
        await waitForBrowserFrame(
          sameSizeBrowser!,
          deadline,
          now,
          sleep,
          pollIntervalMs,
          sameSizeFrame
        );
        return {
          message: `Same-size browser repaint completed at ${authoritativeLocalSize.cols}x${authoritativeLocalSize.rows}`,
          evidence: [sameSizeFrame],
        };
      }
    )
  );

  const cleanupErrors: Error[] = [];
  await cleanupPty(
    pty,
    exitSent,
    localDisplaced,
    waitForQuietBeforeExit,
    trackedSessionId,
    [largerBrowser, sameSizeBrowser].filter((surface): surface is Dar04BrowserSurface => Boolean(surface)),
    authoritativeLocalSize,
    context.runtime.home,
    overallDeadline,
    now,
    sleep,
    pollIntervalMs,
    readSessionMeta,
    cleanupErrors
  );
  await closeSurface(sameSizeBrowser, "Same-size browser surface", cleanupErrors);
  await closeSurface(largerBrowser, "Larger browser surface", cleanupErrors);
  throwCleanupErrors(cleanupErrors, "Failed to finalize DAR-04");

  return results;
}
