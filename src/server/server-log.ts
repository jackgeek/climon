/**
 * Persistent file-based logger for the dashboard server. Writes detailed
 * timestamped logs to `$CLIMON_HOME/logs/server/` regardless of CLIMON_DEBUG.
 * Each server invocation creates a new log file named by start timestamp and PID.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getClimonHome } from "../config.js";

const startTime = Date.now();
let logPath: string | undefined;
let logDir: string | undefined;

function ensureLogDir(env: NodeJS.ProcessEnv = process.env): string {
  if (!logDir) {
    logDir = join(getClimonHome(env), "logs", "server");
    mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

function ensureLogPath(env: NodeJS.ProcessEnv = process.env): string {
  if (!logPath) {
    const dir = ensureLogDir(env);
    const d = new Date(startTime);
    const ts = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}-${String(d.getUTCMinutes()).padStart(2, "0")}-${String(d.getUTCSeconds()).padStart(2, "0")}`;
    logPath = join(dir, `${ts}.log`);
  }
  return logPath;
}

/**
 * Writes a line to the server log file. Includes a high-resolution relative
 * timestamp (seconds since process start) and an absolute ISO timestamp.
 */
export function serverLog(message: string, env: NodeJS.ProcessEnv = process.env): void {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(3);
  const line = `[${new Date().toISOString()} +${elapsed}s] ${message}\n`;
  try {
    appendFileSync(ensureLogPath(env), line);
  } catch {
    // Best-effort: don't let logging failures break the server.
  }
}

/** Returns the directory where server logs are stored. */
export function getServerLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return ensureLogDir(env);
}
