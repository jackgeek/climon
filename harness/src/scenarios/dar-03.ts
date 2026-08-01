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
const DESKTOP_VIEWPORT = { width: 1440, height: 960 } as const;
const PWA_VIEWPORT = { width: 390, height: 844 } as const;
const RESIZED_LOCAL_COLS = 140;
const RESIZED_LOCAL_ROWS = 46;
const PTY_INPUT_ARTIFACT = "pty/input.log";
const PTY_OUTPUT_ARTIFACT = "pty/output.log";
const MODE_BASELINE_PREFIX = "DAR_MODE_BASELINE ";
const READY_MARKER = `DAR_CONTROL_READY ${LOCAL_COLS} ${LOCAL_ROWS}`;
const OVERLAY_MESSAGE = "This session is being viewed on a climon dashboard.";
const OVERLAY_HINT = "Press Space to take control.";
const LOCAL_QUIET_PERIOD_MS = 300;
const SUBCHECK_TIMEOUTS_MS = {
  "local-starts-as-controller": 30_000,
  "desktop-transfers-control-and-pty-size": 30_000,
  "displaced-local-non-space-suppressed": 10_000,
  "simulated-pwa-newest-controller": 30_000,
  "local-space-reclaims-control": 30_000,
  "local-resize-authoritative": 30_000,
} as const;

export const DAR_03_SUBCHECKS = [
  {
    name: "local-starts-as-controller",
    title: "Starts the attached local terminal as controller",
  },
  {
    name: "desktop-transfers-control-and-pty-size",
    title: "Transfers control and PTY sizing to the desktop dashboard",
  },
  {
    name: "displaced-local-non-space-suppressed",
    title: "Suppresses non-Space input from the displaced local terminal",
  },
  {
    name: "simulated-pwa-newest-controller",
    title: "Makes the simulated PWA the newest active controller",
  },
  {
    name: "local-space-reclaims-control",
    title: "Reclaims control from the local terminal with Space",
  },
  {
    name: "local-resize-authoritative",
    title: "Restores local terminal size as the authoritative PTY size",
  },
] as const satisfies readonly SubcheckDefinition[];

export type Dar03SubcheckName = (typeof DAR_03_SUBCHECKS)[number]["name"];

export const DAR_03_SUBCHECK_NAMES: readonly Dar03SubcheckName[] = DAR_03_SUBCHECKS.map(
  (subcheck) => subcheck.name
);

const DAR_03_SUBCHECKS_BY_NAME = new Map(
  DAR_03_SUBCHECKS.map((subcheck) => [subcheck.name, subcheck] as const)
);

export interface Dar03BrowserSurface {
  readonly name: string;
  readonly viewerId: string;
  open(baseUrl: string, deadline: number): Promise<void>;
  openTerminal(id: string, deadline: number): Promise<void>;
  takeControl(id: string, deadline: number): Promise<void>;
  controllerId(id: string, deadline: number): Promise<string>;
  waitForTerminalText(text: string, deadline: number): Promise<void>;
  sendTerminalLine(text: string): Promise<void>;
  terminalText(): Promise<string>;
  close(): Promise<void>;
}

export interface Dar03BrowserDriver {
  createSurface(options: {
    name: string;
    viewport: { width: number; height: number };
    displayMode?: "browser" | "standalone";
  }): Promise<Dar03BrowserSurface>;
}

export interface Dar03Context {
  platform: HarnessPlatform;
  overallDeadline: number | Date;
  build: Pick<BuildArtifacts, "clientPath" | "fixturePath">;
  runtime: Pick<RuntimeContext, "root" | "home" | "baseUrl" | "env"> & {
    artifacts: Pick<RuntimeContext["artifacts"], "dir" | "appendText">;
    sessions: Pick<SessionLedger, "track" | "waitForStatus" | "read">;
  };
}

