/**
 * Shell-free process discovery for DAR-09.
 *
 * Locates the climon session host process (`climon __session <id>`) via:
 *   - Unix: `ps -axo pid=,command=` via CommandRunner
 *   - Windows: PowerShell Get-CimInstance Win32_Process via CommandRunner
 *
 * The session host is found by matching the exact token sequence
 * `["__session", "<sessionId>"]` in the command line.  Substring matches
 * (e.g., a session id that is a prefix of another) are rejected.
 *
 * The caller may supply a `daemonChildPid` (the child process PID recorded in
 * session metadata as `daemonPid`) to guard against accidentally picking up
 * the fixture child process if it somehow appears in the process list with a
 * matching command line.
 */

import { join } from "node:path";
import type { CommandRunner } from "../command.js";
import { HarnessError } from "../types.js";
import type { HarnessPlatform } from "../types.js";

// ── Session ID validation ─────────────────────────────────────────────────────

const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;

function validateSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new HarnessError(
      "prerequisite",
      `Invalid session id for process discovery: "${id}"`
    );
  }
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface SessionHost {
  pid: number;
  command: string;
}

export interface ProcessDiscoveryOptions {
  daemonChildPid?: number;
  artifactsDir: string;
  timeoutMs?: number;
}

// ── Parse helpers ─────────────────────────────────────────────────────────────

/**
 * True iff the token sequence `["__session", sessionId]` appears as
 * consecutive elements anywhere in `tokens`, and the sessionId token matches
 * EXACTLY (not as a prefix or substring).
 */
export function commandContainsSessionToken(tokens: string[], sessionId: string): boolean {
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i] === "__session" && tokens[i + 1] === sessionId) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a positive integer PID from a trimmed token string.
 * Returns `undefined` for empty, non-numeric, zero, or negative values.
 */
export function parsePositivePid(token: string): number | undefined {
  const trimmed = token.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

// ── Unix parser ───────────────────────────────────────────────────────────────

export interface ParsedCandidateSet {
  candidates: SessionHost[];
  childGuardedPids: number[];
  malformedLines: number;
  diagnostics: string[];
}

/**
 * Parse the stdout of `ps -axo pid=,command=`.
 *
 * Output format per line: `<pid> <command tokens...>` where the first token is
 * the PID and the rest form the full command string.  Leading whitespace on
 * each line is stripped by `ps` on some platforms; we trim each line before
 * splitting.
 *
 * Exported for unit tests.
 */
export function parseUnixPsOutput(
  stdout: string,
  sessionId: string,
  daemonChildPid?: number
): ParsedCandidateSet {
  const candidates: SessionHost[] = [];
  const childGuardedPids: number[] = [];
  const diagnostics: string[] = [];
  let malformedLines = 0;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimStart();
    if (line.length === 0) continue;

    // Split on whitespace (one or more spaces) to get tokens.
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2) {
      malformedLines += 1;
      continue;
    }

    const pid = parsePositivePid(tokens[0]!);
    if (pid === undefined) {
      malformedLines += 1;
      continue;
    }

    // The command is everything after the PID token (tokens[1..]).
    const commandTokens = tokens.slice(1);
    if (!commandContainsSessionToken(commandTokens, sessionId)) {
      continue;
    }

    const command = commandTokens.join(" ");

    if (daemonChildPid !== undefined && pid === daemonChildPid) {
      childGuardedPids.push(pid);
      diagnostics.push(
        `child-guard: pid ${pid} matches daemonChildPid — skipped`
      );
      continue;
    }

    candidates.push({ pid, command });
  }

  return { candidates, childGuardedPids, malformedLines, diagnostics };
}

// ── Windows parser ────────────────────────────────────────────────────────────

interface RawWin32Process {
  ProcessId?: unknown;
  CommandLine?: unknown;
}

