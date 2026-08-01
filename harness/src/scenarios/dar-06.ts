import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { BuildArtifacts } from "../build-cache.js";
import { PtyDriver, type PtyDriverDependencies, type PtySpawnSpec } from "../drivers/pty.js";
import type { RuntimeContext } from "../runtime-supervisor.js";
import type { SessionLedger, SessionStatus } from "../session-ledger.js";
import type { SubcheckDefinition } from "../subchecks.js";
import type { HarnessPlatform, SubcheckResult } from "../types.js";

const LOCAL_COLS = 80;
const LOCAL_ROWS = 24;
const PTY_INPUT_ARTIFACT = "pty/input.log";
const PTY_OUTPUT_ARTIFACT = "pty/output.log";
const READY_MARKER = "DAR_METADATA_STATIC";

const SUBCHECK_TIMEOUTS_MS = {
  "osc-0-title": 20_000,
  "osc-2-title": 15_000,
  "progress-normal": 15_000,
  "progress-clear": 15_000,
  "progress-indeterminate": 15_000,
  "progress-error": 15_000,
  "progress-warning": 15_000,
  "raw-sequence-passthrough": 30_000,
} as const;

export const DAR_06_SUBCHECKS = [
  {
    name: "osc-0-title",
    title: "OSC 0 emitted title appears in session metadata and browser UI",
  },
  {
    name: "osc-2-title",
    title: "OSC 2 emitted title overrides to match in session metadata and browser UI",
  },
  {
    name: "progress-normal",
    title: "PROGRESS state 1 value 42 sets normal determinate progress in metadata and browser",
  },
  {
    name: "progress-clear",
    title: "CLEAR_PROGRESS removes progress state from metadata and browser",
  },
  {
    name: "progress-indeterminate",
    title: "PROGRESS state 3 sets indeterminate progress in metadata and browser with no percent",
  },
  {
    name: "progress-error",
    title: "PROGRESS state 2 sets error progress in metadata and browser with no percent",
  },
  {
    name: "progress-warning",
    title: "PROGRESS state 4 sets warning progress in metadata and browser with no percent",
  },
  {
    name: "raw-sequence-passthrough",
    title:
      "Final scrollback after process exit preserves raw OSC 0, OSC 2, and OSC 9;4 sequences",
  },
] as const satisfies readonly SubcheckDefinition[];

export type Dar06SubcheckName = (typeof DAR_06_SUBCHECKS)[number]["name"];

export const DAR_06_SUBCHECK_NAMES: readonly Dar06SubcheckName[] = DAR_06_SUBCHECKS.map(
  (s) => s.name
);

const DAR_06_SUBCHECKS_BY_NAME = new Map(
  DAR_06_SUBCHECKS.map((s) => [s.name, s] as const)
);

export interface Dar06BrowserSurfaceProgress {
  state: string | null;
  percent: number | null;
}

export interface Dar06BrowserSurface {
  readonly name: string;
  readonly viewerId: string;
  open(baseUrl: string, deadline: number): Promise<void>;
  openTerminal(id: string, deadline: number): Promise<void>;
  sendTerminalLine(text: string): Promise<void>;
  waitForTerminalText(text: string, deadline: number): Promise<void>;
  title(id: string, deadline: number): Promise<string>;
  progress(id: string, deadline: number): Promise<Dar06BrowserSurfaceProgress>;
  close(): Promise<void>;
}

export interface Dar06BrowserDriver {
  createSurface(options: {
    name: string;
    viewport: { width: number; height: number };
  }): Promise<Dar06BrowserSurface>;
}

export interface Dar06Context {
  platform: HarnessPlatform;
  overallDeadline: number | Date;
  build: Pick<BuildArtifacts, "clientPath" | "fixturePath">;
  runtime: Pick<RuntimeContext, "root" | "home" | "baseUrl" | "env"> & {
    artifacts: Pick<RuntimeContext["artifacts"], "dir" | "appendText">;
    sessions: Pick<
      SessionLedger,
      "track" | "waitForStatus" | "waitForTerminalStatus" | "read"
    >;
  };
}

