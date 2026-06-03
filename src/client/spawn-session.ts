import { randomBytes } from "node:crypto";
import { ensureClimonHome, getSocketPath } from "../config.js";
import { spawnDaemon } from "../spawn-daemon.js";
import { writeSessionMeta } from "../store.js";
import type { AnsiColor, SessionMeta } from "../types.js";
import { VERSION } from "../version.js";

function generateSessionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/**
 * Creates a new monitored session that runs without a local terminal attached:
 * writes its metadata (with the supplied working directory and grid size) and
 * spawns a detached daemon to own the PTY. Returns the new session id. Shared by
 * the CLI launcher (for `climon run --headless`) and the attached client (when
 * it spawns a sibling on behalf of a dashboard [+] click).
 */
export interface SessionMetaOptions {
  name?: string;
  priority?: number;
  color?: AnsiColor | null;
}

export async function spawnHeadlessSession(
  command: string[],
  cwd: string,
  size: { cols: number; rows: number },
  options: SessionMetaOptions = {},
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
    name: options.name,
    priority: options.priority,
    color: options.color ?? undefined,
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
