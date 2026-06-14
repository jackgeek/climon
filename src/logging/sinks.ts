import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { getLogsDir } from "../config.js";
import type { LogRole, StreamEntry } from "./types.js";

export function logDirForRole(role: LogRole, env: NodeJS.ProcessEnv = process.env): string {
  return join(getLogsDir(env), role);
}

function startStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}`;
}

/**
 * Returns the NDJSON log file path for a role. Daemon uses `<id>.log`; other
 * roles use `<utc-timestamp>-<pid>.log` (one file per process invocation).
 */
export function logFilePathForRole(
  role: LogRole,
  env: NodeJS.ProcessEnv = process.env,
  sessionId?: string,
): string {
  const dir = logDirForRole(role, env);
  if (role === "daemon") {
    if (!sessionId) throw new Error("daemon log file path requires a sessionId");
    return join(dir, `${sessionId}.log`);
  }
  return join(dir, `${startStamp()}-${process.pid}.log`);
}

/**
 * Creates the NDJSON file destination stream for a role, creating the log
 * directory if needed. Returns a multistream entry.
 */
export function buildFileStream(
  role: LogRole,
  env: NodeJS.ProcessEnv = process.env,
  sessionId?: string,
): StreamEntry {
  const dir = logDirForRole(role, env);
  mkdirSync(dir, { recursive: true });
  const path = logFilePathForRole(role, env, sessionId);
  return { stream: pino.destination({ dest: path, sync: true, mkdir: true }) as unknown as NodeJS.WritableStream };
}
