/**
 * DAR-09 — SIGINT, SIGTERM, and Windows process termination.
 *
 * Six subchecks:
 *
 *   unix-sigint-graceful
 *     – Launches `lifecycle-probe signal-hold` headless; discovers the session
 *       host via process discovery; asserts host pid != daemonChildPid; sends
 *       SIGINT; verifies host exits, socket closes, metadata terminal
 *       (failed/nonzero exitCode/completedAt), final scrollback contains
 *       HOLD_READY, daemon log panic-free.
 *
 *   unix-sigterm-graceful
 *     – Same as above but with SIGTERM.
 *
 *   repeated-signal-idempotency
 *     – Re-resolves the host immediately before each of two SIGINT signals.
 *       If the host is gone before the second resolve, the subcheck fails
 *       without reusing a stale PID. Verifies one clean terminal finalization
 *       and no daemon panic.
 *
 *   attached-resize-path
 *     – PTY-attached `control-probe` session; waits for DAR_CONTROL_READY;
 *       resizes to 101x31; expects DAR_CONTROL_RESIZE 1 101 31 and metadata
 *       cols/rows update; then sends 'q' and verifies finalization.
 *
 *   windows-forced-host-termination
 *     – Headless signal-hold on Windows; discovers host via PS discovery;
 *       force-terminates via PowerShell Stop-Process; verifies host absent and
 *       socket closed; asserts abrupt semantics (no completedAt); runs
 *       `climon kill <id>` to reconcile.
 *
 *   windows-console-resize-poller
 *     – PTY-attached control-probe on Windows; resizes once to 101x31; verifies
 *       exactly one DAR_CONTROL_RESIZE marker; then 'q' and finalization.
 *
 * Non-applicable subchecks return `passed` with an explicit N/A message so
 * the contract is stable across platforms.
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { BuildArtifacts } from "../build-cache.js";
import { PtyDriver, type PtyDriverDependencies, type PtySpawnSpec } from "../drivers/pty.js";
import { parseSocketRef, SocketProbe, type SocketRef } from "../drivers/socket-probe.js";
import type { CommandResult, CommandSpec } from "../command.js";
import { DaemonClient } from "../drivers/daemon-client.js";
import { resolveSessionHost, type SessionHost } from "../drivers/process-discovery.js";
import type { RuntimeContext } from "../runtime-supervisor.js";
import type { SessionLedger, SessionStatus } from "../session-ledger.js";
import type { SubcheckDefinition } from "../subchecks.js";
import type { HarnessPlatform, SubcheckResult } from "../types.js";
import { HarnessError } from "../types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const LOCAL_COLS = 80;
const LOCAL_ROWS = 24;
const RESIZE_COLS = 101;
const RESIZE_ROWS = 31;

const HOLD_READY_MARKER = "DAR_LIFECYCLE_HOLD_READY";
const READY_MARKER_PREFIX = "DAR_CONTROL_READY";
const RESIZE_MARKER_BASE = "DAR_CONTROL_RESIZE";
const RESIZE_MARKER = `DAR_CONTROL_RESIZE 1 ${RESIZE_COLS} ${RESIZE_ROWS}`;

const FIND_SESSION_TIMEOUT_MS = 30_000;
const READINESS_TIMEOUT_MS = 30_000;
const SIGNAL_SETTLE_TIMEOUT_MS = 30_000;
const FINALIZATION_TIMEOUT_MS = 60_000;
const SOCKET_CLEANUP_TIMEOUT_MS = 30_000;
const PTY_EXIT_TIMEOUT_MS = 30_000;
const HOST_LIVENESS_TIMEOUT_MS = 15_000;

/** Deny patterns for daemon log panic-free check. */
const DAEMON_PANIC_DENY = [
  /\bpanicked\b/i,
  /\bpanic at\b/i,
  /\bfatal actor failure\b/i,
];

const LIVE_SESSION_STATUSES = new Set<SessionStatus>([
  "running",
  "acknowledged",
  "needs-attention",
  "paused",
]);

// ── Subcheck definitions ──────────────────────────────────────────────────────

export const DAR_09_SUBCHECKS = [
  {
    name: "unix-sigint-graceful",
    title:
      "Host process exits gracefully on SIGINT; daemon socket closes; metadata terminal with failed status and nonzero exitCode",
  },
  {
    name: "unix-sigterm-graceful",
    title:
      "Host process exits gracefully on SIGTERM; daemon socket closes; metadata terminal with failed status and nonzero exitCode",
  },
  {
    name: "repeated-signal-idempotency",
    title:
      "Repeated SIGINT on the same session is idempotent: one clean terminal finalization, no panic",
  },
  {
    name: "attached-resize-path",
    title:
      "Attached resize from 80x24 to 101x31 triggers DAR_CONTROL_RESIZE 1 101 31 and metadata cols/rows update",
  },
  {
    name: "windows-forced-host-termination",
    title:
      "Windows forced host termination via Stop-Process leaves session stale then reconciled via climon kill",
  },
  {
    name: "windows-console-resize-poller",
    title:
      "Windows console resize poller emits exactly one resize marker without a duplicate on first resize",
  },
] as const satisfies readonly SubcheckDefinition[];

export type Dar09SubcheckName = (typeof DAR_09_SUBCHECKS)[number]["name"];

export const DAR_09_SUBCHECK_NAMES: readonly Dar09SubcheckName[] = DAR_09_SUBCHECKS.map(
  (s) => s.name
);

const DAR_09_SUBCHECKS_BY_NAME = new Map(
  DAR_09_SUBCHECKS.map((s) => [s.name, s] as const)
);

// ── Public context/dependency interfaces ─────────────────────────────────────

export interface Dar09Context {
  platform: HarnessPlatform;
  overallDeadline: number | Date;
  build: Pick<BuildArtifacts, "clientPath" | "fixturePath">;
  runtime: Pick<RuntimeContext, "root" | "home" | "env"> & {
    artifacts: Pick<RuntimeContext["artifacts"], "dir" | "appendText">;
    sessions: Pick<SessionLedger, "track" | "waitForTerminalStatus" | "read">;
  };
}

export interface Dar09Pty {
  expectRaw(marker: string, deadline: number): Promise<void>;
  waitForExit(deadline: number): Promise<number>;
  kill(): void;
  writeText(text: string): void;
  resize(cols: number, rows: number): void;
  /** Returns all PTY output accumulated so far as a raw string. */
  readLocalOutput(): string;
}

interface DaemonClientLike {
  waitForAttached(deadline: number): Promise<void>;
  waitForOutput(marker: string, deadline: number): Promise<void>;
  destroy(): void;
}

interface ResolveHostOptions {
  daemonChildPid?: number;
  artifactsDir: string;
}