function isRawWin32Process(v: unknown): v is RawWin32Process {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parse the stdout of the PowerShell Get-CimInstance query (JSON output).
 *
 * The PS ConvertTo-Json output is one of:
 *   - `null` or empty: no processes
 *   - A single JSON object: `{"ProcessId": N, "CommandLine": "..."}`
 *   - A JSON array of objects: `[{"ProcessId": N, "CommandLine": "..."}, ...]`
 *
 * The same exact-boundary matching as Unix is applied to the CommandLine.
 *
 * Exported for unit tests.
 */
export function parseWindowsPsOutput(
  stdout: string,
  sessionId: string,
  daemonChildPid?: number
): ParsedCandidateSet {
  const candidates: SessionHost[] = [];
  const childGuardedPids: number[] = [];
  const diagnostics: string[] = [];

  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed === "null") {
    return { candidates, childGuardedPids, malformedLines: 0, diagnostics };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      candidates,
      childGuardedPids,
      malformedLines: 1,
      diagnostics: [
        `json-parse-error: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  let malformedLines = 0;

  for (const row of rows) {
    if (!isRawWin32Process(row)) {
      malformedLines += 1;
      diagnostics.push(`malformed-row: not an object`);
      continue;
    }

    const rawPid = row.ProcessId;
    const rawCmd = row.CommandLine;

    if (
      typeof rawPid !== "number" ||
      !Number.isFinite(rawPid) ||
      !Number.isInteger(rawPid) ||
      rawPid <= 0
    ) {
      malformedLines += 1;
      diagnostics.push(`invalid-ProcessId: ${String(rawPid)}`);
      continue;
    }

    const pid = rawPid as number;

    if (typeof rawCmd !== "string") {
      malformedLines += 1;
      diagnostics.push(`invalid-CommandLine: not a string for pid ${pid}`);
      continue;
    }

    const commandTokens = rawCmd.trim().split(/\s+/);
    if (!commandContainsSessionToken(commandTokens, sessionId)) {
      continue;
    }

    if (daemonChildPid !== undefined && pid === daemonChildPid) {
      childGuardedPids.push(pid);
      diagnostics.push(
        `child-guard: pid ${pid} matches daemonChildPid — skipped`
      );
      continue;
    }

    candidates.push({ pid, command: rawCmd });
  }

  return { candidates, childGuardedPids, malformedLines, diagnostics };
}

// ── Main driver ───────────────────────────────────────────────────────────────

/**
 * Run the appropriate process-list query and return the unique session host.
 *
 * Throws if:
 *   - Zero candidates (session host not found or already exited)
 *   - More than one candidate (ambiguous — cannot signal safely)
 *
 * Returns `undefined` (rather than throwing) if the platform is unsupported.
 */
export async function resolveSessionHost(
  platform: HarnessPlatform,
  sessionId: string,
  runner: CommandRunner,
  options: ProcessDiscoveryOptions
): Promise<SessionHost> {
  validateSessionId(sessionId);

  const timeoutMs = options.timeoutMs ?? 15_000;
  const baseDir = options.artifactsDir;

  if (platform === "windows") {
    return resolveSessionHostWindows(sessionId, runner, options.daemonChildPid, baseDir, timeoutMs);
  }
  return resolveSessionHostUnix(sessionId, runner, options.daemonChildPid, baseDir, timeoutMs);
}

async function resolveSessionHostUnix(
  sessionId: string,
  runner: CommandRunner,
  daemonChildPid: number | undefined,
  baseDir: string,
  timeoutMs: number
): Promise<SessionHost> {
  const result = await runner.run({
    file: "ps",
    args: ["-axo", "pid=,command="],
    cwd: "/",
    env: {},
    timeoutMs,
    stdoutPath: join(baseDir, "process-discovery-ps.stdout.log"),
    stderrPath: join(baseDir, "process-discovery-ps.stderr.log"),
  });

  if (result.code !== 0) {
    throw new HarnessError(
      "prerequisite",
      `ps command failed with exit code ${result.code}: ${result.stderr.slice(0, 200)}`
    );
  }

  const { candidates, childGuardedPids, diagnostics } = parseUnixPsOutput(
    result.stdout,
    sessionId,
    daemonChildPid
  );

  return selectSingleCandidate(sessionId, candidates, childGuardedPids, diagnostics, "ps");
}

async function resolveSessionHostWindows(
  sessionId: string,
  runner: CommandRunner,
  daemonChildPid: number | undefined,
  baseDir: string,
  timeoutMs: number
): Promise<SessionHost> {
  // Fixed PowerShell query — no shell=true, no constructed shell command.
  // The session ID is embedded in the filter expression as a PS literal.
  // Session IDs are validated to [A-Za-z0-9._~-]+ so they cannot contain
  // PS metacharacters.
  const psCommand = [
    `Get-CimInstance Win32_Process`,
    `| Where-Object { $_.CommandLine -like '*__session ${sessionId} *' -or $_.CommandLine -like '*__session ${sessionId}' }`,
    `| Select-Object ProcessId,CommandLine`,
    `| ConvertTo-Json -Compress`,
  ].join(" ");

  const result = await runner.run({
    file: "powershell.exe",
    args: ["-NonInteractive", "-NoProfile", "-Command", psCommand],
    cwd: "C:\\",
    env: {},
    timeoutMs,
    stdoutPath: join(baseDir, "process-discovery-ps.stdout.log"),
    stderrPath: join(baseDir, "process-discovery-ps.stderr.log"),
  });

  if (result.code !== 0) {
    throw new HarnessError(
      "prerequisite",
      `PowerShell process query failed with exit code ${result.code}: ${result.stderr.slice(0, 200)}`
    );
  }

  const { candidates, childGuardedPids, diagnostics } = parseWindowsPsOutput(
    result.stdout,
    sessionId,
    daemonChildPid
  );

  return selectSingleCandidate(
    sessionId,
    candidates,
    childGuardedPids,
    diagnostics,
    "powershell"
  );
}

function selectSingleCandidate(
  sessionId: string,
  candidates: SessionHost[],
  childGuardedPids: number[],
  diagnostics: string[],
  source: string
): SessionHost {
  if (candidates.length === 0) {
    const guardNote =
      childGuardedPids.length > 0
        ? ` (child-guarded pids: ${childGuardedPids.join(", ")})`
        : "";
    const diagNote = diagnostics.length > 0 ? ` — ${diagnostics.join("; ")}` : "";
    throw new HarnessError(
      "assertion",
      `No session host found for session "${sessionId}" via ${source}${guardNote}${diagNote}`
    );
  }

  if (candidates.length > 1) {
    const pids = candidates.map((c) => c.pid).join(", ");
    throw new HarnessError(
      "assertion",
      `Ambiguous: ${candidates.length} processes match session "${sessionId}" via ${source} (pids: ${pids}) — cannot signal safely`
    );
  }

  return candidates[0]!;
}
