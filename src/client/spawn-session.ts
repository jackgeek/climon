import { openSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ensureClimonHome, getSessionsDir, getSocketPath } from "../config.js";
import { writeSessionMeta } from "../store.js";
import type { SessionMeta } from "../types.js";
import { VERSION } from "../version.js";

function generateSessionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function spawnDaemon(id: string, env: NodeJS.ProcessEnv): void {
  const logPath = join(getSessionsDir(env), `${id}.log`);
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [process.argv[1], "__session", id], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env
  });
  child.unref();
}

/**
 * Creates a new monitored session that runs without a local terminal attached:
 * writes its metadata (with the supplied working directory and grid size) and
 * spawns a detached daemon to own the PTY. Returns the new session id. Shared by
 * the CLI launcher (for `climon run --headless`) and the attached client (when
 * it spawns a sibling on behalf of a dashboard [+] click).
 */
export async function spawnHeadlessSession(
  command: string[],
  cwd: string,
  size: { cols: number; rows: number },
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (command.length === 0) {
    throw new Error("Provide a command to monitor, e.g. `climon copilot`.");
  }
  await ensureClimonHome(env);
  const id = generateSessionId();
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    id,
    command,
    displayCommand: command.join(" "),
    cwd,
    status: "running",
    priorityReason: "running",
    socketPath: getSocketPath(id, env),
    cols: Math.max(size.cols, 1),
    rows: Math.max(size.rows, 1),
    headless: true,
    clientVersion: VERSION,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now
  };
  await writeSessionMeta(meta, env);
  spawnDaemon(id, env);
  return id;
}
