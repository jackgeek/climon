/**
 * DAR-07 — Fast exit, failed exit, final scrollback, and socket cleanup.
 *
 * Spawns two separate PTY/session pairs via `lifecycle-probe fast-success`
 * and `lifecycle-probe failed-exit`, then verifies:
 *
 *   success-finalization   – status=completed, exitCode=0, nonempty completedAt,
 *                            final scrollback contains the early fixture marker.
 *   success-socket-cleanup – daemon socket closes (TCP: connection refused;
 *                            Unix: connection refused + file absent).
 *   failure-finalization   – status=failed, exitCode=7, nonempty completedAt,
 *                            final scrollback contains the failure marker.
 *   failure-socket-cleanup – same socket-closed check for the failure session.
 *
 * The fixture exits almost immediately after emitting its early marker. The
 * socket-capture and open-probe are therefore structured to run before
 * observing early PTY output to maximise the window for the open check. If the
 * daemon has already torn down its listener by then, the open probe records
 * "already closed" evidence rather than failing the subcheck — socket cleanup
 * is confirmed by the explicit waitClosed subcheck regardless.
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { BuildArtifacts } from "../build-cache.js";
import { PtyDriver, type PtyDriverDependencies, type PtySpawnSpec } from "../drivers/pty.js";
import { parseSocketRef, SocketProbe, type SocketRef } from "../drivers/socket-probe.js";
import type { RuntimeContext } from "../runtime-supervisor.js";
import type { SessionLedger, SessionStatus } from "../session-ledger.js";
import type { SubcheckDefinition } from "../subchecks.js";
import type { HarnessPlatform, SubcheckResult } from "../types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const LOCAL_COLS = 80;
const LOCAL_ROWS = 24;

const SUCCESS_PTY_INPUT = "pty/success/input.log";
const SUCCESS_PTY_OUTPUT = "pty/success/output.log";
const FAILURE_PTY_INPUT = "pty/failure/input.log";
const FAILURE_PTY_OUTPUT = "pty/failure/output.log";

const EARLY_SUCCESS_MARKER = "DAR_LIFECYCLE_EARLY success";
const EARLY_FAILURE_MARKER = "DAR_LIFECYCLE_EARLY failure";

/**
 * Session statuses that indicate the daemon is still alive and may have a
 * valid socket path. Terminal statuses (completed/failed/disconnected) are
 * excluded: a daemon in a terminal state will have torn down its listener so
 * there is nothing useful to probe.
 */
const LIVE_SESSION_STATUSES = new Set<SessionStatus>([
  "running",
  "acknowledged",
  "needs-attention",
  "paused",
]);

/** Timeout for finding session metadata after PTY spawn. */
const FIND_SESSION_TIMEOUT_MS = 30_000;
/** Timeout for the finalization check after PTY exit. */
const FINALIZATION_TIMEOUT_MS = 60_000;
/** Timeout for the socket cleanup check after finalization. */
const SOCKET_CLEANUP_TIMEOUT_MS = 30_000;
/** Timeout for waiting for the early PTY marker. */
const EARLY_MARKER_TIMEOUT_MS = 30_000;
/** Timeout for waiting for the PTY process to exit. */
const PTY_EXIT_TIMEOUT_MS = 30_000;

// ── Subcheck definitions ──────────────────────────────────────────────────────

export const DAR_07_SUBCHECKS = [
  {
    name: "success-finalization",
    title:
      "Fast-success session finalizes with status=completed, exitCode=0, nonempty completedAt, and early marker in scrollback",
  },
  {
    name: "success-socket-cleanup",
    title:
      "Fast-success daemon socket closes after finalization (TCP: connection refused; Unix: refused + file absent)",
  },
  {
    name: "failure-finalization",
    title:
      "Failed-exit session finalizes with status=failed, exitCode=7, nonempty completedAt, and failure marker in scrollback",
  },
  {
    name: "failure-socket-cleanup",
    title:
      "Failed-exit daemon socket closes after finalization (TCP: connection refused; Unix: refused + file absent)",
  },
] as const satisfies readonly SubcheckDefinition[];

export type Dar07SubcheckName = (typeof DAR_07_SUBCHECKS)[number]["name"];

export const DAR_07_SUBCHECK_NAMES: readonly Dar07SubcheckName[] = DAR_07_SUBCHECKS.map(
  (s) => s.name
);

const DAR_07_SUBCHECKS_BY_NAME = new Map(
  DAR_07_SUBCHECKS.map((s) => [s.name, s] as const)
);

