/**
 * DAR-08 — Slow / disconnecting viewer isolation.
 *
 * Spawns `lifecycle-probe flood 10000 <token>` via a PTY-attached session and
 * verifies five subchecks:
 *
 *   healthy-viewer-receives-initial-stream
 *     – A browser desktop surface opens the session terminal and, after phase 1
 *       emits lines 1–5000, the terminal shows the final phase-1 marker
 *       DAR_LIFECYCLE_FLOOD 005000.
 *
 *   disconnecting-viewer-isolated
 *     – A raw stalled daemon client connects after phase 1, calls
 *       waitForAttached(), then pauseReads(). CONTINUE is sent via the
 *       browser terminal to release phase 2. The stalled client's OS receive
 *       buffer fills; after the daemon's 5-second write timeout the client is
 *       evicted (socket closed / RST received). The subcheck fails explicitly
 *       if eviction does not occur — it does not accept mere pause as isolation.
 *       NOTE: on platforms with TCP receive-buffer auto-tuning that exceeds
 *       the total phase-2 output (~125 KB), OS-level backpressure may not
 *       saturate and this subcheck will fail with a blocker message.
 *
 *   healthy-viewer-stays-live
 *     – After the stalled client is isolated the browser terminal continues
 *       to receive output and shows DAR_LIFECYCLE_FLOOD 010000.
 *
 *   session-finalizes-after-flood
 *     – After PTY exit the session metadata has status=completed, exitCode=0,
 *       and a nonempty completedAt; final scrollback contains the terminal
 *       phase-2 marker.
 *
 *   daemon-remains-panic-free
 *     – The daemon log contains no panic/panicked/fatal-actor-failure strings
 *       that would indicate a Rust panic or unrecoverable actor failure.
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { BuildArtifacts } from "../build-cache.js";
import { DaemonClient } from "../drivers/daemon-client.js";
import { PtyDriver, type PtyDriverDependencies, type PtySpawnSpec } from "../drivers/pty.js";
import { parseSocketRef, type SocketRef } from "../drivers/socket-probe.js";
import type { RuntimeContext } from "../runtime-supervisor.js";
import type { SessionLedger, SessionStatus } from "../session-ledger.js";
import type { SubcheckDefinition } from "../subchecks.js";
import type { HarnessPlatform, SubcheckResult } from "../types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const LOCAL_COLS = 80;
const LOCAL_ROWS = 24;

const PTY_INPUT_ARTIFACT = "pty/input.log";
const PTY_OUTPUT_ARTIFACT = "pty/output.log";

/** Total flood count: split into two phases of FLOOD_COUNT/2 lines each. */
const FLOOD_COUNT = 10_000;

/** Marker for the last line of phase 1 (lines 1..5000). */
const PHASE1_MARKER = `DAR_LIFECYCLE_FLOOD ${String(FLOOD_COUNT / 2).padStart(6, "0")}`;

/** Marker for the last line of phase 2 (lines 5001..10000). */
const PHASE2_MARKER = `DAR_LIFECYCLE_FLOOD ${String(FLOOD_COUNT).padStart(6, "0")}`;

const FIND_SESSION_TIMEOUT_MS = 30_000;
const PHASE1_BROWSER_TIMEOUT_MS = 60_000;
const STALLED_ATTACH_TIMEOUT_MS = 10_000;
/**
 * Time to keep the socket paused before calling waitForClosed().
 *
 * The daemon's write timeout is 5 seconds. We wait 6 seconds so that the
 * timeout has definitively fired and the RST/FIN is already queued before
 * we resume reads to detect it. On platforms with large auto-tuned TCP buffers
 * the OS buffer may never saturate; the waitForClosed() call will then time
 * out and disconnecting-viewer-isolated fails with an explicit blocker message.
 */
const STALL_PRE_WAIT_MS = 6_000;
const EVICTION_DETECT_TIMEOUT_MS = 4_000;
const PHASE2_BROWSER_TIMEOUT_MS = 60_000;
const FINALIZATION_TIMEOUT_MS = 60_000;
const PTY_EXIT_TIMEOUT_MS = 60_000;

/**
 * Deny patterns for the daemon log panic-free check. Only high-signal Rust
 * panic / fatal-actor-failure tokens are denied; normal error words ("error",
 * "failed", "warn") are accepted.
 */