export interface Dar09Dependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  createUuid?: () => string;
  spawnPty?: (spec: PtySpawnSpec, deps: PtyDriverDependencies) => Dar09Pty;
  runCommand?: (spec: CommandSpec) => Promise<CommandResult>;
  findSession?: (options: { home: string; expectedName: string }) => Promise<SessionMetaLike | undefined>;
  readSessionMeta?: (id: string, home: string) => Promise<SessionMetaLike | undefined>;
  readScrollback?: (home: string, id: string) => Promise<string>;
  createSocketProbe?: () => SocketProbeLike;
  resolveHost?: (sessionId: string, options: ResolveHostOptions) => Promise<SessionHost>;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, signal: "SIGINT" | "SIGTERM") => void;
  terminateWindowsProcess?: (pid: number, artifactsDir: string) => Promise<void>;
  killSessionRecord?: (sessionId: string, clientPath: string, cwd: string, env: Record<string, string | undefined>, artifactsDir: string) => Promise<void>;
  readDaemonLog?: (home: string, id: string) => Promise<string | undefined>;
  createDaemonClient?: (ref: SocketRef) => DaemonClientLike;
}

interface SocketProbeLike {
  waitOpen(ref: SocketRef, deadline: number): Promise<void>;
  waitClosed(ref: SocketRef, deadline: number): Promise<void>;
  probeOnce(ref: SocketRef): Promise<boolean>;
}

interface SessionMetaLike extends Record<string, unknown> {
  id: string;
  status: SessionStatus;
  exitCode?: number;
  completedAt?: string;
  socketPath?: string;
  daemonPid?: number;
  cols?: number;
  rows?: number;
}

