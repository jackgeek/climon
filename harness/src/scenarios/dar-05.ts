import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BuildArtifacts } from "../build-cache.js";
import { PtyDriver, type PtyDriverDependencies, type PtySpawnSpec } from "../drivers/pty.js";
import type { RuntimeContext } from "../runtime-supervisor.js";
import type { SessionLedger, SessionStatus } from "../session-ledger.js";
import type { SubcheckDefinition } from "../subchecks.js";
import type { HarnessPlatform, SubcheckResult } from "../types.js";

const LOCAL_COLS = 80;
const LOCAL_ROWS = 24;
const RESIZED_COLS = 100;
const RESIZED_ROWS = 30;
const PTY_INPUT_ARTIFACT = "pty/input.log";
const PTY_OUTPUT_ARTIFACT = "pty/output.log";
const READY_MARKER = "DAR_METADATA_STATIC";
const ATTENTION_IDLE_SECONDS = 1;
const LOCAL_QUIET_PERIOD_MS = 500;

const SUBCHECK_TIMEOUTS_MS = {
  "initial-attention-flag": 30_000,
  "current-token-acknowledgement": 30_000,
  "body-change-reset": 30_000,
  "reflag-after-body-change": 30_000,
  "resize-stickiness": 15_000,
  "stale-token-rejection": 15_000,
  "second-token-acknowledgement": 30_000,
} as const;

export const DAR_05_SUBCHECKS = [
  {
    name: "initial-attention-flag",
    title:
      "Flags the session as needing attention and captures a non-empty attentionMatchedAt token",
  },
  {
    name: "current-token-acknowledgement",
    title: "Acknowledges the current attention token through the browser and clears the flag",
  },
  {
    name: "body-change-reset",
    title: "Resets the attention flag to running when the body changes",
  },
  {
    name: "reflag-after-body-change",
    title: "Re-flags the session as needing attention after the body-change idle period",
  },
  {
    name: "resize-stickiness",
    title: "Preserves the attention token and status across a resize",
  },
  {
    name: "stale-token-rejection",
    title: "Rejects a stale token and leaves the attention flag unchanged",
  },
  {
    name: "second-token-acknowledgement",
    title: "Accepts the current token and clears the attention flag a second time",
  },
] as const satisfies readonly SubcheckDefinition[];

export type Dar05SubcheckName = (typeof DAR_05_SUBCHECKS)[number]["name"];

export const DAR_05_SUBCHECK_NAMES: readonly Dar05SubcheckName[] = DAR_05_SUBCHECKS.map(
  (s) => s.name
);

const DAR_05_SUBCHECKS_BY_NAME = new Map(
  DAR_05_SUBCHECKS.map((s) => [s.name, s] as const)
);

export interface Dar05BrowserSurface {
  readonly name: string;
  readonly viewerId: string;
  open(baseUrl: string, deadline: number): Promise<void>;
  openTerminal(id: string, deadline: number): Promise<void>;
  acknowledgeAttention(id: string, deadline: number): Promise<void>;
  acknowledgeAttentionToken(id: string, token: string, deadline: number): Promise<void>;
  status(id: string, deadline: number): Promise<string | null>;
  waitForDisplaced(id: string, deadline: number): Promise<string>;
  close(): Promise<void>;
}

export interface Dar05BrowserDriver {
  createSurface(options: {
    name: string;
    viewport: { width: number; height: number };
    displayMode?: "browser" | "standalone";
  }): Promise<Dar05BrowserSurface>;
}

export interface Dar05Context {
  platform: HarnessPlatform;
  overallDeadline: number | Date;
  build: Pick<BuildArtifacts, "clientPath" | "fixturePath">;
  runtime: Pick<RuntimeContext, "root" | "home" | "baseUrl" | "env"> & {
    artifacts: Pick<RuntimeContext["artifacts"], "dir" | "appendText">;
    sessions: Pick<SessionLedger, "track" | "waitForStatus" | "read">;
  };
}

export interface Dar05Pty {
  writeText(text: string): void;
  resize(cols: number, rows: number): void;
  expectRaw(marker: string, deadline: number): Promise<void>;
  waitForExit(deadline: number): Promise<number>;
  waitForQuiet(quietPeriodMs: number, deadline: number): Promise<void>;
  kill(): void;
}

interface SessionMetaLike extends Record<string, unknown> {
  id: string;
  status: SessionStatus;
  attentionMatchedAt?: string;
}

interface FindSessionOptions {
  home: string;
  expectedName: string;
}