const DAEMON_PANIC_DENY_PATTERNS = [
  /\bpanicked\b/i,
  /\bpanic at\b/i,
  /\bfatal actor failure\b/i,
] as const;

// ── Subcheck definitions ──────────────────────────────────────────────────────

export const DAR_08_SUBCHECKS = [
  {
    name: "healthy-viewer-receives-initial-stream",
    title:
      "Browser desktop terminal shows DAR_LIFECYCLE_FLOOD 005000 after phase-1 flood completes",
  },
  {
    name: "disconnecting-viewer-isolated",
    title:
      "Stalled raw daemon client is evicted (socket closed) after OS receive-buffer saturation within deadline",
  },
  {
    name: "healthy-viewer-stays-live",
    title:
      "Browser terminal continues to receive output and shows DAR_LIFECYCLE_FLOOD 010000 after stalled client is isolated",
  },
  {
    name: "session-finalizes-after-flood",
    title:
      "Session finalizes with status=completed, exitCode=0, nonempty completedAt, and phase-2 marker in scrollback",
  },
  {
    name: "daemon-remains-panic-free",
    title:
      "Daemon log contains no panic / panicked / fatal-actor-failure strings after high-volume flood with concurrent viewer",
  },
] as const satisfies readonly SubcheckDefinition[];

export type Dar08SubcheckName = (typeof DAR_08_SUBCHECKS)[number]["name"];

export const DAR_08_SUBCHECK_NAMES: readonly Dar08SubcheckName[] = DAR_08_SUBCHECKS.map(
  (s) => s.name
);

const DAR_08_SUBCHECKS_BY_NAME = new Map(
  DAR_08_SUBCHECKS.map((s) => [s.name, s] as const)
);

// ── Live session statuses ─────────────────────────────────────────────────────

const LIVE_SESSION_STATUSES = new Set<SessionStatus>([
  "running",
  "acknowledged",
  "needs-attention",
  "paused",
]);

// ── Public context / dependency interfaces ────────────────────────────────────

export interface Dar08BrowserSurface {
  readonly name: string;
  readonly viewerId: string;
  open(baseUrl: string, deadline: number): Promise<void>;
  openTerminal(id: string, deadline: number): Promise<void>;
  sendTerminalLine(text: string): Promise<void>;
  waitForTerminalText(text: string, deadline: number): Promise<void>;
  close(): Promise<void>;
}

export interface Dar08BrowserDriver {
  createSurface(options: {
    name: string;
    viewport: { width: number; height: number };
  }): Promise<Dar08BrowserSurface>;
}

export interface Dar08Context {
  platform: HarnessPlatform;
  overallDeadline: number | Date;
  build: Pick<BuildArtifacts, "clientPath" | "fixturePath">;
  runtime: Pick<RuntimeContext, "root" | "home" | "baseUrl" | "env"> & {
    artifacts: Pick<RuntimeContext["artifacts"], "dir" | "appendText">;
    sessions: Pick<
      SessionLedger,
      "track" | "waitForTerminalStatus" | "read"
    >;
  };
}