export interface Dar03Pty {
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

export interface Dar03Dependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  createUuid?: () => string;
  createBrowserDriver?: (context: Dar03Context) => Dar03BrowserDriver;
  spawnPty?: (spec: PtySpawnSpec, dependencies: PtyDriverDependencies) => Dar03Pty;
  findSession?: (options: FindSessionOptions) => Promise<SessionMetaLike | undefined>;
  readSessionMeta?: (sessionId: string, home: string) => Promise<SessionMetaLike | undefined>;
  readLocalOutput?: (artifactsDir: string) => Promise<string>;
}

interface SurfaceSize {
  cols: number;
  rows: number;
  marker: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawnPty(spec: PtySpawnSpec, dependencies: PtyDriverDependencies): Dar03Pty {
  return PtyDriver.spawn(spec, dependencies);
}

async function defaultReadLocalOutput(artifactsDir: string): Promise<string> {
  return readText(join(artifactsDir, PTY_OUTPUT_ARTIFACT));
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
  return `DAR-03-${runId}`;
}

function ptySpec(context: Dar03Context, runId: string): PtySpawnSpec {
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
  name: Dar03SubcheckName,
  overallDeadline: number,
  now: () => number
): number {
  const startedAt = now();
  return Math.min(overallDeadline, startedAt + SUBCHECK_TIMEOUTS_MS[name]);
}

function withEvidence(
  status: "passed" | "failed",
  name: Dar03SubcheckName,
  durationMs: number,
  baseEvidence: string[],
  options: { message?: string; evidence?: string[] } = {}
): SubcheckResult {
  const definition = DAR_03_SUBCHECKS_BY_NAME.get(name);
  if (!definition) {
    throw new Error(`Unknown DAR-03 subcheck: ${name}`);
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
  name: Dar03SubcheckName,
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
  surface: Dar03BrowserSurface,
  sessionId: string,
  home: string,
  expectedControllerId: string,
  deadline: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  readSessionMeta: (sessionId: string, home: string) => Promise<SessionMetaLike | undefined>,
  mustDifferFrom?: { cols: number; rows: number }
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
      if (
        mustDifferFrom &&
        size.cols === mustDifferFrom.cols &&
        size.rows === mustDifferFrom.rows
      ) {
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

function surfaceEvidence(
  createdDesktop: boolean,
  createdPwa: boolean
): string[] {
  const evidence: string[] = [];
  if (createdDesktop) {
    evidence.push(
      "browser-surfaces/01-desktop/trace.zip",
      "browser-surfaces/01-desktop/console.log",
      "browser-surfaces/01-desktop/failed-requests.log",
      "browser-surfaces/01-desktop/closing.png"
    );
  }
  if (createdPwa) {
    evidence.push(
      "browser-surfaces/02-pwa/trace.zip",
      "browser-surfaces/02-pwa/console.log",
      "browser-surfaces/02-pwa/failed-requests.log",
      "browser-surfaces/02-pwa/closing.png"
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
  surface: Dar03BrowserSurface | undefined,
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
  pty: Dar03Pty | undefined,
  exitSent: boolean,
  overallDeadline: number,
  now: () => number,
  cleanupErrors: Error[]
): Promise<void> {
  if (!pty || exitSent) {
    return;
  }

  try {
    pty.writeText("q");
    await pty.waitForExit(Math.min(overallDeadline, now() + 5_000));
  } catch (error) {
    cleanupErrors.push(cleanupFailure("PTY cleanup failed", error));
    try {
      pty.kill();
    } catch (killError) {
      cleanupErrors.push(cleanupFailure("PTY cleanup failed", killError));
    }
  }
}

export async function runDar03(
  context: Dar03Context,
  dependencies: Dar03Dependencies = {}
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
  const desktopToken = `dar03-desktop-${runId}`;
  const suppressedLocalToken = `dar03-local-suppressed-${runId}`;
  const pwaToken = `dar03-pwa-${runId}`;
  const localToken = `dar03-local-${runId}`;
  const results: SubcheckResult[] = [];
  let browser: Dar03BrowserDriver | undefined;
  let desktop: Dar03BrowserSurface | undefined;
  let pwa: Dar03BrowserSurface | undefined;
  let pty: Dar03Pty | undefined;
  let spawnFailure: string | undefined;
  let trackedSessionId: string | undefined;
  let localStarted = false;
  let desktopControlled = false;
  let pwaControlled = false;
  let localReclaimed = false;
  let desktopSize: SurfaceSize | undefined;
  let exitSent = false;
  let createdDesktop = false;
  let createdPwa = false;

  const baseEvidence = () => {
    const evidence = [PTY_INPUT_ARTIFACT, PTY_OUTPUT_ARTIFACT];
    if (trackedSessionId) {
      evidence.push(
        sessionMetaEvidencePath(trackedSessionId),
        daemonLogEvidencePath(trackedSessionId)
      );
    }
    evidence.push(...surfaceEvidence(createdDesktop, createdPwa));
    return evidence;
  };

  try {
    pty = spawnPty(ptySpec(context, runId), {
      now,
      appendText: context.runtime.artifacts.appendText.bind(context.runtime.artifacts),
    });
  } catch (error) {
    spawnFailure = `Failed to spawn DAR-03 PTY: ${stringifyError(error)}`;
  }

  results.push(
    await runSubcheck("local-starts-as-controller", now, baseEvidence, async () => {
      if (!pty) {
        throw new Error(impossibleMessage(spawnFailure ?? "PTY unavailable"));
      }

      const deadline = remainingDeadline("local-starts-as-controller", overallDeadline, now);
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
        `Timed out waiting for DAR-03 metadata for ${sessionName(runId)}`
      );

      trackedSessionId = session.id;
      context.runtime.sessions.track(trackedSessionId);
      await context.runtime.sessions.waitForStatus(trackedSessionId, "running", deadline);
      await waitForSessionSize(
        trackedSessionId,
        context.runtime.home,
        deadline,
        { cols: LOCAL_COLS, rows: LOCAL_ROWS },
        now,
        sleep,
        pollIntervalMs,
        readSessionMeta
      );

      localStarted = true;
      return {
        message: `Session ${trackedSessionId} started with local controller at ${LOCAL_COLS}x${LOCAL_ROWS}`,
        evidence: [READY_MARKER, `${LOCAL_COLS}x${LOCAL_ROWS}`],
      };
    })
  );

  const localStartBlocked = () =>
    !pty
      ? spawnFailure ?? "PTY unavailable"
      : localStarted && trackedSessionId
        ? undefined
        : "local-starts-as-controller did not establish an attached running session";

  results.push(
    await runSubcheck(
      "desktop-transfers-control-and-pty-size",
      now,
      baseEvidence,
      async () => {
        const blocked = localStartBlocked();
        if (blocked) {
          throw new Error(impossibleMessage(blocked));
        }

        const deadline = remainingDeadline(
          "desktop-transfers-control-and-pty-size",
          overallDeadline,
          now
        );
        if (!createBrowserDriver) {
          throw new Error("DAR-03 requires createBrowserDriver()");
        }
        browser ??= createBrowserDriver(context);
        desktop ??= await browser.createSurface({
          name: "desktop",
          viewport: { ...DESKTOP_VIEWPORT },
          displayMode: "browser",
        });
        createdDesktop = true;
        await desktop.open(context.runtime.baseUrl, deadline);
        await desktop.openTerminal(trackedSessionId!, deadline);
        await desktop.takeControl(trackedSessionId!, deadline);
        const controllerId = await desktop.controllerId(trackedSessionId!, deadline);
        if (controllerId !== desktop.viewerId) {
          throw new Error(
            `Expected desktop controller ${desktop.viewerId}, received ${controllerId}`
          );
        }
        await pty!.expectScreen(
          (screen) =>
            screen.contents().includes(OVERLAY_MESSAGE) &&
            screen.contents().includes(OVERLAY_HINT),
          deadline
        );
        await desktop.sendTerminalLine(desktopToken);
        await desktop.waitForTerminalText(`DAR_CONTROL_INPUT ${desktopToken}`, deadline);
        desktopSize = await waitForControlledSurfaceSize(
          desktop,
          trackedSessionId!,
          context.runtime.home,
          desktop.viewerId,
          deadline,
          now,
          sleep,
          pollIntervalMs,
          readSessionMeta,
          { cols: LOCAL_COLS, rows: LOCAL_ROWS }
        );
        desktopControlled = true;
        return {
          message: `Desktop surface ${desktop.viewerId} controls ${desktopSize.marker}`,
          evidence: [`DAR_CONTROL_INPUT ${desktopToken}`, desktopSize.marker],
        };
      }
    )
  );

  const desktopBlocked = () =>
    desktopControlled && desktop
      ? undefined
      : "desktop-transfers-control-and-pty-size did not establish a displaced local terminal";

  results.push(
    await runSubcheck(
      "displaced-local-non-space-suppressed",
      now,
      baseEvidence,
      async () => {
        const blocked = desktopBlocked();
        if (blocked) {
          throw new Error(impossibleMessage(blocked));
        }

        const deadline = remainingDeadline(
          "displaced-local-non-space-suppressed",
          overallDeadline,
          now
        );
        pty!.writeText(`${suppressedLocalToken}\r`);
        await pty!.waitForQuiet(LOCAL_QUIET_PERIOD_MS, deadline);
        const localOutput = await readLocalOutput(context.runtime.artifacts.dir);
        const blockedMarker = `DAR_CONTROL_INPUT ${suppressedLocalToken}`;
        if (localOutput.includes(blockedMarker)) {
          throw new Error(`Displaced local input leaked into the attached terminal: ${blockedMarker}`);
        }
        const desktopSnapshot = await desktop!.terminalText();
        if (desktopSnapshot.includes(blockedMarker)) {
          throw new Error(`Displaced local input reached the shared PTY: ${blockedMarker}`);
        }
        return {
          message: `Suppressed displaced local token ${suppressedLocalToken}`,
          evidence: [OVERLAY_HINT, suppressedLocalToken],
        };
      }
    )
  );

  results.push(
    await runSubcheck(
      "simulated-pwa-newest-controller",
      now,
      baseEvidence,
      async () => {
        const blocked = desktopBlocked();
        if (blocked) {
          throw new Error(impossibleMessage(blocked));
        }

        const deadline = remainingDeadline(
          "simulated-pwa-newest-controller",
          overallDeadline,
          now
        );
        if (!createBrowserDriver) {
          throw new Error("DAR-03 requires createBrowserDriver()");
        }
        browser ??= createBrowserDriver(context);
        pwa ??= await browser.createSurface({
          name: "pwa",
          viewport: { ...PWA_VIEWPORT },
          displayMode: "standalone",
        });
        createdPwa = true;
        await pwa.open(context.runtime.baseUrl, deadline);
        await pwa.openTerminal(trackedSessionId!, deadline);
        await pwa.takeControl(trackedSessionId!, deadline);
        const pwaController = await pwa.controllerId(trackedSessionId!, deadline);
        if (pwaController !== pwa.viewerId) {
          throw new Error(`Expected PWA controller ${pwa.viewerId}, received ${pwaController}`);
        }
        const desktopController = await desktop!.controllerId(trackedSessionId!, deadline);
        if (desktopController !== pwa.viewerId) {
          throw new Error(
            `Expected desktop surface to observe controller ${pwa.viewerId}, received ${desktopController}`
          );
        }
        await pwa.sendTerminalLine(pwaToken);
        await pwa.waitForTerminalText(`DAR_CONTROL_INPUT ${pwaToken}`, deadline);
        const pwaSize = await waitForControlledSurfaceSize(
          pwa,
          trackedSessionId!,
          context.runtime.home,
          pwa.viewerId,
          deadline,
          now,
          sleep,
          pollIntervalMs,
          readSessionMeta,
          desktopSize ? { cols: desktopSize.cols, rows: desktopSize.rows } : undefined
        );
        pwaControlled = true;
        return {
          message: `Simulated PWA ${pwa.viewerId} became the newest controller at ${pwaSize.marker}`,
          evidence: [`DAR_CONTROL_INPUT ${pwaToken}`, pwaSize.marker],
        };
      }
    )
  );

  const pwaBlocked = () =>
    pwaControlled && desktop
      ? undefined
      : "pwa-newest-controller-wins did not leave the local terminal displaced";

  results.push(
    await runSubcheck(
      "local-space-reclaims-control",
      now,
      baseEvidence,
      async () => {
        const blocked = pwaBlocked();
        if (blocked) {
          throw new Error(impossibleMessage(blocked));
        }

        const deadline = remainingDeadline(
          "local-space-reclaims-control",
          overallDeadline,
          now
        );
        pty!.writeText(" ");
        await pty!.expectScreen(
          (screen) =>
            screen.contents().includes("DAR_CONTROL_READY") &&
            !screen.contents().includes(OVERLAY_HINT),
          deadline
        );
        await waitForValue(
          deadline,
          now,
          sleep,
          pollIntervalMs,
          async () => {
            const controllerId = await desktop!.controllerId(trackedSessionId!, deadline);
            return controllerId === "local" ? controllerId : undefined;
          },
          "Timed out waiting for the local terminal to reclaim control"
        );
        await waitForSessionSize(
          trackedSessionId!,
          context.runtime.home,
          deadline,
          { cols: LOCAL_COLS, rows: LOCAL_ROWS },
          now,
          sleep,
          pollIntervalMs,
          readSessionMeta
        );
        pty!.writeText(`${localToken}\r`);
        await pty!.expectRaw(`DAR_CONTROL_INPUT ${localToken}`, deadline);
        localReclaimed = true;
        return {
          message: `Local Space reclaimed control and accepted ${localToken}`,
          evidence: ["local", `DAR_CONTROL_INPUT ${localToken}`],
        };
      }
    )
  );

  const localReclaimBlocked = () =>
    localReclaimed ? undefined : "local-space-reclaims-control did not restore local control";

  results.push(
    await runSubcheck("local-resize-authoritative", now, baseEvidence, async () => {
      const blocked = localReclaimBlocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline("local-resize-authoritative", overallDeadline, now);
      pty!.resize(RESIZED_LOCAL_COLS, RESIZED_LOCAL_ROWS);
      const resizeMarker = await waitForValue(
        deadline,
        now,
        sleep,
        pollIntervalMs,
        async () => {
          const output = await readLocalOutput(context.runtime.artifacts.dir);
          const match = output.match(
            new RegExp(`DAR_CONTROL_RESIZE \\d+ ${RESIZED_LOCAL_COLS} ${RESIZED_LOCAL_ROWS}`)
          );
          return match?.[0];
        },
        `Timed out waiting for local resize marker ${RESIZED_LOCAL_COLS}x${RESIZED_LOCAL_ROWS}`
      );
      await pty!.expectScreen(
        (screen) => screen.contents().includes(`size=${RESIZED_LOCAL_COLS}x${RESIZED_LOCAL_ROWS}`),
        deadline
      );
      await waitForSessionSize(
        trackedSessionId!,
        context.runtime.home,
        deadline,
        { cols: RESIZED_LOCAL_COLS, rows: RESIZED_LOCAL_ROWS },
        now,
        sleep,
        pollIntervalMs,
        readSessionMeta
      );

      pty!.writeText("q");
      exitSent = true;
      const exitCode = await pty!.waitForExit(deadline);
      if (exitCode !== 0) {
        throw new Error(`Expected DAR-03 attached client to exit 0, received ${exitCode}`);
      }

      return {
        message: `Local resize restored authoritative PTY size ${RESIZED_LOCAL_COLS}x${RESIZED_LOCAL_ROWS}`,
        evidence: [resizeMarker],
      };
    })
  );

  const cleanupErrors: Error[] = [];
  await closeSurface(pwa, "PWA surface", cleanupErrors);
  await closeSurface(desktop, "Desktop surface", cleanupErrors);
  await cleanupPty(pty, exitSent, overallDeadline, now, cleanupErrors);
  throwCleanupErrors(cleanupErrors, "Failed to finalize DAR-03");

  return results;
}
