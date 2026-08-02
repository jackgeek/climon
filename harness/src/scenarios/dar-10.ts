/**
 * DAR-10 — Actor-to-legacy rollback via `CLIMON_SESSION_ENGINE`.
 *
 * Seven subchecks:
 *
 *   default-legacy-engine
 *     – PTY-attached `lifecycle-probe engine-echo` with CLIMON_SESSION_ENGINE
 *       unset; asserts DAR_ENGINE_ECHO marker in output, status=completed,
 *       exitCode=0, nonempty completedAt, marker in final scrollback.
 *
 *   explicit-actor-engine
 *     – Same with CLIMON_SESSION_ENGINE=actor.
 *
 *   explicit-legacy-rollback
 *     – Same with CLIMON_SESSION_ENGINE=legacy.
 *
 *   external-parity
 *     – Compares normalized output, status, exitCode, and final scrollback
 *       across all three variants; asserts they are identical.
 *
 *   invalid-attached-diagnostic
 *     – PTY-attached run with CLIMON_SESSION_ENGINE=future; asserts the exact
 *       diagnostic text is visible in PTY output and the process exits nonzero.
 *
 *   invalid-headless-diagnostic
 *     – Headless run with CLIMON_SESSION_ENGINE=future; parses the session ID
 *       from launcher stdout; polls sessions/<id>.log for the exact diagnostic
 *       (engine selection fails before daemon logger initializes).
 *
 *   no-daemon-start
 *     – Proves the invalid headless run did not start the session: daemon log
 *       `logs/daemon/<id>.log` absent, no listening socket, and no live daemon
 *       host for `__session <id>`. Removes only the stale files from the
 *       harness-owned isolated CLIMON_HOME.
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { BuildArtifacts } from "../build-cache.js";
import { PtyDriver, type PtyDriverDependencies, type PtySpawnSpec } from "../drivers/pty.js";
import type { CommandResult, CommandSpec } from "../command.js";
import { BunCommandRunner } from "../command.js";
import { parseSocketRef, tryConnect } from "../drivers/socket-probe.js";
import type { RuntimeContext } from "../runtime-supervisor.js";
import type { SessionLedger, SessionStatus } from "../session-ledger.js";
import type { SubcheckDefinition } from "../subchecks.js";
import type { HarnessPlatform, SubcheckResult } from "../types.js";
import { HarnessError } from "../types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const LOCAL_COLS = 80;
const LOCAL_ROWS = 24;

const ENGINE_ECHO_MARKER = "DAR_ENGINE_ECHO";

/**
 * Exact diagnostic emitted when an invalid CLIMON_SESSION_ENGINE value is used.
 * For attached sessions it surfaces to the terminal; for headless sessions it
 * is written to sessions/<id>.log before the daemon logger initializes.
 */
const INVALID_ENGINE_DIAGNOSTIC =
  "invalid CLIMON_SESSION_ENGINE 'future'; expected 'legacy' or 'actor'";

const FIND_SESSION_TIMEOUT_MS = 30_000;
const FINALIZATION_TIMEOUT_MS = 60_000;
const PTY_EXIT_TIMEOUT_MS = 60_000;
const SESSION_LOG_TIMEOUT_MS = 30_000;

// ── Subcheck definitions ──────────────────────────────────────────────────────

export const DAR_10_SUBCHECKS = [
  {
    name: "default-legacy-engine",
    title:
      "Default engine (CLIMON_SESSION_ENGINE unset) is legacy: DAR_ENGINE_ECHO marker in output, status=completed, exitCode=0, nonempty completedAt",
  },
  {
    name: "explicit-actor-engine",
    title:
      "Explicit actor engine (CLIMON_SESSION_ENGINE=actor): DAR_ENGINE_ECHO marker in output, status=completed, exitCode=0, nonempty completedAt",
  },
  {
    name: "explicit-legacy-rollback",
    title:
      "Explicit legacy rollback (CLIMON_SESSION_ENGINE=legacy): DAR_ENGINE_ECHO marker in output, status=completed, exitCode=0, nonempty completedAt",
  },
  {
    name: "external-parity",
    title:
      "Default, actor, and legacy sessions show identical normalized output, status=completed, exitCode=0, and DAR_ENGINE_ECHO in final scrollback",
  },
  {
    name: "invalid-attached-diagnostic",
    title:
      "Invalid CLIMON_SESSION_ENGINE=future surfaces exact diagnostic to attached terminal and exits nonzero",
  },
  {
    name: "invalid-headless-diagnostic",
    title:
      "Invalid CLIMON_SESSION_ENGINE=future in headless session writes exact diagnostic to sessions/<id>.log before daemon logger initializes",
  },
  {
    name: "no-daemon-start",
    title:
      "Invalid headless engine selection prevents daemon start: no daemon log, no live socket, no live daemon host",
  },
] as const satisfies readonly SubcheckDefinition[];