export interface Dar08Pty {
  expectRaw(marker: string, deadline: number): Promise<void>;
  waitForExit(deadline: number): Promise<number>;
  kill(): void;
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

export interface Dar08Dependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  createUuid?: () => string;
  spawnPty?: (spec: PtySpawnSpec, deps: PtyDriverDependencies) => Dar08Pty;
  createBrowserDriver?: (context: Dar08Context) => Dar08BrowserDriver;
  findSession?: (options: FindSessionOptions) => Promise<SessionMetaLike | undefined>;
  readScrollback?: (home: string, id: string) => Promise<string>;
  readDaemonLog?: (home: string, id: string) => Promise<string>;
  createDaemonClient?: (ref: SocketRef) => DaemonClient;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultSpawnPty(spec: PtySpawnSpec, deps: PtyDriverDependencies): Dar08Pty {
  return PtyDriver.spawn(spec, deps);
}

async function defaultFindSession(
  options: FindSessionOptions
): Promise<SessionMetaLike | undefined> {
  const { readdir, readFile } = await import("node:fs/promises");
  let entries: string[];
  try {
    entries = await readdir(join(options.home, "sessions"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    try {
      const raw = await readFile(join(options.home, "sessions", `${id}.json`), "utf8");
      const meta = JSON.parse(raw) as SessionMetaLike;
      if (meta.name === options.expectedName || meta.id === options.expectedName) {
        return meta;
      }
    } catch {
      // Skip unreadable entries.
    }
  }
  return undefined;
}

async function defaultReadScrollback(home: string, id: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(join(home, "sessions", `${id}.scrollback`), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

async function defaultReadDaemonLog(home: string, id: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(join(home, "logs", "daemon", `${id}.log`), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

function asAbsoluteDeadline(d: number | Date): number {
  return d instanceof Date ? d.getTime() : d;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

function sessionName(runId: string): string {
  return `DAR-08-${runId.slice(0, 8)}`;
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
  name: Dar08SubcheckName,
  status: "passed" | "failed",
  durationMs: number,
  options: { message?: string; evidence?: string[] } = {}
): SubcheckResult {
  const definition = DAR_08_SUBCHECKS_BY_NAME.get(name);
  if (!definition) throw new Error(`Unknown DAR-08 subcheck: ${name}`);
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
    const v = await producer();
    if (v !== undefined) return v;
    if (now() >= deadline) throw new Error(timeoutMessage);
    await sleep(Math.max(1, Math.min(pollIntervalMs, deadline - now())));
  }
}

// ── Main scenario runner ──────────────────────────────────────────────────────

export async function runDar08(
  context: Dar08Context,
  deps: Dar08Dependencies = {}
): Promise<SubcheckResult[]> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? 100;
  const createUuid = deps.createUuid ?? (() => randomUUID());
  const spawnPty = deps.spawnPty ?? defaultSpawnPty;
  const findSession = deps.findSession ?? defaultFindSession;
  const readScrollback = deps.readScrollback ?? defaultReadScrollback;
  const readDaemonLog = deps.readDaemonLog ?? defaultReadDaemonLog;
  const createDaemonClient =
    deps.createDaemonClient ?? ((ref: SocketRef) => new DaemonClient(ref));

  const overallDeadline = asAbsoluteDeadline(context.overallDeadline);
  const runId = createUuid();
  const token = `dar08-${runId.slice(0, 8)}`;
  const name = sessionName(runId);

  const results: SubcheckResult[] = [];

  // ── Shared state ────────────────────────────────────────────────────────────
  const evidence: string[] = [];
  let sessionId: string | undefined;
  let socketRef: SocketRef | undefined;
  let pty: Dar08Pty | undefined;
  let browser: Dar08BrowserSurface | undefined;
  let stalledClient: DaemonClient | undefined;
  const probeTranscript: string[] = [];
  let spawnError: string | undefined;

  // ── Spawn PTY ───────────────────────────────────────────────────────────────
  const ptySpec: PtySpawnSpec = {
    file: resolve(context.build.clientPath),
    args: [
      "run",
      "--name",
      name,
      resolve(context.build.fixturePath),
      "lifecycle-probe",
      "flood",
      String(FLOOD_COUNT),
      token,
    ],
    cwd: context.runtime.root,
    env: context.runtime.env,
    cols: LOCAL_COLS,
    rows: LOCAL_ROWS,
    inputPath: PTY_INPUT_ARTIFACT,
    outputPath: PTY_OUTPUT_ARTIFACT,
  };

  try {
    pty = spawnPty(ptySpec, {
      now,
      appendText: context.runtime.artifacts.appendText.bind(context.runtime.artifacts),
    });
  } catch (error) {
    spawnError = `Failed to spawn PTY: ${stringifyError(error)}`;
  }

  // ── Find live session + valid socket ref ────────────────────────────────────
  if (pty && !spawnError) {
    const findDeadline = Math.min(overallDeadline, now() + FIND_SESSION_TIMEOUT_MS);
    let lastLoggedRef: string | undefined;

    try {
      const found = await waitForValue(
        findDeadline,
        now,
        sleep,
        pollIntervalMs,
        async (): Promise<{ id: string; ref: SocketRef } | undefined> => {
          const meta = await findSession({ home: context.runtime.home, expectedName: name });
          if (meta === undefined) return undefined;
          if (!LIVE_SESSION_STATUSES.has(meta.status)) return undefined;

          const sp = meta.socketPath;
          if (typeof sp !== "string" || sp.length === 0) return undefined;

          let ref: SocketRef;
          try {
            ref = parseSocketRef(sp);
          } catch (e) {
            if (sp !== lastLoggedRef) {
              probeTranscript.push(`socket-placeholder: ${sp} — ${stringifyError(e)}`);
              lastLoggedRef = sp;
            }
            return undefined;
          }
          return { id: meta.id, ref };
        },
        `Timed out waiting for session "${name}" to publish a valid socket path`
      );

      sessionId = found.id;
      socketRef = found.ref;
      context.runtime.sessions.track(sessionId);
      evidence.push(
        sessionMetaEvidencePath(sessionId),
        scrollbackEvidencePath(sessionId),
        daemonLogEvidencePath(sessionId)
      );
      probeTranscript.push(`captured-socket-ref: ${found.ref.raw} (${found.ref.kind})`);
    } catch (error) {
      spawnError = `Failed to find session: ${stringifyError(error)}`;
    }
  }

  if (probeTranscript.length > 0) evidence.push("socket-probe-transcript.log");

  // ── Open browser surface ────────────────────────────────────────────────────
  if (pty && !spawnError && sessionId) {
    try {
      const browserDriver = deps.createBrowserDriver?.(context);
      if (!browserDriver) {
        throw new Error("No browser driver available (prerequisite: createBrowserDriver must be injected)");
      }
      browser = await browserDriver.createSurface({
        name: "desktop-healthy",
        viewport: { width: 1280, height: 900 },
      });

      const openDeadline = Math.min(overallDeadline, now() + 30_000);
      await browser.open(context.runtime.baseUrl, openDeadline);
      await browser.openTerminal(sessionId, openDeadline);
      probeTranscript.push("browser-terminal-opened");
    } catch (error) {
      spawnError = `Failed to open browser terminal: ${stringifyError(error)}`;
    }
  }

  // ── Subcheck 1: healthy-viewer-receives-initial-stream ──────────────────────
  const check1Start = now();
  {
    const checkName: Dar08SubcheckName = "healthy-viewer-receives-initial-stream";
    let result: SubcheckResult;

    if (spawnError) {
      result = subcheckResult(checkName, "failed", Math.max(0, now() - check1Start), {
        message: spawnError,
        evidence: [...evidence],
      });
    } else if (!browser) {
      result = subcheckResult(checkName, "failed", Math.max(0, now() - check1Start), {
        message: "Browser surface not available.",
        evidence: [...evidence],
      });
    } else {
      try {
        const phase1Deadline = Math.min(overallDeadline, now() + PHASE1_BROWSER_TIMEOUT_MS);
        await browser.waitForTerminalText(PHASE1_MARKER, phase1Deadline);
        probeTranscript.push(`browser-phase1-confirmed: ${PHASE1_MARKER}`);
        result = subcheckResult(checkName, "passed", Math.max(0, now() - check1Start), {
          message: `Browser terminal shows phase-1 marker: ${PHASE1_MARKER}`,
          evidence: [...evidence],
        });
      } catch (error) {
        result = subcheckResult(checkName, "failed", Math.max(0, now() - check1Start), {
          message: stringifyError(error),
          evidence: [...evidence],
        });
      }
    }

    results.push(result);
  }

  // ── Connect stalled daemon client ───────────────────────────────────────────
  if (pty && !spawnError && socketRef) {
    try {
      stalledClient = createDaemonClient(socketRef);
      const attachDeadline = Math.min(overallDeadline, now() + STALLED_ATTACH_TIMEOUT_MS);
      await stalledClient.waitForAttached(attachDeadline);
      stalledClient.pauseReads(); // Switch to stall mode — OS receive buffer fills up.
      probeTranscript.push("stalled-client-attached-and-paused");
    } catch (error) {
      probeTranscript.push(`stalled-client-attach-error: ${stringifyError(error)}`);
      stalledClient?.destroy();
      stalledClient = undefined;
    }
  }

  // ── Release phase 2 via browser CONTINUE ───────────────────────────────────
  if (pty && !spawnError && browser) {
    try {
      await browser.sendTerminalLine(`CONTINUE ${token}`);
      probeTranscript.push(`continue-sent: CONTINUE ${token}`);
    } catch (error) {
      probeTranscript.push(`continue-send-error: ${stringifyError(error)}`);
    }
  }

  // ── Subcheck 2: disconnecting-viewer-isolated ───────────────────────────────
  //
  // The stalled client's socket stay paused for STALL_PRE_WAIT_MS to give the
  // daemon's 5-second write timeout time to fire. After that window we call
  // waitForClosed() which resumes reads; if the RST/FIN is already queued it
  // resolves immediately.
  //
  // If the OS receive buffer is large enough that it never saturates (e.g. TCP
  // auto-tuning on some platforms), the timeout fires with a blocker message.
  const check2Start = now();
  {
    const checkName: Dar08SubcheckName = "disconnecting-viewer-isolated";
    let result: SubcheckResult;

    if (!stalledClient) {
      result = subcheckResult(checkName, "failed", Math.max(0, now() - check2Start), {
        message:
          "Stalled daemon client was not established before CONTINUE — eviction cannot be verified.",
        evidence: [...evidence],
      });
    } else {
      try {
        const client = stalledClient;

        // Keep reads paused long enough for the daemon write timeout (5s) to fire.
        const preWaitMs = Math.min(
          STALL_PRE_WAIT_MS,
          Math.max(0, overallDeadline - now() - EVICTION_DETECT_TIMEOUT_MS - 1000)
        );
        await sleep(preWaitMs);
        probeTranscript.push(`stall-pre-wait-elapsed: ${preWaitMs}ms`);

        // Resume reads and detect the close caused by daemon eviction.
        const evictionDeadline = Math.min(
          overallDeadline,
          now() + EVICTION_DETECT_TIMEOUT_MS
        );
        await client.waitForClosed(evictionDeadline);

        probeTranscript.push("stalled-client-eviction-confirmed");
        result = subcheckResult(checkName, "passed", Math.max(0, now() - check2Start), {
          message:
            "Stalled client socket was closed (RST/FIN) by the daemon after OS receive-buffer saturation.",
          evidence: [...evidence],
        });
      } catch (error) {
        const msg = stringifyError(error);
        const isTimeout = msg.toLowerCase().includes("timed out") || msg.toLowerCase().includes("timeout");
        const blocker = isTimeout
          ? "BLOCKER: Stalled client was not evicted within the deadline. " +
            "OS receive-buffer auto-tuning may prevent saturation on this platform. " +
            "Consider increasing flood payload per line (backward-compatible fixture extension) " +
            "or verifying the daemon write timeout (WRITE_TIMEOUT = 5s) is active."
          : msg;
        probeTranscript.push(`stalled-eviction-error: ${blocker}`);
        result = subcheckResult(checkName, "failed", Math.max(0, now() - check2Start), {
          message: blocker,
          evidence: [...evidence],
        });
      }
    }

    results.push(result);
  }

  // ── Subcheck 3: healthy-viewer-stays-live ───────────────────────────────────
  const check3Start = now();
  {
    const checkName: Dar08SubcheckName = "healthy-viewer-stays-live";
    let result: SubcheckResult;

    if (!browser || spawnError) {
      result = subcheckResult(checkName, "failed", Math.max(0, now() - check3Start), {
        message: spawnError ?? "Browser surface not available.",
        evidence: [...evidence],
      });
    } else {
      try {
        const phase2Deadline = Math.min(overallDeadline, now() + PHASE2_BROWSER_TIMEOUT_MS);
        await browser.waitForTerminalText(PHASE2_MARKER, phase2Deadline);
        probeTranscript.push(`browser-phase2-confirmed: ${PHASE2_MARKER}`);
        result = subcheckResult(checkName, "passed", Math.max(0, now() - check3Start), {
          message: `Browser terminal shows phase-2 marker: ${PHASE2_MARKER}`,
          evidence: [...evidence],
        });
      } catch (error) {
        result = subcheckResult(checkName, "failed", Math.max(0, now() - check3Start), {
          message: stringifyError(error),
          evidence: [...evidence],
        });
      }
    }

    results.push(result);
  }

  // ── Wait for PTY exit ───────────────────────────────────────────────────────
  if (pty && !spawnError) {
    const exitDeadline = Math.min(overallDeadline, now() + PTY_EXIT_TIMEOUT_MS);
    try {
      const exitCode = await pty.waitForExit(exitDeadline);
      probeTranscript.push(`pty-exit-code: ${exitCode}`);
    } catch (error) {
      probeTranscript.push(`pty-exit-error: ${stringifyError(error)}`);
    }
  }

  // ── Subcheck 4: session-finalizes-after-flood ───────────────────────────────
  const check4Start = now();
  {
    const checkName: Dar08SubcheckName = "session-finalizes-after-flood";
    let result: SubcheckResult;

    if (spawnError || !sessionId) {
      result = subcheckResult(checkName, "failed", Math.max(0, now() - check4Start), {
        message: spawnError ?? "Session was not tracked; cannot verify finalization.",
        evidence: [...evidence],
      });
    } else {
      const id = sessionId;
      try {
        const finalDeadline = Math.min(overallDeadline, now() + FINALIZATION_TIMEOUT_MS);
        const meta = await context.runtime.sessions.waitForTerminalStatus(id, finalDeadline);
        const failures: string[] = [];
        const passNotes: string[] = [];

        if (meta.status !== "completed") {
          failures.push(`status: expected completed, got ${meta.status}`);
        } else {
          passNotes.push(`status=${meta.status}`);
        }

        if (meta.exitCode !== 0) {
          failures.push(`exitCode: expected 0, got ${String(meta.exitCode)}`);
        } else {
          passNotes.push("exitCode=0");
        }

        const completedAt = meta.completedAt;
        if (typeof completedAt !== "string" || completedAt.length === 0) {
          failures.push(`completedAt: expected nonempty string, got ${String(completedAt)}`);
        } else {
          passNotes.push(`completedAt=${completedAt}`);
        }

        const scrollback = await readScrollback(context.runtime.home, id);
        if (!scrollback.includes(PHASE2_MARKER)) {
          failures.push(`scrollback does not contain phase-2 marker "${PHASE2_MARKER}"`);
        } else {
          passNotes.push(`scrollback contains ${PHASE2_MARKER}`);
        }

        if (failures.length > 0) {
          result = subcheckResult(checkName, "failed", Math.max(0, now() - check4Start), {
            message: failures.join("; "),
            evidence: [...evidence],
          });
        } else {
          result = subcheckResult(checkName, "passed", Math.max(0, now() - check4Start), {
            message: passNotes.join(", "),
            evidence: [...evidence],
          });
        }
      } catch (error) {
        result = subcheckResult(checkName, "failed", Math.max(0, now() - check4Start), {
          message: stringifyError(error),
          evidence: [...evidence],
        });
      }
    }

    results.push(result);
  }

  // ── Subcheck 5: daemon-remains-panic-free ───────────────────────────────────
  const check5Start = now();
  {
    const checkName: Dar08SubcheckName = "daemon-remains-panic-free";
    let result: SubcheckResult;

    if (!sessionId) {
      result = subcheckResult(checkName, "failed", Math.max(0, now() - check5Start), {
        message: "Session ID unknown; cannot read daemon log.",
        evidence: [...evidence],
      });
    } else {
      const id = sessionId;
      try {
        const log = await readDaemonLog(context.runtime.home, id);
        const matchedPatterns: string[] = [];
        for (const pattern of DAEMON_PANIC_DENY_PATTERNS) {
          if (pattern.test(log)) {
            matchedPatterns.push(pattern.toString());
          }
        }

        if (matchedPatterns.length > 0) {
          result = subcheckResult(checkName, "failed", Math.max(0, now() - check5Start), {
            message: `Daemon log contains panic/fatal patterns: ${matchedPatterns.join(", ")}`,
            evidence: [...evidence],
          });
        } else {
          const logLen = log.length;
          result = subcheckResult(checkName, "passed", Math.max(0, now() - check5Start), {
            message: `Daemon log (${logLen} bytes) contains no panic or fatal-actor-failure patterns.`,
            evidence: [...evidence],
          });
        }
      } catch (error) {
        result = subcheckResult(checkName, "failed", Math.max(0, now() - check5Start), {
          message: stringifyError(error),
          evidence: [...evidence],
        });
      }
    }

    results.push(result);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  await Promise.allSettled([
    browser?.close().catch(() => { /* best-effort */ }),
    Promise.resolve(stalledClient?.destroy()),
    Promise.resolve(pty?.kill()),
  ]);

  if (probeTranscript.length > 0) {
    try {
      await context.runtime.artifacts.appendText(
        "probe-transcript.log",
        probeTranscript.map((l) => `[DAR-08] ${l}`).join("\n") + "\n"
      );
    } catch {
      // Best-effort.
    }
  }

  return results;
}