export interface Dar06Pty {
  writeText(text: string): void;
  expectRaw(marker: string, deadline: number): Promise<void>;
  waitForExit(deadline: number): Promise<number>;
  kill(): void;
}

interface Dar06ProgressMeta {
  state: string;
  value?: number;
}

interface SessionMetaLike extends Record<string, unknown> {
  id: string;
  status: SessionStatus;
  terminalTitle?: string | null;
  progress?: Dar06ProgressMeta | null;
}

interface FindSessionOptions {
  home: string;
  expectedName: string;
}

export interface Dar06Dependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  createUuid?: () => string;
  createBrowserDriver?: (context: Dar06Context) => Dar06BrowserDriver;
  spawnPty?: (spec: PtySpawnSpec, deps: PtyDriverDependencies) => Dar06Pty;
  findSession?: (options: FindSessionOptions) => Promise<SessionMetaLike | undefined>;
  readScrollback?: (home: string, id: string) => Promise<string>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawnPty(spec: PtySpawnSpec, deps: PtyDriverDependencies): Dar06Pty {
  return PtyDriver.spawn(spec, deps);
}

async function defaultFindSession(
  options: FindSessionOptions
): Promise<SessionMetaLike | undefined> {
  let entries: string[];
  try {
    const { readdir, readFile } = await import("node:fs/promises");
    entries = await readdir(join(options.home, "sessions"));
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const id = entry.slice(0, -".json".length);
      try {
        const raw = await readFile(join(options.home, "sessions", `${id}.json`), "utf8");
        const meta = JSON.parse(raw) as SessionMetaLike;
        if (meta.name === options.expectedName || meta.id === options.expectedName) {
          return meta;
        }
      } catch {
        // Skip unreadable metadata files.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return undefined;
}

async function defaultReadScrollback(home: string, id: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const scrollbackPath = join(home, "sessions", `${id}.scrollback`);
  try {
    return await readFile(scrollbackPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
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
  return `DAR-06-${runId}`;
}

function titleToken(runId: string, variant: "t0" | "t2"): string {
  const condensed = runId.replaceAll("-", "").slice(0, 8);
  return `dar06-${variant}-${condensed}`;
}

function ptySpec(context: Dar06Context, runId: string): PtySpawnSpec {
  const fixturePath = resolve(context.build.fixturePath);
  const clientPath = resolve(context.build.clientPath);
  return {
    file: clientPath,
    args: ["run", "--name", sessionName(runId), fixturePath, "metadata-probe"],
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
  name: Dar06SubcheckName,
  overallDeadline: number,
  now: () => number
): number {
  return Math.min(overallDeadline, now() + SUBCHECK_TIMEOUTS_MS[name]);
}

function withEvidence(
  status: "passed" | "failed",
  name: Dar06SubcheckName,
  durationMs: number,
  baseEvidence: string[],
  options: { message?: string; evidence?: string[] } = {}
): SubcheckResult {
  const definition = DAR_06_SUBCHECKS_BY_NAME.get(name);
  if (!definition) {
    throw new Error(`Unknown DAR-06 subcheck: ${name}`);
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
  name: Dar06SubcheckName,
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

/**
 * Poll until both a metadata condition and a browser condition are satisfied.
 * Returns the first pair of matching values. The `checkMeta` and `checkBrowser`
 * functions should return `undefined` when the condition is not yet satisfied.
 */
async function waitForBothAgreement<MetaR, BrowserR>(
  deadline: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  checkMeta: () => Promise<MetaR | undefined>,
  checkBrowser: () => Promise<BrowserR | undefined>,
  timeoutMessage: string
): Promise<{ meta: MetaR; browser: BrowserR }> {
  while (true) {
    const metaResult = await checkMeta();
    if (metaResult !== undefined) {
      const browserResult = await checkBrowser();
      if (browserResult !== undefined) {
        return { meta: metaResult, browser: browserResult };
      }
    }
    if (now() >= deadline) {
      throw new Error(timeoutMessage);
    }
    await sleep(Math.max(1, Math.min(pollIntervalMs, deadline - now())));
  }
}

function sessionMetaEvidencePath(id: string): string {
  return `home/sessions/${id}.json`;
}

function daemonLogEvidencePath(id: string): string {
  return `home/logs/daemon/${id}.log`;
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
  throw new Error(errors.map((e) => e.message).join("; "), {
    cause: new AggregateError(errors, aggregateMessage),
  });
}

export async function runDar06(
  context: Dar06Context,
  dependencies: Dar06Dependencies = {}
): Promise<SubcheckResult[]> {
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? defaultSleep;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 50;
  const createUuid = dependencies.createUuid ?? randomUUID;
  const createBrowserDriver = dependencies.createBrowserDriver;
  const spawnPty = dependencies.spawnPty ?? defaultSpawnPty;
  const findSession = dependencies.findSession ?? defaultFindSession;
  const readScrollback = dependencies.readScrollback ?? defaultReadScrollback;

  const overallDeadline = asAbsoluteDeadline(context.overallDeadline);
  const runId = createUuid();
  const t0Token = titleToken(runId, "t0");
  const t2Token = titleToken(runId, "t2");

  const results: SubcheckResult[] = [];
  let surface: Dar06BrowserSurface | undefined;
  let pty: Dar06Pty | undefined;
  let spawnFailure: string | undefined;
  let trackedSessionId: string | undefined;
  let surfaceOpened = false;
  let exitSent = false;

  // Flags set when each subcheck passes.
  let osc0Confirmed = false;
  let osc2Confirmed = false;
  let progressNormalConfirmed = false;
  let progressClearedConfirmed = false;
  let progressIndeterminateConfirmed = false;
  let progressErrorConfirmed = false;
  let progressWarningConfirmed = false;

  const baseEvidence = (): string[] => {
    const evidence = [PTY_INPUT_ARTIFACT, PTY_OUTPUT_ARTIFACT];
    if (trackedSessionId) {
      evidence.push(
        sessionMetaEvidencePath(trackedSessionId),
        daemonLogEvidencePath(trackedSessionId)
      );
    }
    if (surfaceOpened) {
      evidence.push(
        "browser-surfaces/01-title-progress-browser/trace.zip",
        "browser-surfaces/01-title-progress-browser/console.log",
        "browser-surfaces/01-title-progress-browser/failed-requests.log",
        "browser-surfaces/01-title-progress-browser/closing.png"
      );
    }
    return evidence;
  };

  // Spawn the PTY up front.
  if (!spawnFailure) {
    try {
      pty = spawnPty(ptySpec(context, runId), {
        now,
        appendText: context.runtime.artifacts.appendText.bind(context.runtime.artifacts),
      });
    } catch (error) {
      spawnFailure = `Failed to spawn DAR-06 PTY: ${stringifyError(error)}`;
    }
  }

  // ── Subcheck 1: osc-0-title ────────────────────────────────────────────────
  results.push(
    await runSubcheck("osc-0-title", now, baseEvidence, async () => {
      if (!pty) {
        throw new Error(impossibleMessage(spawnFailure ?? "PTY unavailable"));
      }

      const deadline = remainingDeadline("osc-0-title", overallDeadline, now);

      // Wait for fixture to emit the ready marker.
      await pty.expectRaw(READY_MARKER, deadline);

      // Discover and track the session.
      const session = await waitForValue(
        deadline,
        now,
        sleep,
        pollIntervalMs,
        async () =>
          findSession({ home: context.runtime.home, expectedName: sessionName(runId) }),
        `Timed out waiting for DAR-06 session metadata for ${sessionName(runId)}`
      );
      trackedSessionId = session.id;
      context.runtime.sessions.track(trackedSessionId);
      await context.runtime.sessions.waitForStatus(trackedSessionId, "running", deadline);

      // Open the browser terminal (browser becomes the controller).
      if (!createBrowserDriver) {
        throw new Error("DAR-06 requires createBrowserDriver()");
      }
      const browser = createBrowserDriver(context);
      surface = await browser.createSurface({
        name: "title-progress-browser",
        viewport: { width: 1280, height: 800 },
      });
      surfaceOpened = true;
      await surface.open(context.runtime.baseUrl, deadline);
      await surface.openTerminal(trackedSessionId, deadline);

      // Send OSC 0 title command through the browser terminal.
      await surface.sendTerminalLine(`TITLE0 ${t0Token}`);

      // Wait for the fixture to confirm the OSC was emitted (via browser terminal output,
      // since the browser owns control and local PTY cannot see the marker).
      await surface.waitForTerminalText("DAR_METADATA_OSC_EMITTED TITLE0", deadline);

      // Poll until both metadata and browser reflect the new title.
      const { meta, browser: browserTitle } = await waitForBothAgreement(
        deadline,
        now,
        sleep,
        pollIntervalMs,
        async () => {
          const m = (await context.runtime.sessions.read(
            trackedSessionId!
          )) as SessionMetaLike;
          return typeof m.terminalTitle === "string" && m.terminalTitle.includes(t0Token) ? m.terminalTitle : undefined;
        },
        async () => {
          const t = await surface!.title(trackedSessionId!, deadline);
          return t.includes(t0Token) ? t : undefined;
        },
        `Timed out waiting for OSC 0 title "${t0Token}" to appear in metadata and browser`
      );

      osc0Confirmed = true;
      return {
        message: `OSC 0 title "${t0Token}" visible in metadata and browser`,
        evidence: [`metadata.terminalTitle=${meta}`, `browser.title=${browserTitle}`],
      };
    })
  );

  const prereqBlocked = (): string | undefined =>
    trackedSessionId && pty && surface
      ? undefined
      : spawnFailure ?? "PTY or browser surface not ready";

  const osc2Blocked = (): string | undefined =>
    osc0Confirmed ? undefined : "osc-0-title did not complete";

  const progressNormalBlocked = (): string | undefined =>
    osc2Confirmed ? undefined : "osc-2-title did not complete";

  const progressClearBlocked = (): string | undefined =>
    progressNormalConfirmed ? undefined : "progress-normal did not complete";

  const progressIndeterminateBlocked = (): string | undefined =>
    progressClearedConfirmed ? undefined : "progress-clear did not complete";

  const progressErrorBlocked = (): string | undefined =>
    progressIndeterminateConfirmed ? undefined : "progress-indeterminate did not complete";

  const progressWarningBlocked = (): string | undefined =>
    progressErrorConfirmed ? undefined : "progress-error did not complete";

  const passthroughBlocked = (): string | undefined =>
    progressWarningConfirmed ? undefined : "progress-warning did not complete";

  // ── Subcheck 2: osc-2-title ────────────────────────────────────────────────
  results.push(
    await runSubcheck("osc-2-title", now, baseEvidence, async () => {
      const blocked = prereqBlocked() ?? osc2Blocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline("osc-2-title", overallDeadline, now);

      await surface!.sendTerminalLine(`TITLE2 ${t2Token}`);
      await surface!.waitForTerminalText("DAR_METADATA_OSC_EMITTED TITLE2", deadline);

      const { meta, browser: browserTitle } = await waitForBothAgreement(
        deadline,
        now,
        sleep,
        pollIntervalMs,
        async () => {
          const m = (await context.runtime.sessions.read(
            trackedSessionId!
          )) as SessionMetaLike;
          return typeof m.terminalTitle === "string" && m.terminalTitle.includes(t2Token) ? m.terminalTitle : undefined;
        },
        async () => {
          const t = await surface!.title(trackedSessionId!, deadline);
          return t.includes(t2Token) ? t : undefined;
        },
        `Timed out waiting for OSC 2 title "${t2Token}" to appear in metadata and browser`
      );

      osc2Confirmed = true;
      return {
        message: `OSC 2 title "${t2Token}" overrides previous in metadata and browser`,
        evidence: [`metadata.terminalTitle=${meta}`, `browser.title=${browserTitle}`],
      };
    })
  );

  // ── Subcheck 3: progress-normal ────────────────────────────────────────────
  results.push(
    await runSubcheck("progress-normal", now, baseEvidence, async () => {
      const blocked = prereqBlocked() ?? progressNormalBlocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline("progress-normal", overallDeadline, now);

      await surface!.sendTerminalLine("PROGRESS 1 42");
      await surface!.waitForTerminalText("DAR_METADATA_OSC_EMITTED PROGRESS 1 42", deadline);

      const { meta, browser: browserProgress } = await waitForBothAgreement(
        deadline,
        now,
        sleep,
        pollIntervalMs,
        async () => {
          const m = (await context.runtime.sessions.read(
            trackedSessionId!
          )) as SessionMetaLike;
          const p = m.progress;
          return p && p.state === "normal" && p.value === 42 ? p : undefined;
        },
        async () => {
          const p = await surface!.progress(trackedSessionId!, deadline);
          return p.state === "normal" && p.percent === 42 ? p : undefined;
        },
        "Timed out waiting for normal progress (state=normal, value=42) in metadata and browser"
      );

      progressNormalConfirmed = true;
      return {
        message: `Normal progress visible: metadata.state=${meta.state} value=${String(meta.value)}, browser.state=${browserProgress.state} percent=${String(browserProgress.percent)}`,
        evidence: [
          `metadata.progress.state=${meta.state}`,
          `metadata.progress.value=${String(meta.value)}`,
          `browser.progress.state=${browserProgress.state}`,
          `browser.progress.percent=${String(browserProgress.percent)}`,
        ],
      };
    })
  );

  // ── Subcheck 4: progress-clear ─────────────────────────────────────────────
  results.push(
    await runSubcheck("progress-clear", now, baseEvidence, async () => {
      const blocked = prereqBlocked() ?? progressClearBlocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline("progress-clear", overallDeadline, now);

      await surface!.sendTerminalLine("CLEAR_PROGRESS");
      await surface!.waitForTerminalText("DAR_METADATA_OSC_EMITTED CLEAR_PROGRESS", deadline);

      await waitForBothAgreement(
        deadline,
        now,
        sleep,
        pollIntervalMs,
        async () => {
          const m = (await context.runtime.sessions.read(
            trackedSessionId!
          )) as SessionMetaLike;
          return m.progress === null || m.progress === undefined ? true : undefined;
        },
        async () => {
          const p = await surface!.progress(trackedSessionId!, deadline);
          return p.state === null && p.percent === null ? true : undefined;
        },
        "Timed out waiting for progress to be cleared in metadata and browser"
      );

      progressClearedConfirmed = true;
      return {
        message: "Progress cleared: metadata.progress is absent/null, browser state/percent are null",
        evidence: ["metadata.progress=absent", "browser.progress.state=null", "browser.progress.percent=null"],
      };
    })
  );

  // ── Subcheck 5: progress-indeterminate ────────────────────────────────────
  results.push(
    await runSubcheck("progress-indeterminate", now, baseEvidence, async () => {
      const blocked = prereqBlocked() ?? progressIndeterminateBlocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline("progress-indeterminate", overallDeadline, now);

      await surface!.sendTerminalLine("PROGRESS 3 0");
      await surface!.waitForTerminalText("DAR_METADATA_OSC_EMITTED PROGRESS 3 0", deadline);

      const { meta, browser: browserProgress } = await waitForBothAgreement(
        deadline,
        now,
        sleep,
        pollIntervalMs,
        async () => {
          const m = (await context.runtime.sessions.read(
            trackedSessionId!
          )) as SessionMetaLike;
          const p = m.progress;
          return p && p.state === "indeterminate" && p.value == null ? p : undefined;
        },
        async () => {
          const p = await surface!.progress(trackedSessionId!, deadline);
          return p.state === "indeterminate" ? p : undefined;
        },
        "Timed out waiting for indeterminate progress in metadata and browser"
      );

      if (browserProgress.percent !== null) {
        throw new Error(
          `Expected browser.progress.percent to be null for indeterminate, got ${JSON.stringify(browserProgress.percent)}`
        );
      }

      progressIndeterminateConfirmed = true;
      return {
        message: `Indeterminate progress: metadata.state=${meta.state}, browser.state=${browserProgress.state} percent=${String(browserProgress.percent)}`,
        evidence: [
          `metadata.progress.state=${meta.state}`,
          `browser.progress.state=${browserProgress.state}`,
          `browser.progress.percent=${String(browserProgress.percent)}`,
        ],
      };
    })
  );

  // ── Subcheck 6: progress-error ─────────────────────────────────────────────
  results.push(
    await runSubcheck("progress-error", now, baseEvidence, async () => {
      const blocked = prereqBlocked() ?? progressErrorBlocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline("progress-error", overallDeadline, now);

      await surface!.sendTerminalLine("PROGRESS 2 0");
      await surface!.waitForTerminalText("DAR_METADATA_OSC_EMITTED PROGRESS 2 0", deadline);

      const { meta, browser: browserProgress } = await waitForBothAgreement(
        deadline,
        now,
        sleep,
        pollIntervalMs,
        async () => {
          const m = (await context.runtime.sessions.read(
            trackedSessionId!
          )) as SessionMetaLike;
          const p = m.progress;
          return p && p.state === "error" && p.value == null ? p : undefined;
        },
        async () => {
          const p = await surface!.progress(trackedSessionId!, deadline);
          return p.state === "error" ? p : undefined;
        },
        "Timed out waiting for error progress in metadata and browser"
      );

      if (browserProgress.percent !== null) {
        throw new Error(
          `Expected browser.progress.percent to be null for error, got ${JSON.stringify(browserProgress.percent)}`
        );
      }

      progressErrorConfirmed = true;
      return {
        message: `Error progress: metadata.state=${meta.state}, browser.state=${browserProgress.state} percent=${String(browserProgress.percent)}`,
        evidence: [
          `metadata.progress.state=${meta.state}`,
          `browser.progress.state=${browserProgress.state}`,
          `browser.progress.percent=${String(browserProgress.percent)}`,
        ],
      };
    })
  );

  // ── Subcheck 7: progress-warning ───────────────────────────────────────────
  results.push(
    await runSubcheck("progress-warning", now, baseEvidence, async () => {
      const blocked = prereqBlocked() ?? progressWarningBlocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline("progress-warning", overallDeadline, now);

      await surface!.sendTerminalLine("PROGRESS 4 0");
      await surface!.waitForTerminalText("DAR_METADATA_OSC_EMITTED PROGRESS 4 0", deadline);

      const { meta, browser: browserProgress } = await waitForBothAgreement(
        deadline,
        now,
        sleep,
        pollIntervalMs,
        async () => {
          const m = (await context.runtime.sessions.read(
            trackedSessionId!
          )) as SessionMetaLike;
          const p = m.progress;
          return p && p.state === "warning" && p.value == null ? p : undefined;
        },
        async () => {
          const p = await surface!.progress(trackedSessionId!, deadline);
          return p.state === "warning" ? p : undefined;
        },
        "Timed out waiting for warning progress in metadata and browser"
      );

      if (browserProgress.percent !== null) {
        throw new Error(
          `Expected browser.progress.percent to be null for warning, got ${JSON.stringify(browserProgress.percent)}`
        );
      }

      progressWarningConfirmed = true;
      return {
        message: `Warning progress: metadata.state=${meta.state}, browser.state=${browserProgress.state} percent=${String(browserProgress.percent)}`,
        evidence: [
          `metadata.progress.state=${meta.state}`,
          `browser.progress.state=${browserProgress.state}`,
          `browser.progress.percent=${String(browserProgress.percent)}`,
        ],
      };
    })
  );

  // ── Subcheck 8: raw-sequence-passthrough ───────────────────────────────────
  results.push(
    await runSubcheck("raw-sequence-passthrough", now, baseEvidence, async () => {
      const blocked = prereqBlocked() ?? passthroughBlocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline("raw-sequence-passthrough", overallDeadline, now);

      // Send EXIT through the browser terminal (browser owns control).
      await surface!.sendTerminalLine("EXIT");
      exitSent = true;

      // Wait for the daemon to finalize the session.
      await context.runtime.sessions.waitForTerminalStatus(trackedSessionId!, deadline);

      // Read the final scrollback file.
      const scrollback = await readScrollback(context.runtime.home, trackedSessionId!);

      const missing: string[] = [];
      if (!scrollback.includes("\x1b]0;")) {
        missing.push("ESC ]0; (OSC 0 title)");
      }
      if (!scrollback.includes("\x1b]2;")) {
        missing.push("ESC ]2; (OSC 2 title)");
      }
      if (!scrollback.includes("\x1b]9;4;")) {
        missing.push("ESC ]9;4; (OSC 9;4 progress)");
      }

      if (missing.length > 0) {
        throw new Error(
          `Final scrollback is missing raw OSC sequences: ${missing.join(", ")}. ` +
            `Scrollback length: ${scrollback.length} bytes.`
        );
      }

      const oscCount = {
        osc0: (scrollback.match(/\x1b]0;/g) ?? []).length,
        osc2: (scrollback.match(/\x1b]2;/g) ?? []).length,
        osc94: (scrollback.match(/\x1b]9;4;/g) ?? []).length,
      };

      return {
        message:
          `Raw OSC sequences preserved in scrollback: ESC]0; ×${oscCount.osc0}, ` +
          `ESC]2; ×${oscCount.osc2}, ESC]9;4; ×${oscCount.osc94}`,
        evidence: [
          `scrollback.length=${scrollback.length}`,
          `osc0-count=${oscCount.osc0}`,
          `osc2-count=${oscCount.osc2}`,
          `osc94-count=${oscCount.osc94}`,
        ],
      };
    })
  );

  // ── Cleanup ────────────────────────────────────────────────────────────────
  const cleanupErrors: Error[] = [];
  const cleanupDeadline = Math.min(overallDeadline, now() + 5_000);

  if (pty && !exitSent) {
    // EXIT was not yet sent (scenario failed before subcheck 8).
    // The browser terminal owns control, so prefer sending EXIT through it.
    if (surface) {
      try {
        await surface.sendTerminalLine("EXIT");
        exitSent = true;
        await pty.waitForExit(cleanupDeadline);
      } catch (error) {
        cleanupErrors.push(cleanupFailure("cleanup EXIT via browser failed", error));
        try {
          pty.kill();
        } catch (killError) {
          cleanupErrors.push(cleanupFailure("PTY kill failed", killError));
        }
      }
    } else {
      // No surface available — write directly to PTY stdin.
      try {
        pty.writeText("EXIT\n");
        exitSent = true;
        await pty.waitForExit(cleanupDeadline);
      } catch (error) {
        cleanupErrors.push(cleanupFailure("cleanup PTY EXIT failed", error));
        try {
          pty.kill();
        } catch (killError) {
          cleanupErrors.push(cleanupFailure("PTY kill failed", killError));
        }
      }
    }
  } else if (pty && exitSent) {
    // EXIT was sent in subcheck 8; the PTY should be exiting or already exited.
    try {
      await pty.waitForExit(cleanupDeadline);
    } catch (error) {
      cleanupErrors.push(cleanupFailure("PTY exit wait failed after EXIT", error));
      try {
        pty.kill();
      } catch (killError) {
        cleanupErrors.push(cleanupFailure("PTY kill failed", killError));
      }
    }
  }

  if (surface) {
    try {
      await surface.close();
    } catch (error) {
      cleanupErrors.push(cleanupFailure("browser surface close failed", error));
    }
  }

  throwCleanupErrors(cleanupErrors, "DAR-06 cleanup encountered multiple errors");
  return results;
}