export type Dar10SubcheckName = (typeof DAR_10_SUBCHECKS)[number]["name"];

export const DAR_10_SUBCHECK_NAMES: readonly Dar10SubcheckName[] = DAR_10_SUBCHECKS.map(
  (s) => s.name
);

const DAR_10_SUBCHECKS_BY_NAME = new Map(
  DAR_10_SUBCHECKS.map((s) => [s.name, s] as const)
);

// ── Public context / dependency interfaces ────────────────────────────────────

export interface Dar10Context {
  platform: HarnessPlatform;
  overallDeadline: number | Date;
  build: Pick<BuildArtifacts, "clientPath" | "fixturePath">;
  runtime: Pick<RuntimeContext, "root" | "home" | "env"> & {
    artifacts: Pick<RuntimeContext["artifacts"], "dir" | "appendText">;
    sessions: Pick<SessionLedger, "track" | "waitForTerminalStatus" | "read">;
  };
}

export interface Dar10Pty {
  expectRaw(marker: string, deadline: number): Promise<void>;
  waitForExit(deadline: number): Promise<number>;
  kill(): void;
  readLocalOutput(): string;
}

interface SessionMetaLike extends Record<string, unknown> {
  id: string;
  status: SessionStatus;
  exitCode?: number;
  completedAt?: string;
  socketPath?: string;
}

interface FindSessionOptions {
  home: string;
  expectedName: string;
}

interface ResolveHostOptions {
  daemonChildPid?: number;
  artifactsDir: string;
}

interface SessionHost {
  pid: number;
  command: string;
}

export interface Dar10Dependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  createUuid?: () => string;
  spawnPty?: (spec: PtySpawnSpec, deps: PtyDriverDependencies) => Dar10Pty;
  findSession?: (options: FindSessionOptions) => Promise<SessionMetaLike | undefined>;
  readScrollback?: (home: string, id: string) => Promise<string>;
  runCommand?: (spec: CommandSpec) => Promise<CommandResult>;
  /** Read sessions/<id>.log (written before daemon logger initializes on failure). */
  readSessionLog?: (home: string, id: string) => Promise<string | undefined>;
  /** Read logs/daemon/<id>.log (written after daemon logger initializes). */
  readDaemonLog?: (home: string, id: string) => Promise<string | undefined>;
  /** Attempt to resolve a live session host process. Throws if none found. */
  resolveHost?: (
    platform: HarnessPlatform,
    sessionId: string,
    options: ResolveHostOptions
  ) => Promise<SessionHost | undefined>;
  readSessionMeta?: (home: string, id: string) => Promise<SessionMetaLike | undefined>;
  isSocketOpen?: (socketPath: string) => Promise<boolean>;
  /** Remove one invalid session's stale files from the isolated harness home. */
  cleanupInvalidSession?: (home: string, sessionId: string) => Promise<void>;
}

// ── Internal state for a valid engine-echo variant run ───────────────────────

