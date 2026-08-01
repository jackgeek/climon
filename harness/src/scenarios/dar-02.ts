import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuildArtifacts } from "../build-cache.js";
import type { OwnedProcess } from "../process-ledger.js";
import type { RuntimeContext } from "../runtime-supervisor.js";
import type { SessionLedger, SessionStatus } from "../session-ledger.js";
import type { HarnessPlatform, SubcheckResult } from "../types.js";

const HEADLESS_STDOUT_ARTIFACT = "headless/stdout.log";
const HEADLESS_STDERR_ARTIFACT = "headless/stderr.log";
const READY_MARKER = "DAR_STREAM_READY";
const FINAL_EXIT_MARKER = "DAR_STREAM_EXIT 0";
const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;
const SUBCHECK_TIMEOUTS_MS = {
  "headless-launch": 30_000,
  "daemon-running": 30_000,
  "midstream-attach": 30_000,
  "replay-visible": 30_000,
  "browser-input": 30_000,
  "live-output": 30_000,
  "viewer-independence": 30_000,
  "successful-finalization": 30_000,
} as const;

export const DAR_02_SUBCHECK_NAMES = [
  "headless-launch",
  "daemon-running",
  "midstream-attach",
  "replay-visible",
  "browser-input",
  "live-output",
  "viewer-independence",
  "successful-finalization",
] as const;

export const DAR_02_REPLAY_MARKERS = Array.from({ length: 20 }, (_, index) => {
  const phase = String(index + 1).padStart(3, "0");
  return `DAR_STREAM_REPLAY ${phase}`;
});

export const DAR_02_LIVE_MARKERS = Array.from({ length: 20 }, (_, index) => {
  const phase = String(index + 21).padStart(3, "0");
  return `DAR_STREAM_LIVE ${phase}`;
});

export type Dar02SubcheckName = (typeof DAR_02_SUBCHECK_NAMES)[number];

export interface Dar02BrowserDriver {
  open(baseUrl: string, deadline: number): Promise<void>;
  waitForSessionStatus(id: string, status: string, deadline: number): Promise<void>;
  openTerminal(id: string, deadline: number): Promise<void>;
  waitForTerminalText(text: string, deadline: number): Promise<void>;
  sendTerminalLine(text: string): Promise<void>;
  closeViewer(): Promise<void>;
  reopenViewer(baseUrl: string, deadline: number): Promise<void>;
}

export interface Dar02Context {
  platform: HarnessPlatform;
  overallDeadline: number | Date;
  build: Pick<BuildArtifacts, "clientPath" | "fixturePath">;
  browser: Dar02BrowserDriver;
  runtime: Pick<RuntimeContext, "root" | "home" | "baseUrl" | "env"> & {
    artifacts: Pick<RuntimeContext["artifacts"], "dir">;
    processes: Pick<RuntimeContext["processes"], "register">;
    sessions: Pick<SessionLedger, "track" | "waitForStatus" | "read">;
  };
}

export interface HeadlessSpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdoutPath: string;
  stderrPath: string;
  shell: false;
  label: string;
  platform: HarnessPlatform;
}

export interface HeadlessProcess {
  pid: number;
  stdoutText(): string;
  stderrText(): string;
  waitForExit(deadline: number): Promise<number | null>;
  kill(): void | Promise<void>;
}

export interface Dar02Dependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  createUuid?: () => string;
  spawnHeadlessProcess?: (
    spec: HeadlessSpawnSpec,
    context: Dar02Context
  ) => Promise<HeadlessProcess> | HeadlessProcess;
  readLiveScrollback: (sessionId: string, home: string) => Promise<string | undefined>;
  snapshotTerminalText: () => Promise<string>;
  readFinalScrollback?: (sessionId: string, home: string) => Promise<string | undefined>;
  readDaemonLog?: (sessionId: string, home: string) => Promise<string | undefined>;
}

interface SessionMetaLike extends Record<string, unknown> {
  id: string;
  status: SessionStatus;
  exitCode?: number;
  completedAt?: string;
}

interface ParsedSessionId {
  id: string;
  line: string;
}

interface SpawnTiming {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
}