export interface Dar05Dependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  createUuid?: () => string;
  createBrowserDriver?: (context: Dar05Context) => Dar05BrowserDriver;
  spawnPty?: (spec: PtySpawnSpec, deps: PtyDriverDependencies) => Dar05Pty;
  findSession?: (options: FindSessionOptions) => Promise<SessionMetaLike | undefined>;
  writeConfig?: (home: string, config: unknown) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawnPty(spec: PtySpawnSpec, deps: PtyDriverDependencies): Dar05Pty {
  return PtyDriver.spawn(spec, deps);
}

async function defaultWriteConfig(home: string, config: unknown): Promise<void> {
  await mkdir(home, { recursive: true });
  const configPath = join(home, "config.jsonc");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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
  return `DAR-05-${runId}`;
}

function tokenSuffix(runId: string): string {
  const condensed = runId.replaceAll("-", "");
  return (condensed.length > 0 ? condensed : runId).slice(0, 8);
}

function changeToken(runId: string): string {
  return `dar05-change-${tokenSuffix(runId)}`;
}

function ptySpec(context: Dar05Context, runId: string): PtySpawnSpec {
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
  name: Dar05SubcheckName,
  overallDeadline: number,
  now: () => number
): number {
  return Math.min(overallDeadline, now() + SUBCHECK_TIMEOUTS_MS[name]);
}