interface VariantRunResult {
  scrollback: string;
  status: SessionStatus | undefined;
  exitCode: number | undefined;
  completedAt: string | undefined;
  markerInScrollback: boolean;
  markerInPty: boolean;
  ptyCrashed: boolean;
  failureReasons: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function asAbsoluteDeadline(d: number | Date): number {
  return d instanceof Date ? d.getTime() : d;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function normalizeScrollback(raw: string): string {
  return raw
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((l) => stripAnsi(l).trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/** Clone the env and set or unset CLIMON_SESSION_ENGINE. */
function engineEnv(
  base: Record<string, string | undefined>,
  value: string | undefined
): Record<string, string | undefined> {
  const env = { ...base };
  if (value === undefined) {
    delete env.CLIMON_SESSION_ENGINE;
  } else {
    env.CLIMON_SESSION_ENGINE = value;
  }
  return env;
}

function subcheckResult(
  name: Dar10SubcheckName,
  status: "passed" | "failed",
  durationMs: number,
  options: { message?: string; evidence?: string[] } = {}
): SubcheckResult {
  const definition = DAR_10_SUBCHECKS_BY_NAME.get(name);
  if (!definition) throw new Error(`Unknown DAR-10 subcheck: ${name}`);
  return {
    name,
    title: definition.title,
    status,
    durationMs,
    message: options.message,
    evidence: options.evidence ?? [],
  };
}

function sessionName(runId: string, variant: string): string {
  return `DAR-10-${variant}-${runId.slice(0, 8)}`;
}

function daemonLogEvidencePath(id: string): string {
  return `home/logs/daemon/${id}.log`;
}

function sessionLogEvidencePath(id: string): string {
  return `home/sessions/${id}.log`;
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
    if (value !== undefined) return value;
    if (now() >= deadline) throw new Error(timeoutMessage);
    await sleep(Math.max(1, Math.min(pollIntervalMs, deadline - now())));
  }
}

/** Parse the session ID from Rust launcher stdout. Re-exported from DAR-09 pattern. */
const SESSION_ID_SAFE_RE = /^[A-Za-z0-9._~-]+$/;

function completedLines(raw: string): string[] {
  const normalized = raw.replaceAll("\r\n", "\n");
  const parts = normalized.split("\n");
  const lines = normalized.endsWith("\n") ? parts : parts.slice(0, -1);
  return lines.map((l) => stripAnsi(l).trim()).filter((l) => l.length > 0);
}

function parseHeadlessSessionId(rawOutput: string): string {
  const lines = completedLines(rawOutput);
  if (lines.length === 0) {
    throw new HarnessError("prerequisite", "Headless launcher produced no completed output");
  }
  const safe = lines.filter((l) => SESSION_ID_SAFE_RE.test(l));
  const unsafe = lines.filter((l) => !SESSION_ID_SAFE_RE.test(l));
  if (unsafe.length > 0) {
    throw new HarnessError(
      "prerequisite",
      `Malformed headless launcher output: ${unsafe[0]!.slice(0, 80)}`
    );
  }
  if (safe.length !== 1) {
    throw new HarnessError(
      "prerequisite",
      `Expected exactly one session id line, found ${safe.length}`
    );
  }
  return safe[0]!;
}

// ── Default dependency implementations ───────────────────────────────────────

function defaultSpawnPty(spec: PtySpawnSpec, deps: PtyDriverDependencies): Dar10Pty {
  return PtyDriver.spawn(spec, deps);
}

async function defaultFindSession(
  options: FindSessionOptions
): Promise<SessionMetaLike | undefined> {
  const { readdir, readFile } = await import("node:fs/promises");
  let entries: string[];
  try {
    entries = await readdir(join(options.home, "sessions"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -5);
    try {
      const raw = await readFile(join(options.home, "sessions", `${id}.json`), "utf8");
      const meta = JSON.parse(raw) as SessionMetaLike;
      if (meta.name === options.expectedName || meta.id === options.expectedName) return meta;
    } catch {
      // skip
    }
  }
  return undefined;
}

async function defaultReadScrollback(home: string, id: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(join(home, "sessions", `${id}.scrollback`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function defaultReadSessionLog(home: string, id: string): Promise<string | undefined> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(join(home, "sessions", `${id}.log`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function defaultReadDaemonLog(home: string, id: string): Promise<string | undefined> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(join(home, "logs", "daemon", `${id}.log`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function defaultReadSessionMeta(
  home: string,
  id: string
): Promise<SessionMetaLike | undefined> {
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(
      await readFile(join(home, "sessions", `${id}.json`), "utf8")
    ) as SessionMetaLike;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function defaultIsSocketOpen(socketPath: string): Promise<boolean> {
  return tryConnect(parseSocketRef(socketPath));
}

async function defaultResolveHost(
  platform: HarnessPlatform,
  sessionId: string,
  options: ResolveHostOptions
): Promise<SessionHost | undefined> {
  const { resolveSessionHost } = await import("../drivers/process-discovery.js");
  const runner = new BunCommandRunner();
  try {
    return await resolveSessionHost(platform, sessionId, runner, {
      daemonChildPid: options.daemonChildPid,
      artifactsDir: options.artifactsDir,
      timeoutMs: 15_000,
    });
  } catch (error) {
    if (
      error instanceof HarnessError &&
      error.kind === "assertion" &&
      error.message.startsWith("No session host found for session ")
    ) {
      return undefined;
    }
    throw error;
  }
}

async function defaultCleanupInvalidSession(
  home: string,
  sessionId: string
): Promise<void> {
  const { rm, stat } = await import("node:fs/promises");
  const sessionsDir = join(home, "sessions");
  await Promise.all([
    rm(join(sessionsDir, `${sessionId}.json`), { force: true }),
    rm(join(sessionsDir, `${sessionId}.log`), { force: true }),
    rm(join(sessionsDir, `${sessionId}.scrollback`), { force: true }),
  ]);

  try {
    await stat(join(sessionsDir, `${sessionId}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new HarnessError(
    "assertion",
    `Invalid session ${sessionId} still exists after targeted harness cleanup`
  );
}

// ── Valid variant runner ──────────────────────────────────────────────────────

type EngineVariant = "default" | "actor" | "legacy";

const VARIANT_ENGINE: Record<EngineVariant, string | undefined> = {
  default: undefined,
  actor: "actor",
  legacy: "legacy",
};

async function runValidVariant(
  variant: EngineVariant,
  runId: string,
  context: Dar10Context,
  overallDeadline: number,
  deps: Required<
    Pick<
      Dar10Dependencies,
      "now" | "sleep" | "pollIntervalMs" | "spawnPty" | "findSession" | "readScrollback"
    >
  >
): Promise<VariantRunResult> {
  const { now, sleep, pollIntervalMs, spawnPty, findSession, readScrollback } = deps;
  const result: VariantRunResult = {
    scrollback: "",
    status: undefined,
    exitCode: undefined,
    completedAt: undefined,
    markerInScrollback: false,
    markerInPty: false,
    ptyCrashed: false,
    failureReasons: [],
  };

  const name = sessionName(runId, variant);
  const env = engineEnv(context.runtime.env, VARIANT_ENGINE[variant]);

  const ptySpec: PtySpawnSpec = {
    file: resolve(context.build.clientPath),
    args: [
      "run",
      "--name",
      name,
      resolve(context.build.fixturePath),
      "lifecycle-probe",
      "engine-echo",
    ],
    cwd: context.runtime.root,
    env,
    cols: LOCAL_COLS,
    rows: LOCAL_ROWS,
    inputPath: join(context.runtime.artifacts.dir, `${variant}/pty-input.log`),
    outputPath: join(context.runtime.artifacts.dir, `${variant}/pty-output.log`),
  };

  let pty: Dar10Pty;
  try {
    pty = spawnPty(ptySpec, {
      now,
      appendText: context.runtime.artifacts.appendText.bind(context.runtime.artifacts),
    });
  } catch (error) {
    result.ptyCrashed = true;
    result.failureReasons.push(`PTY spawn failed: ${stringifyError(error)}`);
    return result;
  }

  // Wait for the engine-echo marker in PTY output
  const markerDeadline = Math.min(overallDeadline, now() + FIND_SESSION_TIMEOUT_MS);
  try {
    await pty.expectRaw(ENGINE_ECHO_MARKER, markerDeadline);
    result.markerInPty = true;
  } catch (error) {
    result.failureReasons.push(`DAR_ENGINE_ECHO not observed in PTY: ${stringifyError(error)}`);
  }

  // Wait for PTY exit
  const exitDeadline = Math.min(overallDeadline, now() + PTY_EXIT_TIMEOUT_MS);
  let ptyExitCode: number | undefined;
  try {
    ptyExitCode = await pty.waitForExit(exitDeadline);
  } catch (error) {
    pty.kill();
    result.failureReasons.push(`PTY did not exit: ${stringifyError(error)}`);
  }

  // Find session in CLIMON_HOME by name, poll until terminal status
  const findDeadline = Math.min(overallDeadline, now() + FIND_SESSION_TIMEOUT_MS);
  let sessionId: string | undefined;
  try {
    const found = await waitForValue(
      findDeadline,
      now,
      sleep,
      pollIntervalMs,
      async (): Promise<SessionMetaLike | undefined> => {
        const meta = await findSession({ home: context.runtime.home, expectedName: name });
        return meta ?? undefined;
      },
      `Timed out finding session "${name}" after PTY exit`
    );
    sessionId = found.id;
    context.runtime.sessions.track(sessionId);
  } catch (error) {
    result.failureReasons.push(`Could not find session "${name}": ${stringifyError(error)}`);
  }

  if (sessionId !== undefined) {
    // Wait for terminal status
    const finalDeadline = Math.min(overallDeadline, now() + FINALIZATION_TIMEOUT_MS);
    try {
      const finalMeta = await context.runtime.sessions.waitForTerminalStatus(
        sessionId,
        finalDeadline
      ) as SessionMetaLike;
      result.status = finalMeta.status;
      result.exitCode = typeof finalMeta.exitCode === "number" ? finalMeta.exitCode : undefined;
      result.completedAt =
        typeof finalMeta.completedAt === "string" ? finalMeta.completedAt : undefined;
    } catch (error) {
      result.failureReasons.push(
        `Session did not reach terminal status: ${stringifyError(error)}`
      );
    }

    // Read final scrollback
    try {
      const raw = await readScrollback(context.runtime.home, sessionId);
      result.scrollback = raw;
      result.markerInScrollback = raw.includes(ENGINE_ECHO_MARKER);
    } catch (error) {
      result.failureReasons.push(`Could not read scrollback: ${stringifyError(error)}`);
    }
  }

  if (!result.markerInScrollback && !result.failureReasons.some((r) => r.includes("scrollback"))) {
    if (sessionId !== undefined) {
      result.failureReasons.push("DAR_ENGINE_ECHO not found in final scrollback");
    }
  }

  if (ptyExitCode !== undefined && ptyExitCode !== 0) {
    result.failureReasons.push(`PTY exited with code ${ptyExitCode} (expected 0)`);
  }

  if (result.status !== "completed") {
    result.failureReasons.push(
      `Expected status=completed, got ${String(result.status)}`
    );
  }

  if (result.exitCode !== 0) {
    result.failureReasons.push(
      `Expected exitCode=0, got ${String(result.exitCode)}`
    );
  }

  if (!result.completedAt) {
    result.failureReasons.push("completedAt is empty or missing");
  }

  return result;
}

// ── Main runner ───────────────────────────────────────────────────────────────

export async function runDar10(
  context: Dar10Context,
  dependencies: Dar10Dependencies = {}
): Promise<SubcheckResult[]> {
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? defaultSleep;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 200;
  const createUuid = dependencies.createUuid ?? randomUUID;
  const spawnPty = dependencies.spawnPty ?? defaultSpawnPty;
  const findSession = dependencies.findSession ?? defaultFindSession;
  const readScrollback = dependencies.readScrollback ?? defaultReadScrollback;
  const commandRunner = new BunCommandRunner();
  const runCommand = dependencies.runCommand ?? commandRunner.run.bind(commandRunner);
  const readSessionLog = dependencies.readSessionLog ?? defaultReadSessionLog;
  const readDaemonLog = dependencies.readDaemonLog ?? defaultReadDaemonLog;
  const readSessionMeta = dependencies.readSessionMeta ?? defaultReadSessionMeta;
  const isSocketOpen = dependencies.isSocketOpen ?? defaultIsSocketOpen;
  const resolveHost = dependencies.resolveHost ?? defaultResolveHost;
  const cleanupInvalidSession =
    dependencies.cleanupInvalidSession ?? defaultCleanupInvalidSession;

  const overallDeadline = asAbsoluteDeadline(context.overallDeadline);
  const runId = createUuid();

  const resolvedDeps = {
    now,
    sleep,
    pollIntervalMs,
    spawnPty,
    findSession,
    readScrollback,
  };

  const results: SubcheckResult[] = [];

  // ── Run three valid variants ────────────────────────────────────────────────

  const variantStartedAt: Record<EngineVariant, number> = {
    default: now(),
    actor: now(),
    legacy: now(),
  };

  const variantResults: Record<EngineVariant, VariantRunResult> = {
    default: { scrollback: "", status: undefined, exitCode: undefined, completedAt: undefined, markerInScrollback: false, markerInPty: false, ptyCrashed: false, failureReasons: [] },
    actor: { scrollback: "", status: undefined, exitCode: undefined, completedAt: undefined, markerInScrollback: false, markerInPty: false, ptyCrashed: false, failureReasons: [] },
    legacy: { scrollback: "", status: undefined, exitCode: undefined, completedAt: undefined, markerInScrollback: false, markerInPty: false, ptyCrashed: false, failureReasons: [] },
  };

  for (const variant of ["default", "actor", "legacy"] as EngineVariant[]) {
    variantStartedAt[variant] = now();
    variantResults[variant] = await runValidVariant(
      variant,
      runId,
      context,
      overallDeadline,
      resolvedDeps
    );
  }

  // ── default-legacy-engine ─────────────────────────────────────────────────

  const defaultResult = variantResults.default;
  const defaultDuration = now() - variantStartedAt.default;
  if (defaultResult.failureReasons.length === 0) {
    results.push(
      subcheckResult("default-legacy-engine", "passed", defaultDuration, {
        evidence: [`default/pty-input.log`, `default/pty-output.log`],
      })
    );
  } else {
    results.push(
      subcheckResult("default-legacy-engine", "failed", defaultDuration, {
        message: defaultResult.failureReasons.join("; "),
        evidence: [`default/pty-input.log`, `default/pty-output.log`],
      })
    );
  }

  // ── explicit-actor-engine ─────────────────────────────────────────────────

  const actorResult = variantResults.actor;
  const actorDuration = now() - variantStartedAt.actor;
  if (actorResult.failureReasons.length === 0) {
    results.push(
      subcheckResult("explicit-actor-engine", "passed", actorDuration, {
        evidence: [`actor/pty-input.log`, `actor/pty-output.log`],
      })
    );
  } else {
    results.push(
      subcheckResult("explicit-actor-engine", "failed", actorDuration, {
        message: actorResult.failureReasons.join("; "),
        evidence: [`actor/pty-input.log`, `actor/pty-output.log`],
      })
    );
  }

  // ── explicit-legacy-rollback ──────────────────────────────────────────────

  const legacyResult = variantResults.legacy;
  const legacyDuration = now() - variantStartedAt.legacy;
  if (legacyResult.failureReasons.length === 0) {
    results.push(
      subcheckResult("explicit-legacy-rollback", "passed", legacyDuration, {
        evidence: [`legacy/pty-input.log`, `legacy/pty-output.log`],
      })
    );
  } else {
    results.push(
      subcheckResult("explicit-legacy-rollback", "failed", legacyDuration, {
        message: legacyResult.failureReasons.join("; "),
        evidence: [`legacy/pty-input.log`, `legacy/pty-output.log`],
      })
    );
  }

  // ── external-parity ───────────────────────────────────────────────────────

  const parityStartedAt = now();
  const parityReasons: string[] = [];

  if (
    defaultResult.failureReasons.length > 0 ||
    actorResult.failureReasons.length > 0 ||
    legacyResult.failureReasons.length > 0
  ) {
    parityReasons.push("Parity skipped: one or more valid variants failed");
  } else {
    const defaultNorm = normalizeScrollback(defaultResult.scrollback);
    const actorNorm = normalizeScrollback(actorResult.scrollback);
    const legacyNorm = normalizeScrollback(legacyResult.scrollback);

    if (defaultNorm !== actorNorm) {
      parityReasons.push(
        `default and actor scrollbacks differ: default=${defaultNorm.slice(0, 80)} actor=${actorNorm.slice(0, 80)}`
      );
    }
    if (defaultNorm !== legacyNorm) {
      parityReasons.push(
        `default and legacy scrollbacks differ: default=${defaultNorm.slice(0, 80)} legacy=${legacyNorm.slice(0, 80)}`
      );
    }

    if (actorResult.exitCode !== 0 || legacyResult.exitCode !== 0) {
      parityReasons.push(
        `exitCode mismatch: actor=${String(actorResult.exitCode)} legacy=${String(legacyResult.exitCode)}`
      );
    }

    for (const [variant, vr] of [
      ["default", defaultResult],
      ["actor", actorResult],
      ["legacy", legacyResult],
    ] as [string, VariantRunResult][]) {
      if (!vr.markerInScrollback) {
        parityReasons.push(`${variant} scrollback missing DAR_ENGINE_ECHO`);
      }
      if (vr.status !== "completed") {
        parityReasons.push(`${variant} status=${String(vr.status)} (expected completed)`);
      }
    }
  }

  const parityDuration = now() - parityStartedAt;
  results.push(
    subcheckResult("external-parity", parityReasons.length === 0 ? "passed" : "failed", parityDuration, {
      message: parityReasons.length > 0 ? parityReasons.join("; ") : undefined,
    })
  );

  // ── invalid-attached-diagnostic ───────────────────────────────────────────

  const invalidAttachedStartedAt = now();
  const invalidAttachedReasons: string[] = [];
  const invalidAttachedEvidence: string[] = [
    "invalid-attached/pty-input.log",
    "invalid-attached/pty-output.log",
  ];

  {
    const name = sessionName(runId, "invalid-attached");
    const env = engineEnv(context.runtime.env, "future");

    const ptySpec: PtySpawnSpec = {
      file: resolve(context.build.clientPath),
      args: [
        "run",
        "--name",
        name,
        resolve(context.build.fixturePath),
        "lifecycle-probe",
        "engine-echo",
      ],
      cwd: context.runtime.root,
      env,
      cols: LOCAL_COLS,
      rows: LOCAL_ROWS,
      inputPath: join(context.runtime.artifacts.dir, "invalid-attached/pty-input.log"),
      outputPath: join(context.runtime.artifacts.dir, "invalid-attached/pty-output.log"),
    };

    let invalidPty: Dar10Pty | undefined;
    try {
      invalidPty = spawnPty(ptySpec, {
        now,
        appendText: context.runtime.artifacts.appendText.bind(context.runtime.artifacts),
      });
    } catch (error) {
      invalidAttachedReasons.push(`PTY spawn failed: ${stringifyError(error)}`);
    }

    if (invalidPty) {
      // Assert exact diagnostic text visible in PTY
      const diagDeadline = Math.min(overallDeadline, now() + FIND_SESSION_TIMEOUT_MS);
      try {
        await invalidPty.expectRaw(INVALID_ENGINE_DIAGNOSTIC, diagDeadline);
      } catch (error) {
        invalidAttachedReasons.push(
          `Exact diagnostic not visible in PTY: ${stringifyError(error)}`
        );
      }

      // Assert process exits nonzero
      const exitDeadline = Math.min(overallDeadline, now() + PTY_EXIT_TIMEOUT_MS);
      try {
        const code = await invalidPty.waitForExit(exitDeadline);
        if (code === 0) {
          invalidAttachedReasons.push(
            `Expected nonzero exit code for invalid engine, got 0`
          );
        }
      } catch (error) {
        invalidPty.kill();
        invalidAttachedReasons.push(`PTY did not exit: ${stringifyError(error)}`);
      }

      // Attempt to clean up any record the launcher may have left
      try {
        const attachedMeta = await findSession({
          home: context.runtime.home,
          expectedName: name,
        });
        if (attachedMeta) {
          await cleanupInvalidSession(context.runtime.home, attachedMeta.id);
        }
      } catch (error) {
        invalidAttachedReasons.push(
          `Failed to reconcile invalid attached record: ${stringifyError(error)}`
        );
      }
    }
  }

  const invalidAttachedDuration = now() - invalidAttachedStartedAt;
  results.push(
    subcheckResult(
      "invalid-attached-diagnostic",
      invalidAttachedReasons.length === 0 ? "passed" : "failed",
      invalidAttachedDuration,
      {
        message: invalidAttachedReasons.length > 0 ? invalidAttachedReasons.join("; ") : undefined,
        evidence: invalidAttachedEvidence,
      }
    )
  );

  // ── invalid-headless-diagnostic and no-daemon-start ───────────────────────

  const invalidHeadlessStartedAt = now();
  const invalidHeadlessReasons: string[] = [];
  const noDaemonStartReasons: string[] = [];
  let invalidHeadlessSessionId: string | undefined;
  const invalidHeadlessEvidence: string[] = [
    "invalid-headless/launcher.stdout.log",
    "invalid-headless/launcher.stderr.log",
  ];

  {
    const name = sessionName(runId, "invalid-headless");
    const env = engineEnv(context.runtime.env, "future");

    // Launch headless with invalid engine
    let launchResult: CommandResult;
    try {
      launchResult = await runCommand({
        file: resolve(context.build.clientPath),
        args: [
          "run",
          "--headless",
          "--name",
          name,
          resolve(context.build.fixturePath),
          "lifecycle-probe",
          "engine-echo",
        ],
        cwd: context.runtime.root,
        env,
        timeoutMs: 60_000,
        stdoutPath: join(context.runtime.artifacts.dir, "invalid-headless/launcher.stdout.log"),
        stderrPath: join(context.runtime.artifacts.dir, "invalid-headless/launcher.stderr.log"),
      });
    } catch (error) {
      invalidHeadlessReasons.push(`Launcher invocation failed: ${stringifyError(error)}`);
      noDaemonStartReasons.push(`Launcher invocation failed: ${stringifyError(error)}`);
      const headlessDuration = now() - invalidHeadlessStartedAt;
      results.push(
        subcheckResult("invalid-headless-diagnostic", "failed", headlessDuration, {
          message: invalidHeadlessReasons.join("; "),
          evidence: invalidHeadlessEvidence,
        })
      );
      results.push(
        subcheckResult("no-daemon-start", "failed", headlessDuration, {
          message: noDaemonStartReasons.join("; "),
        })
      );
      return results;
    }
    if (launchResult.code !== 0) {
      invalidHeadlessReasons.push(
        `Headless launcher exited with code ${launchResult.code}: ${launchResult.stderr.slice(0, 200)}`
      );
    }

    // Parse session ID from launcher stdout
    try {
      invalidHeadlessSessionId = parseHeadlessSessionId(launchResult.stdout);
      invalidHeadlessEvidence.push(
        `home/sessions/${invalidHeadlessSessionId}.json`,
        sessionLogEvidencePath(invalidHeadlessSessionId),
        daemonLogEvidencePath(invalidHeadlessSessionId)
      );
    } catch (error) {
      invalidHeadlessReasons.push(`Could not parse session ID: ${stringifyError(error)}`);
    }

    // Poll sessions/<id>.log for the exact diagnostic text
    if (invalidHeadlessSessionId !== undefined) {
      const sessionLogDeadline = Math.min(overallDeadline, now() + SESSION_LOG_TIMEOUT_MS);
      const id = invalidHeadlessSessionId;

      let sessionLogContent: string | undefined;
      try {
        sessionLogContent = await waitForValue(
          sessionLogDeadline,
          now,
          sleep,
          pollIntervalMs,
          async () => {
            const content = await readSessionLog(context.runtime.home, id);
            if (content !== undefined && content.includes(INVALID_ENGINE_DIAGNOSTIC)) {
              return content;
            }
            return undefined;
          },
          `Timed out waiting for exact diagnostic in sessions/${id}.log`
        );
        if (!sessionLogContent.includes(INVALID_ENGINE_DIAGNOSTIC)) {
          invalidHeadlessReasons.push(
            `sessions/${id}.log does not contain exact diagnostic text`
          );
        }
      } catch (error) {
        const raw = await readSessionLog(context.runtime.home, id).catch(() => undefined);
        if (raw === undefined) {
          invalidHeadlessReasons.push(
            `sessions/${id}.log is absent; engine selection failed before writing it`
          );
        } else {
          invalidHeadlessReasons.push(
            `sessions/${id}.log exists but does not contain exact diagnostic: ${stringifyError(error)}`
          );
        }
      }
    }

    const headlessDuration = now() - invalidHeadlessStartedAt;
    results.push(
      subcheckResult(
        "invalid-headless-diagnostic",
        invalidHeadlessReasons.length === 0 ? "passed" : "failed",
        headlessDuration,
        {
          message: invalidHeadlessReasons.length > 0 ? invalidHeadlessReasons.join("; ") : undefined,
          evidence: invalidHeadlessEvidence,
        }
      )
    );

    // ── no-daemon-start ─────────────────────────────────────────────────────

    const noDaemonStartedAt = now();

    if (invalidHeadlessSessionId !== undefined) {
      const id = invalidHeadlessSessionId;

      // Assert daemon log is absent
      try {
        const daemonLog = await readDaemonLog(context.runtime.home, id);
        if (daemonLog !== undefined) {
          noDaemonStartReasons.push(
            `logs/daemon/${id}.log is present; daemon started unexpectedly`
          );
        }
      } catch (error) {
        noDaemonStartReasons.push(
          `Could not check daemon log: ${stringifyError(error)}`
        );
      }

      // Assert the stale metadata never published a listening socket.
      try {
        const meta = await readSessionMeta(context.runtime.home, id);
        if (meta === undefined) {
          noDaemonStartReasons.push(
            `sessions/${id}.json is absent; cannot verify that no socket was published`
          );
        } else if (typeof meta.socketPath === "string" && meta.socketPath.length > 0) {
          try {
            if (await isSocketOpen(meta.socketPath)) {
              noDaemonStartReasons.push(
                `Session socket is accepting connections at ${meta.socketPath}; daemon started unexpectedly`
              );
            }
          } catch {
            // A placeholder or otherwise invalid socket reference proves no usable
            // listener was published.
          }
        }
      } catch (error) {
        noDaemonStartReasons.push(
          `Could not inspect invalid session metadata/socket: ${stringifyError(error)}`
        );
      }

      // Assert no live daemon host
      try {
        const host = await resolveHost(context.platform, id, {
          artifactsDir: join(context.runtime.artifacts.dir, "no-daemon-start"),
        });
        if (host !== undefined) {
          noDaemonStartReasons.push(
            `Live daemon host found for session ${id} (pid=${host.pid}); daemon started unexpectedly`
          );
        }
      } catch (error) {
        noDaemonStartReasons.push(
          `Process discovery failed while checking for a daemon host: ${stringifyError(error)}`
        );
      }

      // Cleanup only this stale record in the harness-owned isolated home.
      try {
        await cleanupInvalidSession(context.runtime.home, id);
      } catch (error) {
        noDaemonStartReasons.push(
          `Failed to reconcile invalid headless record: ${stringifyError(error)}`
        );
      }
    } else {
      noDaemonStartReasons.push("Invalid headless session ID not available; cannot verify");
    }

    const noDaemonDuration = now() - noDaemonStartedAt;
    results.push(
      subcheckResult(
        "no-daemon-start",
        noDaemonStartReasons.length === 0 ? "passed" : "failed",
        noDaemonDuration,
        {
          message: noDaemonStartReasons.length > 0 ? noDaemonStartReasons.join("; ") : undefined,
          evidence: invalidHeadlessEvidence,
        }
      )
    );
  }

  return results;
}
