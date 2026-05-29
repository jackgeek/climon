import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { stat } from "node:fs/promises";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  ensureClimonHome,
  getClimonHome,
  getSessionsDir,
  getSocketPath,
  loadConfig,
  SESSION_ENV_VAR
} from "./config.js";
import { connectToSession } from "./client/connect.js";
import { sortSessionsByPriority } from "./priority.js";
import { listSessions, patchSessionMeta, readSessionMeta, removeSessionMeta, writeSessionMeta } from "./store.js";
import { resolveCommand } from "./pty.js";
import type { SessionMeta } from "./types.js";

function generateSessionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function terminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24
  };
}

export function resolveLaunchSize(env: NodeJS.ProcessEnv): { cols: number; rows: number } {
  const cols = Number.parseInt(env.CLIMON_COLS ?? "", 10);
  const rows = Number.parseInt(env.CLIMON_ROWS ?? "", 10);
  return {
    cols: Number.isFinite(cols) && cols > 0 ? cols : 80,
    rows: Number.isFinite(rows) && rows > 0 ? rows : 24
  };
}

async function waitForSocket(socketPath: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect(socketPath);
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for session daemon socket at ${socketPath}`);
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
 * Runs a command directly with inherited stdio, without starting a monitored
 * session. Used when climon is invoked from inside an existing climon session
 * so the parent session keeps ownership of the PTY.
 */
function runCommandDirectly(command: string[]): Promise<number> {
  const { file, args } = resolveCommand(command);
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "inherit" });
    child.once("error", (error) => {
      process.stderr.write(`climon: failed to run ${file}: ${error.message}\n`);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

export async function startMonitoredCommand(
  command: string[],
  options: { headless?: boolean } = {}
): Promise<number> {
  if (command.length === 0) {
    throw new Error("Provide a command to monitor, e.g. `climon copilot`.");
  }
  if (!options.headless && process.env[SESSION_ENV_VAR]) {
    return runCommandDirectly(command);
  }
  await ensureClimonHome();
  const config = await loadConfig();

  const id = generateSessionId();
  const { cols, rows } = options.headless ? resolveLaunchSize(process.env) : terminalSize();
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    id,
    command,
    displayCommand: command.join(" "),
    cwd: process.cwd(),
    status: "running",
    priorityReason: "running",
    socketPath: getSocketPath(id),
    cols,
    rows,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now
  };
  await writeSessionMeta(meta);

  spawnDaemon(id, process.env);

  if (options.headless) {
    process.stdout.write(`${id}\n`);
    return 0;
  }

  await waitForSocket(meta.socketPath);

  const dashboardUrl = `http://${config.server.host}:${config.server.port}/`;
  process.stdout.write(`climon monitoring session ${id} — dashboard: ${dashboardUrl}\r\n`);
  process.stdout.write("Detach with Ctrl-\\ then d.\r\n");

  const result = await connectToSession(meta.socketPath);
  if (result.detached) {
    process.stdout.write(`\r\nDetached. Reattach with: climon attach ${id}\r\n`);
    return 0;
  }
  return result.exitCode;
}

export async function reconnectSession(id: string): Promise<number> {
  const meta = await readSessionMeta(id);
  if (!meta) {
    throw new Error(`No session found with id '${id}'.`);
  }
  if (meta.status === "completed" || meta.status === "failed") {
    process.stdout.write(`Session ${id} already ${meta.status} (exit code ${meta.exitCode ?? 0}).\r\n`);
    return meta.exitCode ?? 0;
  }
  const result = await connectToSession(meta.socketPath);
  if (result.detached) {
    process.stdout.write(`\r\nDetached. Reattach with: climon attach ${id}\r\n`);
    return 0;
  }
  return result.exitCode;
}

export async function listSessionsCommand(): Promise<number> {
  const sessions = sortSessionsByPriority(await listSessions());
  if (sessions.length === 0) {
    process.stdout.write("No climon sessions found.\n");
    return 0;
  }
  for (const session of sessions) {
    const flag = session.status === "needs-attention" ? "!" : " ";
    process.stdout.write(
      `${flag} ${session.id.padEnd(16)} ${session.status.padEnd(16)} ${session.displayCommand}\n`
    );
  }
  return 0;
}

export async function killSession(id: string): Promise<number> {
  const meta = await readSessionMeta(id);
  if (!meta) {
    throw new Error(`No session found with id '${id}'.`);
  }
  if (meta.daemonPid) {
    try {
      process.kill(meta.daemonPid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await patchSessionMeta(id, { status: "failed", priorityReason: "failed" });
  await removeSessionMeta(id);
  process.stdout.write(`Killed session ${id}.\n`);
  return 0;
}

export async function climonHomeExists(): Promise<boolean> {
  try {
    await stat(getClimonHome());
    return true;
  } catch {
    return false;
  }
}