interface SpawnedChildLike {
  pid?: number;
  stdout: {
    on(event: "data", listener: (chunk: Uint8Array | string) => void): void;
  };
  stderr: {
    on(event: "data", listener: (chunk: Uint8Array | string) => void): void;
  };
  once(event: "error", listener: (error: unknown) => void): void;
  once(event: "exit", listener: (code: number | null) => void): void;
}

interface HeadlessTerminateCommandOptions {
  shell: false;
  stdio: "ignore";
  windowsHide: true;
}

export interface DefaultHeadlessSpawnDependencies {
  spawn?: (
    file: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      shell: false;
      detached: boolean;
      stdio: ["ignore", "pipe", "pipe"];
    }
  ) => SpawnedChildLike;
  createWriteStream?: (path: string) => Pick<WriteStream, "write" | "end">;
  mkdir?: typeof mkdir;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  runCommand?: (
    file: string,
    args: string[],
    options: HeadlessTerminateCommandOptions
  ) => { status: number | null; error?: unknown };
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

function normalizeSubcheckError(name: Dar02SubcheckName, error: unknown): Error {
  return error instanceof Error ? error : new Error(`${name} failed: ${String(error)}`);
}

function headlessStdoutPath(context: Dar02Context): string {
  return join(context.runtime.artifacts.dir, HEADLESS_STDOUT_ARTIFACT);
}

function headlessStderrPath(context: Dar02Context): string {
  return join(context.runtime.artifacts.dir, HEADLESS_STDERR_ARTIFACT);
}

function sessionMetaEvidencePath(id: string): string {
  return `home/sessions/${id}.json`;
}

function finalScrollbackEvidencePath(id: string): string {
  return `home/sessions/${id}.scrollback`;
}