function withEvidence(
  status: "passed" | "failed",
  name: Dar05SubcheckName,
  durationMs: number,
  baseEvidence: string[],
  options: { message?: string; evidence?: string[] } = {}
): SubcheckResult {
  const definition = DAR_05_SUBCHECKS_BY_NAME.get(name);
  if (!definition) {
    throw new Error(`Unknown DAR-05 subcheck: ${name}`);
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
  name: Dar05SubcheckName,
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

function assertAttentionToken(token: unknown, context: string): asserts token is string {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      `${context}: expected non-empty attentionMatchedAt, got ${JSON.stringify(token)}`
    );
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

export async function runDar05(
  context: Dar05Context,
  dependencies: Dar05Dependencies = {}
): Promise<SubcheckResult[]> {
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? defaultSleep;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 50;
  const createUuid = dependencies.createUuid ?? randomUUID;
  const createBrowserDriver = dependencies.createBrowserDriver;
  const spawnPty = dependencies.spawnPty ?? defaultSpawnPty;
  const findSession = dependencies.findSession ?? defaultFindSession;
  const writeConfig = dependencies.writeConfig ?? defaultWriteConfig;

  const overallDeadline = asAbsoluteDeadline(context.overallDeadline);
  const runId = createUuid();
  const bodyChangeToken = changeToken(runId);

  const results: SubcheckResult[] = [];
  let browser: Dar05BrowserDriver | undefined;
  let surface: Dar05BrowserSurface | undefined;
  let pty: Dar05Pty | undefined;
  let spawnFailure: string | undefined;
  let trackedSessionId: string | undefined;
  let createdSurface = false;
  let createdSecondSurface = false;
  let localReclaimed = false;
  let exitSent = false;

  // Captured across subchecks
  let initialToken: string | undefined;
  let secondToken: string | undefined;

  const baseEvidence = (): string[] => {
    const evidence = [PTY_INPUT_ARTIFACT, PTY_OUTPUT_ARTIFACT];
    if (trackedSessionId) {
      evidence.push(
        sessionMetaEvidencePath(trackedSessionId),
        daemonLogEvidencePath(trackedSessionId)
      );
    }
    if (createdSurface) {
      evidence.push(
        "browser-surfaces/01-attention-browser/trace.zip",
        "browser-surfaces/01-attention-browser/console.log",
        "browser-surfaces/01-attention-browser/failed-requests.log",
        "browser-surfaces/01-attention-browser/closing.png"
      );
    }
    if (createdSecondSurface) {
      evidence.push(
        "browser-surfaces/02-stale-rejection-browser/trace.zip",
        "browser-surfaces/02-stale-rejection-browser/console.log",
        "browser-surfaces/02-stale-rejection-browser/failed-requests.log",
        "browser-surfaces/02-stale-rejection-browser/closing.png"
      );
    }
    return evidence;
  };

  // Write fast attention config before spawning the PTY.
  try {
    await writeConfig(context.runtime.home, {
      attention: { idleSeconds: ATTENTION_IDLE_SECONDS },
    });
  } catch (error) {
    spawnFailure = `Failed to write attention config: ${stringifyError(error)}`;
  }

  if (!spawnFailure) {
    try {
      pty = spawnPty(ptySpec(context, runId), {
        now,
        appendText: context.runtime.artifacts.appendText.bind(context.runtime.artifacts),
      });
    } catch (error) {
      spawnFailure = `Failed to spawn DAR-05 PTY: ${stringifyError(error)}`;
    }
  }

  // ── Subcheck 1: initial-attention-flag ─────────────────────────────────────
  results.push(
    await runSubcheck("initial-attention-flag", now, baseEvidence, async () => {
      if (!pty) {
        throw new Error(impossibleMessage(spawnFailure ?? "PTY unavailable"));
      }

      const deadline = remainingDeadline("initial-attention-flag", overallDeadline, now);
      await pty.expectRaw(READY_MARKER, deadline);

      const session = await waitForValue(
        deadline,
        now,
        sleep,
        pollIntervalMs,
        async () =>
          findSession({ home: context.runtime.home, expectedName: sessionName(runId) }),
        `Timed out waiting for DAR-05 session metadata for ${sessionName(runId)}`
      );

      trackedSessionId = session.id;
      context.runtime.sessions.track(trackedSessionId);
      await context.runtime.sessions.waitForStatus(trackedSessionId, "running", deadline);

      const attentionMeta = await context.runtime.sessions.waitForStatus(
        trackedSessionId,
        "needs-attention",
        deadline
      );
      const token = attentionMeta.attentionMatchedAt;
      assertAttentionToken(token, "initial-attention-flag");
      initialToken = token;

      return {
        message: `Session flagged as needs-attention with token ${JSON.stringify(token)}`,
        evidence: [`attentionMatchedAt=${token}`],
      };
    })
  );

  const initialFlagBlocked = (): string | undefined =>
    initialToken && trackedSessionId && pty
      ? undefined
      : "initial-attention-flag did not produce a valid attention token";

  // ── Subcheck 2: current-token-acknowledgement ──────────────────────────────
  results.push(
    await runSubcheck("current-token-acknowledgement", now, baseEvidence, async () => {
      const blocked = initialFlagBlocked();
      if (blocked) {
        throw new Error(impossibleMessage(blocked));
      }

      const deadline = remainingDeadline(
        "current-token-acknowledgement",
        overallDeadline,
        now
      );

      if (!createBrowserDriver) {
        throw new Error("DAR-05 requires createBrowserDriver()");
      }
      browser ??= createBrowserDriver(context);
      surface ??= await browser.createSurface({
        name: "attention-browser",
        viewport: { width: 1280, height: 800 },
      });
      createdSurface = true;

      await surface.open(context.runtime.baseUrl, deadline);
      await surface.openTerminal(trackedSessionId!, deadline);
      await surface.acknowledgeAttention(trackedSessionId!, deadline);

      const clearedMeta = await context.runtime.sessions.waitForStatus(
        trackedSessionId!,
        "acknowledged",
        deadline
      );

      // Reclaim local terminal: send Space, wait for browser to be displaced,
      // wait for local terminal to quiet, then close the browser surface so it
      // cannot auto-ack the second attention episode.
      pty!.writeText(" ");
      await surface!.waitForDisplaced(trackedSessionId!, deadline);
      await pty!.waitForQuiet(LOCAL_QUIET_PERIOD_MS, deadline);
      const s1 = surface!;
      surface = undefined;
      await s1.close();
      localReclaimed = true;

      return {
        message: `Acknowledged attention; session status is ${clearedMeta.status}`,
        evidence: [`status=${clearedMeta.status}`],
      };
    })
  );

  const ackBlocked = (): string | undefined =>
    localReclaimed && trackedSessionId && pty
      ? undefined
      : "current-token-acknowledgement did not complete successfully";

  // ── Subcheck 3: body-change-reset ─────────────────────────────────────────
  results.push(
    await runSubcheck("body-change-reset", now, baseEvidence, async () => {
      if (ackBlocked()) {
        throw new Error(impossibleMessage(ackBlocked()!));
      }

      const deadline = remainingDeadline("body-change-reset", overallDeadline, now);
      pty!.writeText(`CHANGE ${bodyChangeToken}\n`);

      const runningMeta = await context.runtime.sessions.waitForStatus(
        trackedSessionId!,
        "running",
        deadline
      );

      const afterMeta = await context.runtime.sessions.read(trackedSessionId!);
      if (afterMeta.attentionMatchedAt !== undefined && afterMeta.attentionMatchedAt !== null) {
        throw new Error(
          `Expected attentionMatchedAt to be cleared after body change, got ${JSON.stringify(
            afterMeta.attentionMatchedAt
          )}`
        );
      }

      return {
        message: `Body change reset attention; status=${runningMeta.status}`,
        evidence: [`CHANGE ${bodyChangeToken}`, `status=${runningMeta.status}`],
      };
    })
  );

  const bodyChangeBlocked = (): string | undefined =>
    trackedSessionId && pty
      ? undefined
      : "body-change-reset did not complete successfully";

  // ── Subcheck 4: reflag-after-body-change ──────────────────────────────────
  results.push(
    await runSubcheck("reflag-after-body-change", now, baseEvidence, async () => {
      if (bodyChangeBlocked()) {
        throw new Error(impossibleMessage(bodyChangeBlocked()!));
      }

      const deadline = remainingDeadline("reflag-after-body-change", overallDeadline, now);
      const reflagMeta = await context.runtime.sessions.waitForStatus(
        trackedSessionId!,
        "needs-attention",
        deadline
      );
      const token = reflagMeta.attentionMatchedAt;
      assertAttentionToken(token, "reflag-after-body-change");

      if (token === initialToken) {
        throw new Error(
          `Expected a different attentionMatchedAt after body change, but got the same token ${JSON.stringify(token)}`
        );
      }
      secondToken = token;

      return {
        message: `Re-flagged with new token ${JSON.stringify(token)}`,
        evidence: [`attentionMatchedAt=${token}`],
      };
    })
  );

  const reflagBlocked = (): string | undefined =>
    secondToken && trackedSessionId && pty
      ? undefined
      : "reflag-after-body-change did not produce a new attention token";

  // ── Subcheck 5: resize-stickiness ─────────────────────────────────────────
  results.push(
    await runSubcheck("resize-stickiness", now, baseEvidence, async () => {
      if (reflagBlocked()) {
        throw new Error(impossibleMessage(reflagBlocked()!));
      }

      pty!.resize(RESIZED_COLS, RESIZED_ROWS);

      // Bounded multi-sample observation window: read RESIZE_OBSERVATION_POLL_COUNT
      // times with sleep between each sample to catch delayed attention mutations.
      const deadline = remainingDeadline("resize-stickiness", overallDeadline, now);
      const RESIZE_OBSERVATION_POLL_COUNT = 3;
      let lastMeta: SessionMetaLike | undefined;

      for (let poll = 0; poll < RESIZE_OBSERVATION_POLL_COUNT; poll++) {
        if (now() >= deadline) break;
        if (poll > 0) {
          await sleep(Math.max(1, Math.min(pollIntervalMs, deadline - now())));
        }
        lastMeta = await context.runtime.sessions.read(trackedSessionId!);
        if (lastMeta.status !== "needs-attention") {
          throw new Error(
            `Expected status to remain needs-attention after resize, got ${JSON.stringify(
              lastMeta.status
            )} on poll ${poll + 1} of ${RESIZE_OBSERVATION_POLL_COUNT}`
          );
        }
        if (lastMeta.attentionMatchedAt !== secondToken) {
          throw new Error(
            `Expected attentionMatchedAt to remain ${JSON.stringify(
              secondToken
            )} after resize, got ${JSON.stringify(lastMeta.attentionMatchedAt)} on poll ${poll + 1} of ${RESIZE_OBSERVATION_POLL_COUNT}`
          );
        }
      }

      if (!lastMeta) {
        throw new Error("Unable to read session state for resize stickiness verification (deadline reached before first poll)");
      }

      return {
        message: `Resize did not disturb attention flag; token=${JSON.stringify(secondToken)}`,
        evidence: [
          `resize=${RESIZED_COLS}x${RESIZED_ROWS}`,
          `status=${lastMeta.status}`,
          `attentionMatchedAt=${lastMeta.attentionMatchedAt}`,
        ],
      };
    })
  );

  const resizeStickyBlocked = (): string | undefined =>
    secondToken && trackedSessionId && pty
      ? undefined
      : "resize-stickiness did not complete successfully";

  // ── Subcheck 6: stale-token-rejection ─────────────────────────────────────
  results.push(
    await runSubcheck("stale-token-rejection", now, baseEvidence, async () => {
      if (resizeStickyBlocked()) {
        throw new Error(impossibleMessage(resizeStickyBlocked()!));
      }

      const deadline = remainingDeadline("stale-token-rejection", overallDeadline, now);

      if (!browser) {
        throw new Error(impossibleMessage("browser driver not available for stale-token-rejection"));
      }

      // Create a fresh surface and open ONLY the dashboard base URL — do NOT open the terminal
      // before injecting the stale token.  Opening the terminal would make the browser a viewer
      // and it could auto-ack the current attention episode, invalidating the stale-rejection test.
      // Use a phone viewport with standalone display mode to simulate a PWA/mobile context: on
      // mobile the active session is not terminalVisible until maximized, so the browser cannot
      // auto-ack the second attention episode before the stale token is injected.
      surface = await browser.createSurface({
        name: "stale-rejection-browser",
        viewport: { width: 390, height: 844 },
        displayMode: "standalone",
      });
      createdSecondSurface = true;
      await surface.open(context.runtime.baseUrl, deadline);

      // Send the STALE token (initialToken from the first attention episode).
      await surface.acknowledgeAttentionToken(trackedSessionId!, initialToken!, deadline);

      // Observe continuously: poll STALE_OBSERVATION_POLL_COUNT times with sleep(pollIntervalMs)
      // between each read. Fails immediately if any sample shows the flag was incorrectly
      // cleared. Uses injected now/sleep/pollInterval so fake-clock tests stay fast.
      const STALE_OBSERVATION_POLL_COUNT = 3;
      let afterStaleMeta: SessionMetaLike | undefined;
      for (let poll = 0; poll < STALE_OBSERVATION_POLL_COUNT; poll++) {
        if (now() >= deadline) break;
        await sleep(Math.max(1, Math.min(pollIntervalMs, deadline - now())));
        afterStaleMeta = await context.runtime.sessions.read(trackedSessionId!);
        if (afterStaleMeta.status !== "needs-attention") {
          throw new Error(
            `Stale token should have been rejected; status became ${JSON.stringify(
              afterStaleMeta.status
            )} on poll ${poll + 1} of ${STALE_OBSERVATION_POLL_COUNT}`
          );
        }
        if (afterStaleMeta.attentionMatchedAt !== secondToken) {
          throw new Error(
            `attentionMatchedAt should remain ${JSON.stringify(
              secondToken
            )} after stale ack, got ${JSON.stringify(afterStaleMeta.attentionMatchedAt)} on poll ${poll + 1} of ${STALE_OBSERVATION_POLL_COUNT}`
          );
        }
      }
      if (!afterStaleMeta) {
        throw new Error("Unable to read session state for stale token verification (deadline reached before first poll)");
      }

      return {
        message: `Stale token ${JSON.stringify(initialToken)} was rejected; current token ${JSON.stringify(secondToken)} unchanged across ${STALE_OBSERVATION_POLL_COUNT} polls`,
        evidence: [
          `stale-token=${initialToken}`,
          `status=${afterStaleMeta.status}`,
          `attentionMatchedAt=${afterStaleMeta.attentionMatchedAt}`,
        ],
      };
    })
  );

  const staleBlocked = (): string | undefined =>
    secondToken && trackedSessionId && surface
      ? undefined
      : "stale-token-rejection did not complete successfully";

  // ── Subcheck 7: second-token-acknowledgement ───────────────────────────────
  results.push(
    await runSubcheck("second-token-acknowledgement", now, baseEvidence, async () => {
      if (staleBlocked()) {
        throw new Error(impossibleMessage(staleBlocked()!));
      }

      const deadline = remainingDeadline("second-token-acknowledgement", overallDeadline, now);
      // Send the current (second) token directly on the standing phone standalone surface.
      // This surface never opened the terminal so it has no viewer/controller role — the
      // server validates the token server-side and acknowledges without needing a sidebar poll.
      await surface!.acknowledgeAttentionToken(trackedSessionId!, secondToken!, deadline);

      const finalMeta = await context.runtime.sessions.waitForStatus(
        trackedSessionId!,
        "acknowledged",
        deadline
      );

      return {
        message: `Second acknowledgement accepted; status=${finalMeta.status}`,
        evidence: [`status=${finalMeta.status}`],
      };
    })
  );

  // ── Cleanup ────────────────────────────────────────────────────────────────
  const cleanupErrors: Error[] = [];

  // surface2 never opened the terminal so it never became controller — no reclaim needed.
  // Simply close the surface then send EXIT under local control.
  if (surface) {
    try {
      await surface.close();
    } catch (error) {
      cleanupErrors.push(cleanupFailure("browser surface close failed", error));
    }
  }

  if (pty && !exitSent) {
    const cleanupDeadline = Math.min(overallDeadline, now() + 5_000);
    try {
      pty.writeText("EXIT\n");
      exitSent = true;
      await pty.waitForExit(cleanupDeadline);
    } catch (error) {
      cleanupErrors.push(cleanupFailure("PTY EXIT failed", error));
      try {
        pty.kill();
      } catch (killError) {
        cleanupErrors.push(cleanupFailure("PTY kill failed", killError));
      }
    }
  }

  throwCleanupErrors(cleanupErrors, "DAR-05 cleanup encountered multiple errors");
  return results;
}