interface FindSessionOptions {
  home: string;
  expectedName: string;
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

function completedLines(raw: string): string[] {
  const normalized = raw.replaceAll("\r\n", "\n");
  const parts = normalized.split("\n");
  const lines = normalized.endsWith("\n") ? parts : parts.slice(0, -1);
  return lines.map((l) => stripAnsi(l).trim()).filter((l) => l.length > 0);
}

const SESSION_ID_SAFE_RE = /^[A-Za-z0-9._~-]+$/;

/**
 * Parse the session ID from Rust launcher stdout.
 * The Rust client prints exactly one plain `[A-Za-z0-9._~-]+` line.
 * Throws HarnessError "prerequisite" on empty, malformed, or ambiguous output.
 */
export function parseHeadlessSessionId(rawOutput: string): string {
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

function countOccurrences(text: string, marker: string): number {
  if (marker.length === 0) return 0;
  let count = 0;
  let offset = 0;
  for (;;) {
    const i = text.indexOf(marker, offset);
    if (i === -1) break;
    count += 1;
    offset = i + 1;
  }
  return count;
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

async function defaultReadSessionMeta(
  id: string,
  home: string
): Promise<SessionMetaLike | undefined> {
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(join(home, "sessions", `${id}.json`), "utf8");
    return JSON.parse(raw) as SessionMetaLike;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKillProcess(pid: number, signal: "SIGINT" | "SIGTERM"): void {
  process.kill(pid, signal);
}

async function defaultTerminateWindowsProcess(
  pid: number,
  artifactsDir: string
): Promise<void> {
  const { BunCommandRunner } = await import("../command.js");
  const runner = new BunCommandRunner();
  const result = await runner.run({
    file: "powershell.exe",
    args: [
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      `Stop-Process -Id ${pid} -Force`,
    ],
    cwd: "C:\\",
    env: {},
    timeoutMs: 15_000,
    stdoutPath: join(artifactsDir, "stop-process.stdout.log"),
    stderrPath: join(artifactsDir, "stop-process.stderr.log"),
  });
  if (result.code !== 0) {
    throw new HarnessError(
      "assertion",
      `Stop-Process failed with exit code ${result.code}: ${result.stderr.slice(0, 200)}`
    );
  }
}

async function defaultKillSessionRecord(
  sessionId: string,
  clientPath: string,
  cwd: string,
  env: Record<string, string | undefined>,
  artifactsDir: string
): Promise<void> {
  const { BunCommandRunner } = await import("../command.js");
  const runner = new BunCommandRunner();
  const result = await runner.run({
    file: clientPath,
    args: ["kill", sessionId],
    cwd,
    env,
    timeoutMs: 30_000,
    stdoutPath: join(artifactsDir, "kill-reconcile.stdout.log"),
    stderrPath: join(artifactsDir, "kill-reconcile.stderr.log"),
  });
  if (result.code !== 0) {
    throw new HarnessError(
      "assertion",
      `climon kill exited with code ${result.code}: ${result.stderr.slice(0, 200)}`
    );
  }
}

async function defaultReadDaemonLog(
  home: string,
  id: string
): Promise<string | undefined> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(join(home, "logs", "daemon", `${id}.log`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function subcheckResult(
  name: Dar09SubcheckName,
  status: "passed" | "failed",
  durationMs: number,
  options: { message?: string; evidence?: string[] } = {}
): SubcheckResult {
  const definition = DAR_09_SUBCHECKS_BY_NAME.get(name);
  if (!definition) throw new Error(`Unknown DAR-09 subcheck: ${name}`);
  return {
    name,
    title: definition.title,
    status,
    durationMs,
    message: options.message,
    evidence: options.evidence ?? [],
  };
}

function naResult(name: Dar09SubcheckName, durationMs = 0): SubcheckResult {
  return subcheckResult(name, "passed", durationMs, {
    message: `N/A: subcheck does not apply to this platform`,
  });
}

function sessionName(runId: string, variant: string): string {
  return `DAR-09-${variant}-${runId.slice(0, 8)}`;
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

// ── Session launch helpers ────────────────────────────────────────────────────

interface LaunchedSession {
  sessionId: string;
  socketRef: SocketRef;
  meta: SessionMetaLike;
  evidence: string[];
  transcript: string[];
}

async function launchHeadlessSignalHold(
  variant: string,
  runId: string,
  context: Dar09Context,
  overallDeadline: number,
  deps: Required<Pick<
    Dar09Dependencies,
    "now" | "sleep" | "pollIntervalMs" | "runCommand" | "findSession"
  >>
): Promise<LaunchedSession> {
  const { now, sleep, pollIntervalMs, runCommand, findSession } = deps;
  const evidence: string[] = [];
  const transcript: string[] = [];

  const name = sessionName(runId, variant);

  // Launch headless
  const launchResult = await runCommand({
    file: resolve(context.build.clientPath),
    args: [
      "run",
      "--headless",
      "--name",
      name,
      resolve(context.build.fixturePath),
      "lifecycle-probe",
      "signal-hold",
    ],
    cwd: context.runtime.root,
    env: context.runtime.env,
    timeoutMs: 60_000,
    stdoutPath: join(context.runtime.artifacts.dir, `${variant}/launcher.stdout.log`),
    stderrPath: join(context.runtime.artifacts.dir, `${variant}/launcher.stderr.log`),
  });

  evidence.push(
    `${variant}/launcher.stdout.log`,
    `${variant}/launcher.stderr.log`
  );

  if (launchResult.code !== 0) {
    throw new Error(
      `Launcher exited with code ${launchResult.code}: ${launchResult.stderr.slice(0, 200)}`
    );
  }

  // Parse session ID from launcher stdout — throws on malformed/ambiguous output
  const parsedId = parseHeadlessSessionId(launchResult.stdout);
  transcript.push(`launcher-session-id: ${parsedId}`);

  // Find session by parsed ID — poll until live with valid socket
  const findDeadline = Math.min(overallDeadline, now() + FIND_SESSION_TIMEOUT_MS);
  let lastLoggedSocket: string | undefined;

  const found = await waitForValue(
    findDeadline,
    now,
    sleep,
    pollIntervalMs,
    async (): Promise<{ id: string; socketRef: SocketRef; meta: SessionMetaLike } | undefined> => {
      const meta = await findSession({ home: context.runtime.home, expectedName: parsedId });

      if (!meta) return undefined;
      if (!LIVE_SESSION_STATUSES.has(meta.status)) return undefined;

      const sp = meta.socketPath;
      if (typeof sp !== "string" || sp.length === 0) {
        if (lastLoggedSocket !== "") {
          transcript.push("no-socket-path");
          lastLoggedSocket = "";
        }
        return undefined;
      }

      let socketRef: SocketRef;
      try {
        socketRef = parseSocketRef(sp);
      } catch (e) {
        if (sp !== lastLoggedSocket) {
          transcript.push(`socket-placeholder: ${sp}`);
          lastLoggedSocket = sp;
        }
        return undefined;
      }

      return { id: meta.id, socketRef, meta };
    },
    `Timed out waiting for session "${name}" to publish a valid socket`
  );

  context.runtime.sessions.track(found.id);
  evidence.push(
    sessionMetaEvidencePath(found.id),
    scrollbackEvidencePath(found.id),
    daemonLogEvidencePath(found.id)
  );
  transcript.push(`session-found: ${found.id}`, `socket: ${found.socketRef.raw}`);

  return {
    sessionId: found.id,
    socketRef: found.socketRef,
    meta: found.meta,
    evidence,
    transcript,
  };
}

// ── Unix signal subcheck ──────────────────────────────────────────────────────

async function runUnixSignalSubcheck(
  checkName: "unix-sigint-graceful" | "unix-sigterm-graceful",
  signal: "SIGINT" | "SIGTERM",
  context: Dar09Context,
  overallDeadline: number,
  deps: Required<Pick<
    Dar09Dependencies,
    | "now"
    | "sleep"
    | "pollIntervalMs"
    | "createUuid"
    | "runCommand"
    | "findSession"
    | "readScrollback"
    | "readDaemonLog"
    | "createSocketProbe"
    | "resolveHost"
    | "isProcessAlive"
    | "killProcess"
    | "createDaemonClient"
  >>
): Promise<SubcheckResult> {
  const {
    now,
    sleep,
    pollIntervalMs,
    createUuid,
    runCommand,
    findSession,
    readScrollback,
    readDaemonLog,
    createSocketProbe,
    resolveHost,
    isProcessAlive,
    killProcess,
    createDaemonClient,
  } = deps;

  const startedAt = now();
  const variant = signal === "SIGINT" ? "sigint" : "sigterm";
  const evidence: string[] = [];
  const transcript: string[] = [];

  const flushTranscript = () =>
    context.runtime.artifacts.appendText(
      `${variant}/probe-transcript.log`,
      transcript.join("\n") + "\n"
    );

  try {
    const runId = createUuid();

    // 1. Launch headless signal-hold
    const launched = await launchHeadlessSignalHold(
      variant,
      runId,
      context,
      overallDeadline,
      { now, sleep, pollIntervalMs, runCommand, findSession }
    );

    evidence.push(...launched.evidence, `${variant}/probe-transcript.log`);
    transcript.push(...launched.transcript);

    const { sessionId, socketRef, meta } = launched;
    const daemonChildPid =
      typeof meta.daemonPid === "number" ? meta.daemonPid : undefined;

    // 2. Connect DaemonClient and wait for HOLD_READY
    const client = createDaemonClient(socketRef);
    try {
      const readinessDeadline = Math.min(overallDeadline, now() + READINESS_TIMEOUT_MS);
      await client.waitForAttached(readinessDeadline);
      await client.waitForOutput(HOLD_READY_MARKER, readinessDeadline);
      transcript.push("daemon-client-hold-ready-confirmed");
    } finally {
      client.destroy();
    }

    // 3. Re-read metadata to get latest daemonPid
    const freshMeta = await deps.findSession({
      home: context.runtime.home,
      expectedName: sessionId,
    });
    const freshDaemonChildPid =
      freshMeta && typeof freshMeta.daemonPid === "number"
        ? freshMeta.daemonPid
        : daemonChildPid;

    // 4. Resolve host FRESH before signal
    const host = await resolveHost(sessionId, {
      daemonChildPid: freshDaemonChildPid,
      artifactsDir: join(context.runtime.artifacts.dir, variant),
    });
    transcript.push(`host-discovered: pid=${host.pid}`);

    // 5. Assert host pid != daemonChildPid
    if (freshDaemonChildPid !== undefined && host.pid === freshDaemonChildPid) {
      await flushTranscript();
      return subcheckResult(checkName, "failed", Math.max(0, now() - startedAt), {
        message: `host pid ${host.pid} equals metadata daemonPid ${freshDaemonChildPid} — child PID guard triggered`,
        evidence,
      });
    }

    // 6. Assert socket open before signal
    const socketProbe = createSocketProbe();
    const failures: string[] = [];
    const passNotes: string[] = [];

    const openDeadline = Math.min(overallDeadline, now() + SOCKET_CLEANUP_TIMEOUT_MS);
    try {
      await socketProbe.waitOpen(socketRef, openDeadline);
      transcript.push("socket-open-confirmed");
      passNotes.push("socket-was-open");
    } catch (e) {
      const msg = `socket not open before signal: ${stringifyError(e)}`;
      transcript.push(`socket-open-failed: ${stringifyError(e)}`);
      failures.push(msg);
    }

    // 7. Send signal
    killProcess(host.pid, signal);
    transcript.push(`signal-sent: ${signal} to pid=${host.pid}`);

    // 8. Assert host process exits
    const hostExitDeadline = Math.min(overallDeadline, now() + HOST_LIVENESS_TIMEOUT_MS);
    try {
      await waitForValue(
        hostExitDeadline,
        now,
        sleep,
        pollIntervalMs,
        async () => (isProcessAlive(host.pid) ? undefined : true),
        `Timed out waiting for host process pid=${host.pid} to exit after ${signal}`
      );
      transcript.push("host-process-exited");
      passNotes.push("host-exited");
    } catch (e) {
      const msg = `host process did not exit after ${signal}: ${stringifyError(e)}`;
      transcript.push(`host-exit-failed: ${stringifyError(e)}`);
      failures.push(msg);
    }

    // 9. Assert the monitored child also exits.
    if (freshDaemonChildPid !== undefined) {
      const childExitDeadline = Math.min(overallDeadline, now() + HOST_LIVENESS_TIMEOUT_MS);
      try {
        await waitForValue(
          childExitDeadline,
          now,
          sleep,
          pollIntervalMs,
          async () => (isProcessAlive(freshDaemonChildPid) ? undefined : true),
          `Timed out waiting for metadata daemonPid=${freshDaemonChildPid} to exit after ${signal}`
        );
        transcript.push(`child-process-exited: pid=${freshDaemonChildPid}`);
        passNotes.push("child-exited");
      } catch (e) {
        failures.push(`metadata child did not exit after ${signal}: ${stringifyError(e)}`);
      }
    }

    // 10. Assert socket closes after signal
    const cleanupDeadline = Math.min(overallDeadline, now() + SOCKET_CLEANUP_TIMEOUT_MS);
    try {
      await socketProbe.waitClosed(socketRef, cleanupDeadline);
      transcript.push("socket-closed");
      passNotes.push("socket-closed");
    } catch (e) {
      const msg = `socket did not close after ${signal}: ${stringifyError(e)}`;
      transcript.push(`socket-close-failed: ${stringifyError(e)}`);
      failures.push(msg);
    }

    // 11. Verify terminal metadata
    const finalizationDeadline = Math.min(overallDeadline, now() + FINALIZATION_TIMEOUT_MS);
    const finalMeta = await context.runtime.sessions.waitForTerminalStatus(
      sessionId,
      finalizationDeadline
    );

    if (finalMeta.status !== "failed") {
      failures.push(`status: expected failed, got ${finalMeta.status}`);
    } else {
      passNotes.push(`status=${finalMeta.status}`);
    }

    if (typeof finalMeta.exitCode !== "number" || finalMeta.exitCode === 0) {
      failures.push(`exitCode: expected nonzero, got ${String(finalMeta.exitCode)}`);
    } else {
      passNotes.push(`exitCode=${finalMeta.exitCode}`);
    }

    const completedAt = (finalMeta as SessionMetaLike).completedAt;
    if (typeof completedAt !== "string" || completedAt.length === 0) {
      failures.push(`completedAt missing`);
    } else {
      passNotes.push(`completedAt=${completedAt}`);
    }

    // 12. Check final scrollback contains HOLD_READY marker
    const scrollback = await readScrollback(context.runtime.home, sessionId);
    if (!scrollback.includes(HOLD_READY_MARKER)) {
      failures.push(`scrollback missing "${HOLD_READY_MARKER}"`);
    } else {
      passNotes.push(`scrollback-contains-${HOLD_READY_MARKER}`);
    }

    // 13. Daemon log: must exist and be panic-free
    const log = await readDaemonLog(context.runtime.home, sessionId);
    if (log === undefined) {
      failures.push("daemon log not found");
    } else {
      const panic = DAEMON_PANIC_DENY.find((p) => p.test(log));
      if (panic) {
        failures.push(`daemon log contains panic: ${panic}`);
      } else {
        passNotes.push("daemon-log-panic-free");
      }
    }

    transcript.push(
      failures.length > 0
        ? `subcheck-failures: ${failures.join("; ")}`
        : `subcheck-passed: ${passNotes.join(", ")}`
    );
    await flushTranscript();

    return subcheckResult(
      checkName,
      failures.length > 0 ? "failed" : "passed",
      Math.max(0, now() - startedAt),
      {
        message: failures.length > 0 ? failures.join("; ") : passNotes.join(", "),
        evidence,
      }
    );
  } catch (error) {
    transcript.push(`subcheck-error: ${stringifyError(error)}`);
    await flushTranscript().catch(() => undefined);
    return subcheckResult(checkName, "failed", Math.max(0, now() - startedAt), {
      message: stringifyError(error),
      evidence,
    });
  }
}

// ── Repeated-signal idempotency ───────────────────────────────────────────────

async function runRepeatedSignalIdempotency(
  context: Dar09Context,
  overallDeadline: number,
  deps: Required<Pick<
    Dar09Dependencies,
    | "now"
    | "sleep"
    | "pollIntervalMs"
    | "createUuid"
    | "runCommand"
    | "findSession"
    | "readScrollback"
    | "readDaemonLog"
    | "createSocketProbe"
    | "resolveHost"
    | "isProcessAlive"
    | "killProcess"
    | "createDaemonClient"
  >>
): Promise<SubcheckResult> {
  const {
    now,
    sleep,
    pollIntervalMs,
    createUuid,
    runCommand,
    findSession,
    readScrollback,
    readDaemonLog,
    createSocketProbe,
    resolveHost,
    isProcessAlive,
    killProcess,
    createDaemonClient,
  } = deps;

  const checkName = "repeated-signal-idempotency" as const;
  const startedAt = now();
  const evidence: string[] = [];
  const transcript: string[] = [];

  const flushTranscript = () =>
    context.runtime.artifacts.appendText(
      "repeat/probe-transcript.log",
      transcript.join("\n") + "\n"
    );

  try {
    const runId = createUuid();

    const launched = await launchHeadlessSignalHold(
      "repeat",
      runId,
      context,
      overallDeadline,
      { now, sleep, pollIntervalMs, runCommand, findSession }
    );

    evidence.push(...launched.evidence, "repeat/probe-transcript.log");
    transcript.push(...launched.transcript);

    const { sessionId, socketRef, meta } = launched;
    const daemonChildPid =
      typeof meta.daemonPid === "number" ? meta.daemonPid : undefined;

    const client = createDaemonClient(socketRef);
    try {
      const readinessDeadline = Math.min(overallDeadline, now() + READINESS_TIMEOUT_MS);
      await client.waitForAttached(readinessDeadline);
      await client.waitForOutput(HOLD_READY_MARKER, readinessDeadline);
    } finally {
      client.destroy();
    }

    const socketProbe = createSocketProbe();
    const openDeadline = Math.min(overallDeadline, now() + SOCKET_CLEANUP_TIMEOUT_MS);
    await socketProbe.waitOpen(socketRef, openDeadline);
    transcript.push("socket-open-confirmed");

    // First resolve + first signal
    const host1 = await resolveHost(sessionId, {
      daemonChildPid,
      artifactsDir: join(context.runtime.artifacts.dir, "repeat"),
    });
    transcript.push(`first-resolve: pid=${host1.pid}`);

    killProcess(host1.pid, "SIGINT");
    transcript.push(`first-sigint-sent: pid=${host1.pid}`);

    // Second resolve — must succeed and return the same pid
    const host2 = await resolveHost(sessionId, {
      daemonChildPid,
      artifactsDir: join(context.runtime.artifacts.dir, "repeat"),
    });
    transcript.push(`second-resolve: pid=${host2.pid}`);

    const failures: string[] = [];
    const passNotes: string[] = [];

    if (host2.pid !== host1.pid) {
      const msg = `second resolve returned pid ${host2.pid}, expected same pid ${host1.pid} (stale PID)`;
      failures.push(msg);
    } else {
      killProcess(host2.pid, "SIGINT");
      transcript.push(`second-sigint-sent: pid=${host2.pid}`);
      passNotes.push("second-sigint-sent");
    }

    // Wait for host to exit
    const hostExitDeadline = Math.min(overallDeadline, now() + HOST_LIVENESS_TIMEOUT_MS);
    try {
      await waitForValue(
        hostExitDeadline,
        now,
        sleep,
        pollIntervalMs,
        async () => (isProcessAlive(host1.pid) ? undefined : true),
        `Timed out waiting for host pid=${host1.pid} to exit`
      );
      transcript.push("host-exited");
      passNotes.push("host-exited");
    } catch (e) {
      failures.push(`host did not exit: ${stringifyError(e)}`);
    }

    if (daemonChildPid !== undefined) {
      const childExitDeadline = Math.min(overallDeadline, now() + HOST_LIVENESS_TIMEOUT_MS);
      try {
        await waitForValue(
          childExitDeadline,
          now,
          sleep,
          pollIntervalMs,
          async () => (isProcessAlive(daemonChildPid) ? undefined : true),
          `Timed out waiting for metadata daemonPid=${daemonChildPid} to exit`
        );
        transcript.push(`child-exited: pid=${daemonChildPid}`);
        passNotes.push("child-exited");
      } catch (e) {
        failures.push(`metadata child did not exit: ${stringifyError(e)}`);
      }
    }

    // Wait for socket close
    const closeDeadline = Math.min(overallDeadline, now() + SOCKET_CLEANUP_TIMEOUT_MS);
    try {
      await socketProbe.waitClosed(socketRef, closeDeadline);
      transcript.push("socket-closed");
      passNotes.push("socket-closed");
    } catch (e) {
      failures.push(`socket did not close: ${stringifyError(e)}`);
    }

    // Verify terminal metadata
    const finalizationDeadline = Math.min(overallDeadline, now() + FINALIZATION_TIMEOUT_MS);
    const finalMeta = await context.runtime.sessions.waitForTerminalStatus(
      sessionId,
      finalizationDeadline
    );

    if (finalMeta.status !== "failed") {
      failures.push(`status: expected failed, got ${finalMeta.status}`);
    } else {
      passNotes.push("status=failed");
    }
    if (typeof finalMeta.exitCode !== "number" || finalMeta.exitCode === 0) {
      failures.push(`exitCode: expected nonzero, got ${String(finalMeta.exitCode)}`);
    } else {
      passNotes.push(`exitCode=${finalMeta.exitCode}`);
    }
    const completedAt = (finalMeta as SessionMetaLike).completedAt;
    if (typeof completedAt !== "string" || completedAt.length === 0) {
      failures.push("completedAt missing");
    } else {
      passNotes.push(`completedAt=${completedAt}`);
    }

    // Scrollback
    const scrollback = await readScrollback(context.runtime.home, sessionId);
    if (!scrollback.includes(HOLD_READY_MARKER)) {
      failures.push(`scrollback missing "${HOLD_READY_MARKER}"`);
    } else {
      passNotes.push("scrollback-ok");
    }

    // Daemon log: must exist and panic-free
    const log = await readDaemonLog(context.runtime.home, sessionId);
    if (log === undefined) {
      failures.push("daemon log not found");
    } else {
      const panic = DAEMON_PANIC_DENY.find((p) => p.test(log));
      if (panic) {
        failures.push(`daemon log panic: ${panic}`);
      } else {
        passNotes.push("daemon-log-panic-free");
      }
    }

    transcript.push(
      failures.length > 0
        ? `subcheck-failures: ${failures.join("; ")}`
        : `subcheck-passed: ${passNotes.join(", ")}`
    );
    await flushTranscript();

    return subcheckResult(
      checkName,
      failures.length > 0 ? "failed" : "passed",
      Math.max(0, now() - startedAt),
      {
        message: failures.length > 0 ? failures.join("; ") : passNotes.join(", "),
        evidence,
      }
    );
  } catch (error) {
    const msg = stringifyError(error);
    transcript.push(`subcheck-error: ${msg}`);
    await flushTranscript().catch(() => undefined);
    return subcheckResult(checkName, "failed", Math.max(0, now() - startedAt), {
      message: msg,
      evidence,
    });
  }
}

// ── Attached resize path ──────────────────────────────────────────────────────

async function runAttachedResizePath(
  context: Dar09Context,
  overallDeadline: number,
  deps: Required<Pick<
    Dar09Dependencies,
    | "now"
    | "sleep"
    | "pollIntervalMs"
    | "createUuid"
    | "spawnPty"
    | "findSession"
    | "readSessionMeta"
    | "createSocketProbe"
  >>
): Promise<SubcheckResult> {
  const {
    now,
    sleep,
    pollIntervalMs,
    createUuid,
    spawnPty,
    findSession,
    readSessionMeta,
  } = deps;

  const checkName = "attached-resize-path" as const;
  const startedAt = now();
  const evidence: string[] = ["pty/resize/input.log", "pty/resize/output.log", "resize/probe-transcript.log"];
  const transcript: string[] = [];
  const flushTranscript = () =>
    context.runtime.artifacts.appendText(
      "resize/probe-transcript.log",
      transcript.join("\n") + "\n"
    );

  let pty: Dar09Pty | undefined;

  try {
    const runId = createUuid();
    const name = sessionName(runId, "resize");

    const ptySpec: PtySpawnSpec = {
      file: resolve(context.build.fixturePath),
      args: [
        "mode-probe",
        "--",
        resolve(context.build.clientPath),
        "run",
        "--name",
        name,
        resolve(context.build.fixturePath),
        "control-probe",
      ],
      cwd: context.runtime.root,
      env: context.runtime.env,
      cols: LOCAL_COLS,
      rows: LOCAL_ROWS,
      inputPath: "pty/resize/input.log",
      outputPath: "pty/resize/output.log",
    };

    pty = spawnPty(ptySpec, {
      now,
      appendText: context.runtime.artifacts.appendText.bind(context.runtime.artifacts),
    });

    // Wait for ready marker — just the prefix; control-probe emits DAR_CONTROL_READY on its own line
    const readyDeadline = Math.min(overallDeadline, now() + READINESS_TIMEOUT_MS);
    await pty.expectRaw(READY_MARKER_PREFIX, readyDeadline);
    transcript.push(`ready-marker-observed: ${READY_MARKER_PREFIX}`);

    // Find session by name
    const findDeadline = Math.min(overallDeadline, now() + FIND_SESSION_TIMEOUT_MS);
    const foundMeta = await waitForValue(
      findDeadline,
      now,
      sleep,
      pollIntervalMs,
      () => findSession({ home: context.runtime.home, expectedName: name }),
      `Timed out waiting for session "${name}" metadata`
    );

    if (!foundMeta) throw new Error(`Session not found: ${name}`);
    context.runtime.sessions.track(foundMeta.id);
    evidence.push(
      sessionMetaEvidencePath(foundMeta.id),
      daemonLogEvidencePath(foundMeta.id)
    );
    transcript.push(`session-found: ${foundMeta.id}`);

    // Resize PTY
    pty.resize(RESIZE_COLS, RESIZE_ROWS);
    transcript.push(`pty-resized: ${RESIZE_COLS}x${RESIZE_ROWS}`);

    // Expect resize marker in local output
    const resizeDeadline = Math.min(overallDeadline, now() + SIGNAL_SETTLE_TIMEOUT_MS);
    await pty.expectRaw(RESIZE_MARKER, resizeDeadline);
    transcript.push(`resize-marker-observed: ${RESIZE_MARKER}`);

    // Wait for metadata to reflect new dimensions
    const metaResizeDeadline = Math.min(overallDeadline, now() + SIGNAL_SETTLE_TIMEOUT_MS);
    await waitForValue(
      metaResizeDeadline,
      now,
      sleep,
      pollIntervalMs,
      async () => {
        const m = await readSessionMeta(foundMeta.id, context.runtime.home);
        if (!m) return undefined;
        if (m.cols === RESIZE_COLS && m.rows === RESIZE_ROWS) return true;
        return undefined;
      },
      `Timed out waiting for metadata to show ${RESIZE_COLS}x${RESIZE_ROWS}`
    );
    transcript.push(`metadata-size-confirmed: ${RESIZE_COLS}x${RESIZE_ROWS}`);

    // Send 'q' to exit
    pty.writeText("q");
    const exitDeadline = Math.min(overallDeadline, now() + PTY_EXIT_TIMEOUT_MS);
    const exitCode = await pty.waitForExit(exitDeadline);
    transcript.push(`pty-exited: code=${exitCode}`);
    if (exitCode !== 0) {
      throw new Error(`Expected attached resize PTY exit code 0, got ${exitCode}`);
    }

    // Wait for terminal status
    const finalizationDeadline = Math.min(overallDeadline, now() + FINALIZATION_TIMEOUT_MS);
    await context.runtime.sessions.waitForTerminalStatus(foundMeta.id, finalizationDeadline);
    transcript.push("session-finalized");
    await flushTranscript();

    return subcheckResult(checkName, "passed", Math.max(0, now() - startedAt), {
      message: `Resize to ${RESIZE_COLS}x${RESIZE_ROWS} confirmed; ${RESIZE_MARKER} observed; metadata updated`,
      evidence,
    });
  } catch (error) {
    transcript.push(`subcheck-error: ${stringifyError(error)}`);
    await flushTranscript().catch(() => undefined);
    return subcheckResult(checkName, "failed", Math.max(0, now() - startedAt), {
      message: stringifyError(error),
      evidence,
    });
  } finally {
    try { pty?.kill(); } catch { /* best-effort */ }
  }
}

// ── Windows forced host termination ──────────────────────────────────────────

async function runWindowsForcedHostTermination(
  context: Dar09Context,
  overallDeadline: number,
  deps: Required<Pick<
    Dar09Dependencies,
    | "now"
    | "sleep"
    | "pollIntervalMs"
    | "createUuid"
    | "runCommand"
    | "findSession"
    | "readScrollback"
    | "readSessionMeta"
    | "createSocketProbe"
    | "resolveHost"
    | "isProcessAlive"
    | "terminateWindowsProcess"
    | "killSessionRecord"
    | "createDaemonClient"
  >>
): Promise<SubcheckResult> {
  const {
    now,
    sleep,
    pollIntervalMs,
    createUuid,
    runCommand,
    findSession,
    readScrollback,
    readSessionMeta,
    createSocketProbe,
    resolveHost,
    isProcessAlive,
    terminateWindowsProcess,
    killSessionRecord,
    createDaemonClient,
  } = deps;

  const checkName = "windows-forced-host-termination" as const;
  const startedAt = now();
  const evidence: string[] = [];
  const transcript: string[] = [];

  const flushTranscript = () =>
    context.runtime.artifacts.appendText(
      "win-term/probe-transcript.log",
      transcript.join("\n") + "\n"
    );

  try {
    const runId = createUuid();

    const launched = await launchHeadlessSignalHold(
      "win-term",
      runId,
      context,
      overallDeadline,
      { now, sleep, pollIntervalMs, runCommand, findSession }
    );

    evidence.push(...launched.evidence, "win-term/probe-transcript.log");
    transcript.push(...launched.transcript);

    const { sessionId, socketRef, meta } = launched;
    const daemonChildPid =
      typeof meta.daemonPid === "number" ? meta.daemonPid : undefined;

    const client = createDaemonClient(socketRef);
    try {
      const readinessDeadline = Math.min(overallDeadline, now() + READINESS_TIMEOUT_MS);
      await client.waitForAttached(readinessDeadline);
      await client.waitForOutput(HOLD_READY_MARKER, readinessDeadline);
    } finally {
      client.destroy();
    }

    const host = await resolveHost(sessionId, {
      daemonChildPid,
      artifactsDir: join(context.runtime.artifacts.dir, "win-term"),
    });
    transcript.push(`host-discovered: pid=${host.pid}`);

    const socketProbe = createSocketProbe();
    const failures: string[] = [];
    const passNotes: string[] = [];

    // Assert socket open before kill
    const openDeadline = Math.min(overallDeadline, now() + SOCKET_CLEANUP_TIMEOUT_MS);
    try {
      await socketProbe.waitOpen(socketRef, openDeadline);
      transcript.push("socket-open-confirmed");
      passNotes.push("socket-was-open");
    } catch (e) {
      failures.push(`socket not open before Stop-Process: ${stringifyError(e)}`);
      transcript.push(`socket-open-failed: ${stringifyError(e)}`);
    }

    // Force-terminate
    await terminateWindowsProcess(host.pid, join(context.runtime.artifacts.dir, "win-term"));
    transcript.push(`stop-process-sent: pid=${host.pid}`);

    // Assert host absent after kill
    const hostExitDeadline = Math.min(overallDeadline, now() + HOST_LIVENESS_TIMEOUT_MS);
    try {
      await waitForValue(
        hostExitDeadline,
        now,
        sleep,
        pollIntervalMs,
        async () => (isProcessAlive(host.pid) ? undefined : true),
        `Timed out waiting for host pid=${host.pid} to exit after Stop-Process`
      );
      transcript.push("host-exited");
      passNotes.push("host-absent");
    } catch (e) {
      failures.push(`host did not exit after Stop-Process: ${stringifyError(e)}`);
      transcript.push(`host-exit-failed: ${stringifyError(e)}`);
    }

    // Assert socket closed after kill
    const closedDeadline = Math.min(overallDeadline, now() + SOCKET_CLEANUP_TIMEOUT_MS);
    try {
      await socketProbe.waitClosed(socketRef, closedDeadline);
      transcript.push("socket-closed");
      passNotes.push("socket-closed");
    } catch (e) {
      failures.push(`socket did not close after Stop-Process: ${stringifyError(e)}`);
      transcript.push(`socket-close-failed: ${stringifyError(e)}`);
    }

    // Verify metadata: live/stale with no completedAt (abrupt termination)
    const abruptMeta = await findSession({
      home: context.runtime.home,
      expectedName: sessionId,
    });
    if (!abruptMeta) {
      failures.push("stale session metadata record absent before reconciliation");
    } else {
      if (!LIVE_SESSION_STATUSES.has(abruptMeta.status)) {
        failures.push(`stale metadata status: expected live status, got ${abruptMeta.status}`);
      } else {
        passNotes.push(`stale-status=${abruptMeta.status}`);
      }
      const completedAt = abruptMeta.completedAt;
      if (typeof completedAt === "string" && completedAt.length > 0) {
        failures.push(`abrupt termination: unexpected completedAt=${completedAt}`);
      } else {
        passNotes.push("abrupt-no-completedAt");
      }
    }

    // Verify no final scrollback (abrupt termination = no clean exit)
    const scrollback = await readScrollback(context.runtime.home, sessionId);
    if (scrollback.length > 0) {
      failures.push(`abrupt termination unexpectedly wrote final scrollback (${scrollback.length} bytes)`);
    } else {
      passNotes.push("no-final-scrollback");
    }

    // Reconcile via climon kill — must exit 0
    await killSessionRecord(
      sessionId,
      context.build.clientPath,
      context.runtime.root,
      context.runtime.env,
      join(context.runtime.artifacts.dir, "win-term")
    );
    transcript.push("kill-reconcile-done");
    passNotes.push("kill-reconciled");

    // Verify session metadata record removed after kill
    const afterKillMeta = await readSessionMeta(sessionId, context.runtime.home);
    if (afterKillMeta !== undefined) {
      failures.push(`session metadata still present after climon kill (id=${sessionId})`);
    } else {
      passNotes.push("session-record-removed");
    }

    transcript.push(
      failures.length > 0
        ? `subcheck-failures: ${failures.join("; ")}`
        : `subcheck-passed: ${passNotes.join(", ")}`
    );
    await flushTranscript();

    return subcheckResult(
      checkName,
      failures.length > 0 ? "failed" : "passed",
      Math.max(0, now() - startedAt),
      {
        message: failures.length > 0 ? failures.join("; ") : passNotes.join(", "),
        evidence,
      }
    );
  } catch (error) {
    const msg = stringifyError(error);
    transcript.push(`subcheck-error: ${msg}`);
    await flushTranscript().catch(() => undefined);
    return subcheckResult(checkName, "failed", Math.max(0, now() - startedAt), {
      message: msg,
      evidence,
    });
  }
}

// ── Windows console resize poller ────────────────────────────────────────────

async function runWindowsConsoleResizePoller(
  context: Dar09Context,
  overallDeadline: number,
  deps: Required<Pick<
    Dar09Dependencies,
    | "now"
    | "sleep"
    | "pollIntervalMs"
    | "createUuid"
    | "spawnPty"
    | "findSession"
    | "readSessionMeta"
    | "createSocketProbe"
  >>
): Promise<SubcheckResult> {
  const {
    now,
    sleep,
    pollIntervalMs,
    createUuid,
    spawnPty,
    findSession,
    readSessionMeta,
  } = deps;

  const checkName = "windows-console-resize-poller" as const;
  const startedAt = now();
  const evidence: string[] = ["pty/win-resize/input.log", "pty/win-resize/output.log"];
  const transcript: string[] = [];

  let pty: Dar09Pty | undefined;

  try {
    const runId = createUuid();
    const name = sessionName(runId, "win-resize");

    const ptySpec: PtySpawnSpec = {
      file: resolve(context.build.fixturePath),
      args: [
        "mode-probe",
        "--",
        resolve(context.build.clientPath),
        "run",
        "--name",
        name,
        resolve(context.build.fixturePath),
        "control-probe",
      ],
      cwd: context.runtime.root,
      env: context.runtime.env,
      cols: LOCAL_COLS,
      rows: LOCAL_ROWS,
      inputPath: "pty/win-resize/input.log",
      outputPath: "pty/win-resize/output.log",
    };

    pty = spawnPty(ptySpec, {
      now,
      appendText: context.runtime.artifacts.appendText.bind(context.runtime.artifacts),
    });

    // Wait for ready marker — just the prefix
    const readyDeadline = Math.min(overallDeadline, now() + READINESS_TIMEOUT_MS);
    await pty.expectRaw(READY_MARKER_PREFIX, readyDeadline);
    transcript.push(`ready-marker-observed: ${READY_MARKER_PREFIX}`);

    const findDeadline = Math.min(overallDeadline, now() + FIND_SESSION_TIMEOUT_MS);
    const foundMeta = await waitForValue(
      findDeadline,
      now,
      sleep,
      pollIntervalMs,
      () => findSession({ home: context.runtime.home, expectedName: name }),
      `Timed out waiting for session "${name}" metadata`
    );

    if (!foundMeta) throw new Error(`Session not found: ${name}`);
    context.runtime.sessions.track(foundMeta.id);
    evidence.push(
      sessionMetaEvidencePath(foundMeta.id),
      daemonLogEvidencePath(foundMeta.id)
    );

    // Resize once to 101x31
    pty.resize(RESIZE_COLS, RESIZE_ROWS);
    transcript.push(`pty-resized: ${RESIZE_COLS}x${RESIZE_ROWS}`);

    // Wait for at least one resize marker
    const resizeDeadline = Math.min(overallDeadline, now() + SIGNAL_SETTLE_TIMEOUT_MS);
    await pty.expectRaw(RESIZE_MARKER, resizeDeadline);
    transcript.push(`resize-marker-observed: ${RESIZE_MARKER}`);

    // After a quiet settle, count total resize events — must be exactly one
    await sleep(Math.min(200, Math.max(0, overallDeadline - now())));
    const localOutput = pty.readLocalOutput();
    const resizeCount = countOccurrences(localOutput, RESIZE_MARKER_BASE);
    transcript.push(`resize-marker-count: ${resizeCount}`);

    const failures: string[] = [];
    const passNotes: string[] = [];

    if (resizeCount !== 1) {
      failures.push(`Expected exactly 1 ${RESIZE_MARKER_BASE} event, found ${resizeCount} (duplicate resize marker)`);
    } else {
      passNotes.push("exactly-one-resize-marker");
    }

    // Wait for metadata cols/rows
    const metaResizeDeadline = Math.min(overallDeadline, now() + SIGNAL_SETTLE_TIMEOUT_MS);
    await waitForValue(
      metaResizeDeadline,
      now,
      sleep,
      pollIntervalMs,
      async () => {
        const m = await readSessionMeta(foundMeta.id, context.runtime.home);
        if (!m) return undefined;
        if (m.cols === RESIZE_COLS && m.rows === RESIZE_ROWS) return true;
        return undefined;
      },
      `Timed out waiting for metadata to show ${RESIZE_COLS}x${RESIZE_ROWS}`
    );
    transcript.push(`metadata-size-confirmed: ${RESIZE_COLS}x${RESIZE_ROWS}`);
    passNotes.push(`metadata-${RESIZE_COLS}x${RESIZE_ROWS}`);

    pty.writeText("q");
    const exitDeadline = Math.min(overallDeadline, now() + PTY_EXIT_TIMEOUT_MS);
    await pty.waitForExit(exitDeadline);

    const finalizationDeadline = Math.min(overallDeadline, now() + FINALIZATION_TIMEOUT_MS);
    await context.runtime.sessions.waitForTerminalStatus(foundMeta.id, finalizationDeadline);
    transcript.push("session-finalized");

    const transcriptFile = "win-resize/probe-transcript.log";
    evidence.push(transcriptFile);
    await context.runtime.artifacts.appendText(
      transcriptFile,
      transcript.join("\n") + "\n"
    );

    return subcheckResult(
      checkName,
      failures.length > 0 ? "failed" : "passed",
      Math.max(0, now() - startedAt),
      {
        message: failures.length > 0 ? failures.join("; ") : passNotes.join(", "),
        evidence,
      }
    );
  } catch (error) {
    transcript.push(`subcheck-error: ${stringifyError(error)}`);
    await context.runtime.artifacts
      .appendText("win-resize/probe-transcript.log", transcript.join("\n") + "\n")
      .catch(() => undefined);
    return subcheckResult(checkName, "failed", Math.max(0, now() - startedAt), {
      message: stringifyError(error),
      evidence,
    });
  } finally {
    try { pty?.kill(); } catch { /* best-effort */ }
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runDar09(
  context: Dar09Context,
  dependencies: Dar09Dependencies = {}
): Promise<SubcheckResult[]> {
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? defaultSleep;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 50;
  const createUuid = dependencies.createUuid ?? randomUUID;
  const spawnPty =
    dependencies.spawnPty ??
    ((spec: PtySpawnSpec, d: PtyDriverDependencies): Dar09Pty => PtyDriver.spawn(spec, d));
  const runCommand =
    dependencies.runCommand ??
    (async (spec: CommandSpec): Promise<CommandResult> => {
      const { BunCommandRunner } = await import("../command.js");
      return new BunCommandRunner().run(spec);
    });
  const findSession = dependencies.findSession ?? defaultFindSession;
  const readSessionMeta = dependencies.readSessionMeta ?? defaultReadSessionMeta;
  const readScrollback = dependencies.readScrollback ?? defaultReadScrollback;
  const readDaemonLog = dependencies.readDaemonLog ?? defaultReadDaemonLog;
  const createSocketProbe =
    dependencies.createSocketProbe ??
    (() => new SocketProbe({ now, sleep, pollIntervalMs }));
  const resolveHost =
    dependencies.resolveHost ??
    (async (sessionId: string, opts: ResolveHostOptions) => {
      const { BunCommandRunner } = await import("../command.js");
      return resolveSessionHost(context.platform, sessionId, new BunCommandRunner(), {
        daemonChildPid: opts.daemonChildPid,
        artifactsDir: opts.artifactsDir,
      });
    });
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
  const killProcess = dependencies.killProcess ?? defaultKillProcess;
  const terminateWindowsProcess =
    dependencies.terminateWindowsProcess ??
    ((pid: number, dir: string) => defaultTerminateWindowsProcess(pid, dir));
  const killSessionRecord =
    dependencies.killSessionRecord ??
    ((id: string, clientPath: string, cwd: string, env: Record<string, string | undefined>, dir: string) =>
      defaultKillSessionRecord(id, clientPath, cwd, env, dir));
  const createDaemonClient =
    dependencies.createDaemonClient ??
    ((ref: SocketRef): DaemonClientLike => new DaemonClient(ref));

  const overallDeadline = asAbsoluteDeadline(context.overallDeadline);
  const platform = context.platform;
  const isUnix = platform === "linux" || platform === "macos";
  const isWindows = platform === "windows";

  const unixDeps = {
    now, sleep, pollIntervalMs, createUuid,
    runCommand, findSession, readScrollback, readDaemonLog,
    createSocketProbe, resolveHost, isProcessAlive, killProcess, createDaemonClient,
  };

  const resizeDeps = {
    now, sleep, pollIntervalMs, createUuid,
    spawnPty, findSession, readSessionMeta, createSocketProbe,
  };

  const windowsDeps = {
    now, sleep, pollIntervalMs, createUuid,
    runCommand, findSession, readScrollback, readSessionMeta,
    createSocketProbe, resolveHost, isProcessAlive,
    terminateWindowsProcess, killSessionRecord, createDaemonClient,
  };

  // Run subchecks sequentially to avoid multiple concurrent sessions obscuring host/cleanup
  const sigintResult = isUnix
    ? await runUnixSignalSubcheck("unix-sigint-graceful", "SIGINT", context, overallDeadline, unixDeps)
    : naResult("unix-sigint-graceful");

  const sigtermResult = isUnix
    ? await runUnixSignalSubcheck("unix-sigterm-graceful", "SIGTERM", context, overallDeadline, unixDeps)
    : naResult("unix-sigterm-graceful");

  const repeatResult = isUnix
    ? await runRepeatedSignalIdempotency(context, overallDeadline, unixDeps)
    : naResult("repeated-signal-idempotency");

  const resizeResult = isUnix
    ? await runAttachedResizePath(context, overallDeadline, resizeDeps)
    : naResult("attached-resize-path");

  const winTermResult = isWindows
    ? await runWindowsForcedHostTermination(context, overallDeadline, windowsDeps)
    : naResult("windows-forced-host-termination");

  const winResizeResult = isWindows
    ? await runWindowsConsoleResizePoller(context, overallDeadline, resizeDeps)
    : naResult("windows-console-resize-poller");

  return [sigintResult, sigtermResult, repeatResult, resizeResult, winTermResult, winResizeResult];
}