function daemonLogEvidencePath(id: string): string {
  return `home/logs/daemon/${id}.log`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function defaultReadFinalScrollback(
  sessionId: string,
  home: string
): Promise<string | undefined> {
  return readOptionalText(join(home, "sessions", `${sessionId}.scrollback`));
}

async function defaultReadDaemonLog(
  sessionId: string,
  home: string
): Promise<string | undefined> {
  return readOptionalText(join(home, "logs", "daemon", `${sessionId}.log`));
}

function completedLines(rawOutput: string): string[] {
  const normalized = rawOutput.replaceAll("\r\n", "\n");
  const trailingComplete = normalized.endsWith("\n");
  const rawLines = normalized.split("\n");
  const lines = trailingComplete ? rawLines : rawLines.slice(0, -1);
  return lines.map((line) => stripAnsi(line).trim()).filter((line) => line.length > 0);
}

function parseHeadlessSessionId(rawOutput: string): ParsedSessionId | undefined {
  const lines = completedLines(rawOutput);
  if (lines.length === 0) {
    return undefined;
  }

  const protocolLines = lines.filter(
    (line) =>
      /^DAR_STREAM_REPLAY \d{3}$/.test(line) ||
      line === READY_MARKER ||
      /^DAR_STREAM_LIVE \d{3}$/.test(line) ||
      /^DAR_STREAM_EXIT \d+$/.test(line)
  );
  const safeLines = lines.filter(
    (line) => SESSION_ID_PATTERN.test(line) && !protocolLines.includes(line)
  );
  const unsafeCandidates = lines.filter(
    (line) => !SESSION_ID_PATTERN.test(line) && !protocolLines.includes(line)
  );
  if (unsafeCandidates.length > 0) {
    throw new Error(`Unsafe session id from headless launch stdout: ${unsafeCandidates[0]!}`);
  }
  if (safeLines.length === 0) {
    return undefined;
  }
  if (safeLines.length !== 1) {
    throw new Error(`Expected exactly one headless session id line, found ${safeLines.length}`);
  }

  return {
    id: safeLines[0]!,
    line: safeLines[0]!,
  };
}

function countOccurrences(text: string, marker: string): number {
  if (marker.length === 0) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (true) {
    const next = text.indexOf(marker, offset);
    if (next === -1) {
      return count;
    }
    count += 1;
    offset = next + marker.length;
  }
}

function assertExactlyOnce(text: string, markers: readonly string[], label: string): void {
  for (const marker of markers) {
    const count = countOccurrences(text, marker);
    if (count !== 1) {
      throw new Error(`Expected ${label} marker ${JSON.stringify(marker)} exactly once, found ${count}`);
    }
  }
}

function assertCompletedMeta(meta: SessionMetaLike): void {
  if (meta.status !== "completed") {
    throw new Error(`Expected metadata status=completed, received ${meta.status}`);
  }
  if (meta.exitCode !== 0) {
    throw new Error(`Expected exitCode=0, received ${String(meta.exitCode)}`);
  }
  if (typeof meta.completedAt !== "string" || meta.completedAt.length === 0) {
    throw new Error(`Expected completedAt to be a non-empty string, received ${String(meta.completedAt)}`);
  }
  if (Number.isNaN(Date.parse(meta.completedAt))) {
    throw new Error(`Expected completedAt to be a valid timestamp, received ${meta.completedAt}`);
  }
}

function remainingDeadline(
  name: Dar02SubcheckName,
  overallDeadline: number,
  now: () => number
): number {
  const startedAt = now();
  return Math.min(overallDeadline, startedAt + SUBCHECK_TIMEOUTS_MS[name]);
}

function impossibleMessage(reason: string): string {
  return `Unable to run subcheck: ${reason}`;
}

function withEvidence(
  status: "passed" | "failed",
  name: Dar02SubcheckName,
  durationMs: number,
  baseEvidence: string[],
  options: { message?: string; evidence?: string[] } = {}
): SubcheckResult {
  return {
    name,
    status,
    durationMs,
    message: options.message,
    evidence: [...baseEvidence, ...(options.evidence ?? [])],
  };
}

async function runSubcheck(
  name: Dar02SubcheckName,
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
      message: stringifyError(normalizeSubcheckError(name, error)),
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

async function waitForText(
  deadline: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  producer: () => Promise<string | undefined>,
  expected: string,
  timeoutLabel: string
): Promise<string> {
  return waitForValue(
    deadline,
    now,
    sleep,
    pollIntervalMs,
    async () => {
      const text = await producer();
      return text?.includes(expected) ? text : undefined;
    },
    `Timed out waiting for ${timeoutLabel} ${JSON.stringify(expected)}`
  );
}

function launchSpec(context: Dar02Context, runId: string): HeadlessSpawnSpec {
  return {
    file: context.build.clientPath,
    args: [
      "run",
      "--headless",
      "--name",
      `DAR-02-${runId}`,
      context.build.fixturePath,
      "streaming",
    ],
    cwd: context.runtime.root,
    env: context.runtime.env,
    stdoutPath: headlessStdoutPath(context),
    stderrPath: headlessStderrPath(context),
    shell: false,
    label: "climon-headless-launch",
    platform: context.platform,
  };
}

const defaultRunCommand = (
  file: string,
  args: string[],
  options: HeadlessTerminateCommandOptions
): { status: number | null; error?: unknown } => {
  const result = spawnSync(file, args, options);
  return { status: result.status, error: result.error };
};

async function terminateOwnedProcess(
  owned: OwnedProcess,
  dependencies: Pick<DefaultHeadlessSpawnDependencies, "kill" | "runCommand">,
  hasExited: () => boolean
): Promise<void> {
  if (hasExited()) {
    return;
  }

  const kill = dependencies.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const targetPid =
    owned.platform === "windows"
      ? owned.pid
      : owned.processGroup !== undefined
        ? -owned.processGroup
        : owned.pid;

  try {
    if (owned.platform === "windows") {
      const result = runCommand(
        "taskkill",
        ["/PID", String(owned.pid), "/T", "/F"],
        { shell: false, stdio: "ignore", windowsHide: true }
      );
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(`taskkill exited with status ${result.status}`);
      }
      return;
    }

    kill(targetPid, "SIGKILL");
  } catch (error) {
    if (hasExited()) {
      return;
    }
    throw error;
  }
}

export async function spawnHeadlessProcessWithChildProcess(
  spec: HeadlessSpawnSpec,
  context: Dar02Context,
  timing: SpawnTiming,
  dependencies: DefaultHeadlessSpawnDependencies = {}
): Promise<HeadlessProcess> {
  const makeDir = dependencies.mkdir ?? mkdir;
  const openStream =
    dependencies.createWriteStream ??
    ((path: string) => createWriteStream(path, { flags: "w" }));
  const spawnChild =
    dependencies.spawn ??
    ((file: string, args: string[], options: Parameters<typeof spawn>[2]) =>
      spawn(file, args, options) as unknown as SpawnedChildLike);
  const detached = spec.platform !== "windows";

  await makeDir(dirname(spec.stdoutPath), { recursive: true });
  await makeDir(dirname(spec.stderrPath), { recursive: true });

  const child = spawnChild(spec.file, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`Failed to launch ${spec.file}: missing child pid`);
  }

  const stdoutStream = openStream(spec.stdoutPath);
  const stderrStream = openStream(spec.stderrPath);
  let stdout = "";
  let stderr = "";
  let exitCode: number | null | undefined;
  let exitError: unknown;

  child.stdout.on("data", (chunk: Uint8Array | string) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    stdout += text;
    stdoutStream.write(chunk);
  });
  child.stderr.on("data", (chunk: Uint8Array | string) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    stderr += text;
    stderrStream.write(chunk);
  });
  child.once("error", (error) => {
    exitError = error;
  });
  child.once("exit", (code: number | null) => {
    exitCode = code;
    stdoutStream.end();
    stderrStream.end();
  });

  const ownedProcess: OwnedProcess = {
    pid,
    label: spec.label,
    platform: spec.platform,
    processGroup: detached ? pid : undefined,
    wait: async () => {
      if (exitCode !== undefined) {
        return exitCode;
      }

      while (true) {
        if (exitError) {
          throw exitError;
        }
        if (exitCode !== undefined) {
          return exitCode;
        }
        await timing.sleep(timing.pollIntervalMs);
      }
    },
  };
  const hasExited = () => exitCode !== undefined || exitError !== undefined;

  try {
    await context.runtime.processes.register(ownedProcess);
  } catch (error) {
    await terminateOwnedProcess(ownedProcess, dependencies, hasExited);
    throw error;
  }

  return {
    pid,
    stdoutText() {
      return stdout;
    },
    stderrText() {
      return stderr;
    },
    async waitForExit(deadline: number) {
      while (true) {
        if (exitError) {
          throw exitError;
        }
        if (exitCode !== undefined) {
          return exitCode;
        }
        if (timing.now() >= deadline) {
          throw new Error(`Timed out waiting for headless process ${pid} to exit`);
        }
        await timing.sleep(Math.max(1, Math.min(timing.pollIntervalMs, deadline - timing.now())));
      }
    },
    async kill() {
      await terminateOwnedProcess(ownedProcess, dependencies, hasExited);
    },
  };
}