// ── Public context/dependency interfaces ─────────────────────────────────────

export interface Dar07Context {
  platform: HarnessPlatform;
  overallDeadline: number | Date;
  build: Pick<BuildArtifacts, "clientPath" | "fixturePath">;
  runtime: Pick<RuntimeContext, "root" | "home" | "env"> & {
    artifacts: Pick<RuntimeContext["artifacts"], "dir" | "appendText">;
    sessions: Pick<
      SessionLedger,
      "track" | "waitForTerminalStatus" | "read"
    >;
  };
}

export interface Dar07Pty {
  expectRaw(marker: string, deadline: number): Promise<void>;
  waitForExit(deadline: number): Promise<number>;
  kill(): void;
  writeText(text: string): void;
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

export interface Dar07Dependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  createUuid?: () => string;
  spawnPty?: (spec: PtySpawnSpec, deps: PtyDriverDependencies) => Dar07Pty;
  findSession?: (options: FindSessionOptions) => Promise<SessionMetaLike | undefined>;
  readScrollback?: (home: string, id: string) => Promise<string>;
  createSocketProbe?: () => SocketProbe;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawnPty(spec: PtySpawnSpec, deps: PtyDriverDependencies): Dar07Pty {
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

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

function sessionName(runId: string, variant: "success" | "failure"): string {
  return `DAR-07-${variant}-${runId.slice(0, 8)}`;
}

function sessionMetaEvidencePath(id: string): string {
  return `home/sessions/${id}.json`;
}

function scrollbackEvidencePath(id: string): string {
  return `home/sessions/${id}.scrollback`;
}

function daemonLogEvidencePath(id: string): string {
  return `home/logs/daemon/${id}.log`;
}

function subcheckResult(
  name: Dar07SubcheckName,
  status: "passed" | "failed",
  durationMs: number,
  options: { message?: string; evidence?: string[] } = {}
): SubcheckResult {
  const definition = DAR_07_SUBCHECKS_BY_NAME.get(name);
  if (!definition) {
    throw new Error(`Unknown DAR-07 subcheck: ${name}`);
  }
  return {
    name,
    title: definition.title,
    status,
    durationMs,
    message: options.message,
    evidence: options.evidence ?? [],
  };
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

// ── Per-variant lifecycle ─────────────────────────────────────────────────────

/** Unique gate token scoped to one DAR-07 run + variant. */
function variantGateToken(runId: string, variant: "success" | "failure"): string {
  return `dar07-gate-${variant}-${runId.slice(0, 8)}`;
}

interface VariantState {
  /** Session id from metadata discovery, once known. */
  sessionId?: string;
  /** Socket path captured from metadata, if available. */
  capturedSocketPath?: string;
  /** Parsed socket ref for the cleanup subcheck. */
  socketRef?: SocketRef;
  /** Evidence lines accumulated during the run. */
  evidence: string[];
  /** Probe transcript entries. */
  probeTranscript: string[];
  spawnError?: string;
  /** True iff waitOpen confirmed the daemon socket was listening before release. */
  openProofRecorded: boolean;
}

interface VariantSpec {
  variant: "success" | "failure";
  fixtureArg: string;
  ptyInputArtifact: string;
  ptyOutputArtifact: string;
  expectedStatus: "completed" | "failed";
  expectedExitCode: number;
  earlyMarker: string;
  finalizationSubcheck: Dar07SubcheckName;
  socketCleanupSubcheck: Dar07SubcheckName;
}

const SUCCESS_SPEC: VariantSpec = {
  variant: "success",
  fixtureArg: "fast-success",
  ptyInputArtifact: SUCCESS_PTY_INPUT,
  ptyOutputArtifact: SUCCESS_PTY_OUTPUT,
  expectedStatus: "completed",
  expectedExitCode: 0,
  earlyMarker: EARLY_SUCCESS_MARKER,
  finalizationSubcheck: "success-finalization",
  socketCleanupSubcheck: "success-socket-cleanup",
};

const FAILURE_SPEC: VariantSpec = {
  variant: "failure",
  fixtureArg: "failed-exit",
  ptyInputArtifact: FAILURE_PTY_INPUT,
  ptyOutputArtifact: FAILURE_PTY_OUTPUT,
  expectedStatus: "failed",
  expectedExitCode: 7,
  earlyMarker: EARLY_FAILURE_MARKER,
  finalizationSubcheck: "failure-finalization",
  socketCleanupSubcheck: "failure-socket-cleanup",
};

// ── Main export ───────────────────────────────────────────────────────────────

export async function runDar07(
  context: Dar07Context,
  dependencies: Dar07Dependencies = {}
): Promise<SubcheckResult[]> {
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? defaultSleep;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 50;
  const createUuid = dependencies.createUuid ?? randomUUID;
  const spawnPty = dependencies.spawnPty ?? defaultSpawnPty;
  const findSession = dependencies.findSession ?? defaultFindSession;
  const readScrollback = dependencies.readScrollback ?? defaultReadScrollback;
  const createSocketProbe = dependencies.createSocketProbe ?? (() => new SocketProbe({ now, sleep, pollIntervalMs }));

  const overallDeadline = asAbsoluteDeadline(context.overallDeadline);
  const runId = createUuid();

  const results: SubcheckResult[] = [];

  for (const spec of [SUCCESS_SPEC, FAILURE_SPEC]) {
    const token = variantGateToken(runId, spec.variant);
    const variantResults = await runVariant(
      spec,
      runId,
      token,
      context,
      overallDeadline,
      { now, sleep, pollIntervalMs, spawnPty, findSession, readScrollback, createSocketProbe }
    );
    results.push(...variantResults);
  }

  return results;
}

async function runVariant(
  spec: VariantSpec,
  runId: string,
  gateToken: string,
  context: Dar07Context,
  overallDeadline: number,
  deps: Required<Pick<Dar07Dependencies, "now" | "sleep" | "pollIntervalMs" | "spawnPty" | "findSession" | "readScrollback" | "createSocketProbe">>
): Promise<SubcheckResult[]> {
  const { now, sleep, pollIntervalMs, spawnPty, findSession, readScrollback, createSocketProbe } = deps;
  const results: SubcheckResult[] = [];
  const state: VariantState = {
    evidence: [spec.ptyInputArtifact, spec.ptyOutputArtifact],
    probeTranscript: [],
    openProofRecorded: false,
  };

  const gateMarker = `DAR_LIFECYCLE_GATE ${gateToken}`;

  let pty: Dar07Pty | undefined;

  // ── Spawn PTY ─────────────────────────────────────────────────────────────

  const name = sessionName(runId, spec.variant);
  const ptySpec: PtySpawnSpec = {
    file: resolve(context.build.clientPath),
    args: ["run", "--name", name, resolve(context.build.fixturePath), "lifecycle-probe", spec.fixtureArg, gateToken],
    cwd: context.runtime.root,
    env: context.runtime.env,
    cols: LOCAL_COLS,
    rows: LOCAL_ROWS,
    inputPath: spec.ptyInputArtifact,
    outputPath: spec.ptyOutputArtifact,
  };

  try {
    pty = spawnPty(ptySpec, {
      now,
      appendText: context.runtime.artifacts.appendText.bind(context.runtime.artifacts),
    });
  } catch (error) {
    state.spawnError = `Failed to spawn PTY for ${spec.variant}: ${stringifyError(error)}`;
  }

  // ── Find session: condition-wait for live status + valid socket path ─────────
  //
  // The launcher initially writes socketPath: "tcp://127.0.0.1:0" while the
  // daemon binds to an OS-assigned port (DAR-07 root cause). We must not capture
  // that placeholder — poll until the metadata has ALL of:
  //   1. expected name / id match
  //   2. live status  (running | acknowledged | needs-attention | paused)
  //   3. socketPath that parseSocketRef accepts (nonzero TCP or absolute Unix)
  //
  // Placeholder / unparseable refs are recorded in probeTranscript once per
  // distinct value (dedup) to avoid flooding.  The id and socketRef are captured
  // atomically when all conditions are satisfied.

  let trackedSessionId: string | undefined;

  if (pty && !state.spawnError) {
    const findDeadline = Math.min(overallDeadline, now() + FIND_SESSION_TIMEOUT_MS);
    let lastLoggedSocketSpec: string | undefined;

    try {
      const found = await waitForValue(
        findDeadline,
        now,
        sleep,
        pollIntervalMs,
        async (): Promise<{ id: string; socketRef: SocketRef } | undefined> => {
          const meta = await findSession({ home: context.runtime.home, expectedName: name });
          if (meta === undefined) return undefined;

          // Require a live status — terminal sessions have torn down their listener.
          if (!LIVE_SESSION_STATUSES.has(meta.status)) return undefined;

          const sp = meta.socketPath;
          if (typeof sp !== "string" || sp.length === 0) {
            // Log "no socket path" once to avoid flooding duplicates.
            if (lastLoggedSocketSpec !== "") {
              state.probeTranscript.push("no-socket-path-in-metadata");
              lastLoggedSocketSpec = "";
            }
            return undefined;
          }

          let ref: SocketRef;
          try {
            ref = parseSocketRef(sp);
          } catch (parseError) {
            // Log each distinct placeholder / unparseable value once.
            if (sp !== lastLoggedSocketSpec) {
              state.probeTranscript.push(
                `socket-path-placeholder: ${sp} — ${stringifyError(parseError)}`
              );
              lastLoggedSocketSpec = sp;
            }
            return undefined;
          }

          // All three conditions satisfied — return atomically.
          return { id: meta.id, socketRef: ref };
        },
        `Timed out waiting for session "${name}" to publish a valid non-placeholder socket path`
      );

      trackedSessionId = found.id;
      state.socketRef = found.socketRef;
      state.capturedSocketPath = found.socketRef.raw;
      context.runtime.sessions.track(trackedSessionId);
      state.evidence.push(
        sessionMetaEvidencePath(trackedSessionId),
        scrollbackEvidencePath(trackedSessionId),
        daemonLogEvidencePath(trackedSessionId)
      );
      state.probeTranscript.push(`captured-socket-path: ${found.socketRef.raw}`);
      state.probeTranscript.push(`parsed-socket-ref: kind=${found.socketRef.kind}`);
    } catch (error) {
      state.spawnError = `Failed to find session for "${name}": ${stringifyError(error)}`;
    }
  }

  if (state.probeTranscript.length > 0) {
    state.evidence.push("socket-probe-transcript.log");
  }

  // ── Observe early marker through local PTY ────────────────────────────────

  if (pty && !state.spawnError) {
    const markerDeadline = Math.min(overallDeadline, now() + EARLY_MARKER_TIMEOUT_MS);
    try {
      await pty.expectRaw(spec.earlyMarker, markerDeadline);
      state.probeTranscript.push(`early-marker-observed: ${spec.earlyMarker}`);
    } catch (error) {
      state.probeTranscript.push(`early-marker-wait-error: ${stringifyError(error)}`);
    }
  }

  // ── Observe gate marker — confirms fixture is alive and holding ───────────

  if (pty && !state.spawnError) {
    const gateDeadline = Math.min(overallDeadline, now() + EARLY_MARKER_TIMEOUT_MS);
    try {
      await pty.expectRaw(gateMarker, gateDeadline);
      state.probeTranscript.push(`gate-marker-observed: ${gateMarker}`);
    } catch (error) {
      state.probeTranscript.push(`gate-marker-wait-error: ${stringifyError(error)}`);
    }
  }

  // ── Required open probe — daemon socket must be listening ─────────────────
  // Performed after the gate marker: the fixture is alive waiting for RELEASE,
  // so the daemon listener must be up. waitOpen failure → cleanup subcheck fails.

  if (pty && !state.spawnError && state.socketRef) {
    const openDeadline = Math.min(overallDeadline, now() + SOCKET_CLEANUP_TIMEOUT_MS);
    const socketProbe = createSocketProbe();
    try {
      await socketProbe.waitOpen(state.socketRef, openDeadline);
      state.openProofRecorded = true;
      state.probeTranscript.push(`socket-open-confirmed: ${state.socketRef.raw}`);
    } catch (error) {
      state.probeTranscript.push(`socket-open-failed: ${stringifyError(error)}`);
    }
  }

  // ── Release the fixture gate — always, to unblock PTY exit ───────────────

  if (pty && !state.spawnError) {
    pty.writeText(`RELEASE ${gateToken}\r`);
    state.probeTranscript.push(`release-sent: RELEASE ${gateToken}`);
  }

  // ── Wait for PTY process exit ─────────────────────────────────────────────

  if (pty && !state.spawnError) {
    const exitDeadline = Math.min(overallDeadline, now() + PTY_EXIT_TIMEOUT_MS);
    try {
      const exitCode = await pty.waitForExit(exitDeadline);
      state.probeTranscript.push(`pty-exit-code: ${exitCode}`);
    } catch (error) {
      state.probeTranscript.push(`pty-exit-error: ${stringifyError(error)}`);
    }
  }

  // ── success/failure-finalization subcheck ─────────────────────────────────

  const finalizationStart = now();
  {
    const checkName = spec.finalizationSubcheck;
    let result: SubcheckResult;

    if (state.spawnError) {
      result = subcheckResult(checkName, "failed", Math.max(0, now() - finalizationStart), {
        message: state.spawnError,
        evidence: [...state.evidence],
      });
    } else if (!trackedSessionId) {
      result = subcheckResult(checkName, "failed", Math.max(0, now() - finalizationStart), {
        message: "Session was not tracked; cannot verify finalization.",
        evidence: [...state.evidence],
      });
    } else {
      try {
        const finalizationDeadline = Math.min(overallDeadline, now() + FINALIZATION_TIMEOUT_MS);
        const meta = await context.runtime.sessions.waitForTerminalStatus(
          trackedSessionId,
          finalizationDeadline
        );

        const failures: string[] = [];
        const passNotes: string[] = [];

        // status check
        if (meta.status !== spec.expectedStatus) {
          failures.push(`status: expected ${spec.expectedStatus}, got ${meta.status}`);
        } else {
          passNotes.push(`status=${meta.status}`);
        }

        // exitCode check
        if (meta.exitCode !== spec.expectedExitCode) {
          failures.push(`exitCode: expected ${spec.expectedExitCode}, got ${String(meta.exitCode)}`);
        } else {
          passNotes.push(`exitCode=${meta.exitCode}`);
        }

        // completedAt check
        const completedAt = meta.completedAt;
        if (typeof completedAt !== "string" || completedAt.length === 0) {
          failures.push(`completedAt: expected nonempty string, got ${String(completedAt)}`);
        } else {
          passNotes.push(`completedAt=${completedAt}`);
        }

        // Scrollback check — read final scrollback after terminal status.
        const scrollback = await readScrollback(context.runtime.home, trackedSessionId);
        if (!scrollback.includes(spec.earlyMarker)) {
          failures.push(
            `scrollback does not contain early marker "${spec.earlyMarker}"`
          );
        } else {
          passNotes.push(`scrollback contains "${spec.earlyMarker}"`);
        }

        if (failures.length > 0) {
          result = subcheckResult(checkName, "failed", Math.max(0, now() - finalizationStart), {
            message: failures.join("; "),
            evidence: [...state.evidence],
          });
        } else {
          result = subcheckResult(checkName, "passed", Math.max(0, now() - finalizationStart), {
            message: passNotes.join(", "),
            evidence: [...state.evidence],
          });
        }
      } catch (error) {
        result = subcheckResult(checkName, "failed", Math.max(0, now() - finalizationStart), {
          message: stringifyError(error),
          evidence: [...state.evidence],
        });
      }
    }

    results.push(result);
  }

  // ── success/failure-socket-cleanup subcheck ───────────────────────────────

  const cleanupStart = now();
  {
    const checkName = spec.socketCleanupSubcheck;
    let result: SubcheckResult;

    if (!state.socketRef) {
      const reason = state.capturedSocketPath
        ? `Failed to parse socket ref "${state.capturedSocketPath}"`
        : "No socketPath field in session metadata — socket cleanup cannot be verified.";
      result = subcheckResult(checkName, "failed", Math.max(0, now() - cleanupStart), {
        message: reason,
        evidence: [...state.evidence],
      });
    } else if (!state.openProofRecorded) {
      // waitOpen did not confirm the listener was live — socket cleanup cannot be
      // trusted as deterministic evidence; fail rather than accept uncertainty.
      result = subcheckResult(checkName, "failed", Math.max(0, now() - cleanupStart), {
        message: `Socket open proof absent for ${state.socketRef.raw}: waitOpen did not confirm the daemon listener before release.`,
        evidence: [...state.evidence],
      });
    } else {
      try {
        const cleanupDeadline = Math.min(overallDeadline, now() + SOCKET_CLEANUP_TIMEOUT_MS);
        const socketProbe = createSocketProbe();
        await socketProbe.waitClosed(state.socketRef, cleanupDeadline);
        state.probeTranscript.push("socket-cleanup-confirmed: closed");

        result = subcheckResult(checkName, "passed", Math.max(0, now() - cleanupStart), {
          message: `Socket ${state.socketRef.raw} is closed and (for Unix) file is absent.`,
          evidence: [...state.evidence],
        });
      } catch (error) {
        state.probeTranscript.push(`socket-cleanup-error: ${stringifyError(error)}`);
        result = subcheckResult(checkName, "failed", Math.max(0, now() - cleanupStart), {
          message: stringifyError(error),
          evidence: [...state.evidence],
        });
      }
    }

    results.push(result);
  }

  // ── Cleanup: kill PTY if still alive ─────────────────────────────────────

  try {
    pty?.kill();
  } catch {
    // Best-effort.
  }

  return results;
}