export async function runDar02(
  context: Dar02Context,
  dependencies: Dar02Dependencies
): Promise<SubcheckResult[]> {
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? defaultSleep;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 50;
  const createUuid = dependencies.createUuid ?? randomUUID;
  const readFinalScrollback = dependencies.readFinalScrollback ?? defaultReadFinalScrollback;
  const readDaemonLog = dependencies.readDaemonLog ?? defaultReadDaemonLog;
  const spawnHeadlessProcess =
    dependencies.spawnHeadlessProcess ??
    ((spec: HeadlessSpawnSpec, nextContext: Dar02Context) =>
      spawnHeadlessProcessWithChildProcess(spec, nextContext, { now, sleep, pollIntervalMs }));
  const overallDeadline = asAbsoluteDeadline(context.overallDeadline);
  const runId = createUuid();
  const continueLine = `CONTINUE ${runId}`;
  const results: SubcheckResult[] = [];
  let launchedProcess: HeadlessProcess | undefined;
  let launchFailure: string | undefined;
  let parsedSessionId: ParsedSessionId | undefined;
  let dashboardOpened = false;
  let browserAttached = false;
  let attachFailure: string | undefined;
  let continueSent = false;

  const evidence = () => {
    const items = [HEADLESS_STDOUT_ARTIFACT, HEADLESS_STDERR_ARTIFACT];
    if (parsedSessionId) {
      items.push(
        sessionMetaEvidencePath(parsedSessionId.id),
        daemonLogEvidencePath(parsedSessionId.id),
        finalScrollbackEvidencePath(parsedSessionId.id)
      );
    }
    return items;
  };

  try {
    launchedProcess = await spawnHeadlessProcess(launchSpec(context, runId), context);
  } catch (error) {
    launchFailure = `Failed to spawn headless DAR-02 launch: ${stringifyError(error)}`;
  }

  results.push(
    await runSubcheck("headless-launch", now, evidence, async () => {
      if (!launchedProcess) {
        throw new Error(launchFailure ?? impossibleMessage("headless launch unavailable"));
      }

      const deadline = remainingDeadline("headless-launch", overallDeadline, now);
      let launcherExited = false;
      let parsedSafeSessionId = false;
      let awaitingLauncherExit = false;

      try {
        const stdout = await waitForValue(
          deadline,
          now,
          sleep,
          pollIntervalMs,
          async () => {
            const text = launchedProcess!.stdoutText();
            return parseHeadlessSessionId(text);
          },
          "Timed out waiting for headless launch stdout"
        );

        parsedSafeSessionId = true;
        context.runtime.sessions.track(stdout.id);
        parsedSessionId = stdout;

        awaitingLauncherExit = true;
        const exitCode = await launchedProcess.waitForExit(deadline);
        launcherExited = true;
        if (exitCode !== 0) {
          throw new Error(`Expected headless launcher to exit 0, received ${String(exitCode)}`);
        }

        return {
          message: `Parsed headless session id ${parsedSessionId.id}`,
          evidence: [parsedSessionId.line],
        };
      } catch (error) {
        if (!launcherExited && (!parsedSafeSessionId || awaitingLauncherExit)) {
          await Promise.resolve(launchedProcess.kill());
        }
        throw error;
      }
    })
  );

  results.push(
    await runSubcheck("daemon-running", now, evidence, async () => {
      if (!parsedSessionId) {
        throw new Error(impossibleMessage("headless-launch did not yield a safe session id"));
      }

      const deadline = remainingDeadline("daemon-running", overallDeadline, now);
      await context.runtime.sessions.waitForStatus(parsedSessionId.id, "running", deadline);
      await waitForValue(
        deadline,
        now,
        sleep,
        pollIntervalMs,
        async () => (await readDaemonLog(parsedSessionId!.id, context.runtime.home)) ?? undefined,
        `Timed out waiting for daemon log ${daemonLogEvidencePath(parsedSessionId.id)}`
      );

      return {
        message: `Session ${parsedSessionId.id} is running and daemon ownership is persisted`,
      };
    })
  );

  results.push(
    await runSubcheck("midstream-attach", now, evidence, async () => {
      try {
        if (!parsedSessionId) {
          throw new Error(impossibleMessage("session id unavailable"));
        }

        const deadline = remainingDeadline("midstream-attach", overallDeadline, now);
        await context.browser.open(context.runtime.baseUrl, deadline);
        dashboardOpened = true;
        await context.browser.waitForSessionStatus(parsedSessionId.id, "running", deadline);
        await context.browser.openTerminal(parsedSessionId.id, deadline);
        browserAttached = true;
        return {
          message: `Opened dashboard terminal for ${parsedSessionId.id}`,
        };
      } catch (error) {
        attachFailure = stringifyError(error);
        throw error;
      }
    })
  );

  results.push(
    await runSubcheck("replay-visible", now, evidence, async () => {
      if (!browserAttached || !parsedSessionId) {
        throw new Error(impossibleMessage("midstream-attach did not open the browser terminal"));
      }

      const deadline = remainingDeadline("replay-visible", overallDeadline, now);
      for (const marker of DAR_02_REPLAY_MARKERS) {
        await context.browser.waitForTerminalText(marker, deadline);
      }
      await context.browser.waitForTerminalText(READY_MARKER, deadline);
      const snapshot = await dependencies.snapshotTerminalText();
      assertExactlyOnce(snapshot, [...DAR_02_REPLAY_MARKERS, READY_MARKER], "replay snapshot");
      return {
        message: `Verified replay markers ${DAR_02_REPLAY_MARKERS[0]}..${DAR_02_REPLAY_MARKERS.at(-1)!}`,
        evidence: [READY_MARKER],
      };
    })
  );

  results.push(
    await runSubcheck("browser-input", now, evidence, async () => {
      if (!browserAttached || !parsedSessionId) {
        throw new Error(impossibleMessage("browser terminal unavailable for CONTINUE input"));
      }

      await context.browser.sendTerminalLine(continueLine);
      continueSent = true;
      return {
        message: `Sent ${continueLine}`,
        evidence: [continueLine],
      };
    })
  );

  results.push(
    await runSubcheck("live-output", now, evidence, async () => {
      if (!continueSent || !parsedSessionId) {
        throw new Error(impossibleMessage("browser-input did not send CONTINUE"));
      }

      const deadline = remainingDeadline("live-output", overallDeadline, now);
      for (const marker of DAR_02_LIVE_MARKERS) {
        await context.browser.waitForTerminalText(marker, deadline);
      }
      const snapshot = await dependencies.snapshotTerminalText();
      assertExactlyOnce(snapshot, DAR_02_LIVE_MARKERS, "live snapshot");
      return {
        message: `Verified live markers ${DAR_02_LIVE_MARKERS[0]}..${DAR_02_LIVE_MARKERS.at(-1)!}`,
        evidence: [DAR_02_LIVE_MARKERS.at(-1)!],
      };
    })
  );

  results.push(
    await runSubcheck("viewer-independence", now, evidence, async () => {
      if (!browserAttached || !parsedSessionId) {
        throw new Error(impossibleMessage("browser terminal unavailable for viewer reopen"));
      }

      const deadline = remainingDeadline("viewer-independence", overallDeadline, now);
      await context.browser.closeViewer();
      const meta = (await context.runtime.sessions.read(parsedSessionId.id)) as SessionMetaLike;
      if (meta.status !== "running") {
        throw new Error(`Expected metadata status=running after viewer close, received ${meta.status}`);
      }
      await context.browser.reopenViewer(context.runtime.baseUrl, deadline);
      await context.browser.waitForSessionStatus(parsedSessionId.id, "running", deadline);
      await context.browser.openTerminal(parsedSessionId.id, deadline);
      await context.browser.waitForTerminalText(DAR_02_LIVE_MARKERS.at(-1)!, deadline);
      return {
        message: `Viewer reopened while metadata stayed ${meta.status}`,
      };
    })
  );

  results.push(
    await runSubcheck("successful-finalization", now, evidence, async () => {
      const cleanupNotes: string[] = [];
      let exitDelivered = false;

      try {
        if (attachFailure) {
          cleanupNotes.push(attachFailure);
        }

        if (parsedSessionId && browserAttached) {
          try {
            await context.browser.sendTerminalLine("EXIT 0");
            exitDelivered = true;
          } catch (error) {
            cleanupNotes.push(`browser EXIT 0 failed: ${stringifyError(error)}`);
          }
        } else {
          cleanupNotes.push("browser terminal unavailable for EXIT 0 session control");
        }

        if (!parsedSessionId) {
          cleanupNotes.push(impossibleMessage("session id unavailable for completion verification"));
          throw new Error(cleanupNotes.join("; "));
        }

        if (!exitDelivered) {
          throw new Error(cleanupNotes.join("; "));
        }

        const deadline = remainingDeadline("successful-finalization", overallDeadline, now);

        if (dashboardOpened) {
          await context.browser.waitForSessionStatus(parsedSessionId.id, "completed", deadline);
        }

        await context.runtime.sessions.waitForStatus(parsedSessionId.id, "completed", deadline);
        const meta = (await context.runtime.sessions.read(parsedSessionId.id)) as SessionMetaLike;
        assertCompletedMeta(meta);
        await waitForText(
          deadline,
          now,
          sleep,
          pollIntervalMs,
          async () => readFinalScrollback(parsedSessionId!.id, context.runtime.home),
          FINAL_EXIT_MARKER,
          "final scrollback exit marker"
        );

        return {
          message: `Session ${parsedSessionId.id} completed with exitCode=0 at ${meta.completedAt}`,
          evidence: cleanupNotes,
        };
      } catch (error) {
        const messageParts = [...cleanupNotes];
        messageParts.push(stringifyError(error));
        throw new Error(messageParts.join("; "));
      }
    })
  );

  return results;
}
