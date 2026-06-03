import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import {
  ensureClimonHome,
  getClimonHome,
  getSocketPath,
  loadConfig,
  resolveConfigSetting,
  SESSION_ENV_VAR
} from "./config.js";
import { connectToSession } from "./client/connect.js";
import { describeDetachKey } from "./client/detach-key.js";
import { queryTerminalTitle } from "./client/query-title.js";
import { sanitizeTitle } from "./client/title.js";
import { spawnHeadlessSession, type SessionMetaOptions } from "./client/spawn-session.js";
import { sortSessionsByPriority } from "./priority.js";
import { spawnDaemon } from "./spawn-daemon.js";
import { selfSpawnArgs } from "./self-spawn.js";
import { listSessions, patchSessionMeta, readSessionMeta, removeSessionMeta, writeSessionMeta } from "./store.js";
import { resolveCommand } from "./pty.js";
import { isProcessAlive, killProcess } from "./process-kill.js";
import { detectDevtunnel, type DetectResult } from "./remote/tunnel.js";
import type { AnsiColor, SessionMeta } from "./types.js";
import { VERSION } from "./version.js";

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

async function waitForHeadlessReady(id: string, socketPath: string, timeoutMs = 10000): Promise<void> {
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
    const current = await readSessionMeta(id);
    if (current?.status === "completed" || current?.status === "failed") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for session daemon socket at ${socketPath}`);
}

interface UplinkStartConfig {
  enabled: boolean;
  tunnelId?: unknown;
  tunnelToken?: unknown;
  port?: unknown;
}

interface UplinkStartPlan {
  shouldSpawn: boolean;
  warning?: string;
}

export function planUplinkStart(config: UplinkStartConfig, detect: DetectResult): UplinkStartPlan {
  if (!config.enabled || !config.tunnelId || !config.tunnelToken || !config.port) {
    return { shouldSpawn: false };
  }
  if (!detect.available) {
    return {
      shouldSpawn: false,
      warning:
        "climon: remote monitoring is configured, but the devtunnel CLI is not installed or not runnable on this machine. Install devtunnel for sessions to appear on the remote dashboard.\n"
    };
  }
  return { shouldSpawn: true };
}

async function ensureUplink(): Promise<void> {
  const enabled = resolveConfigSetting("remote.enabled", process.env, process.cwd()) === true;
  const tunnelId = resolveConfigSetting("remote.tunnelId", process.env, process.cwd());
  const tunnelToken = resolveConfigSetting("remote.tunnelToken", process.env, process.cwd());
  const port = resolveConfigSetting("remote.port", process.env, process.cwd());
  const plan = planUplinkStart({ enabled, tunnelId, tunnelToken, port }, await detectDevtunnel());
  if (plan.warning) process.stderr.write(plan.warning);
  if (!plan.shouldSpawn) return;
  const child = spawn(process.execPath, selfSpawnArgs(["__uplink"]), {
    detached: true,
    stdio: "ignore",
    windowsHide: true
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

const ANSI_COLORS: ReadonlySet<string> = new Set([
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white"
]);

export interface SessionDefaultFlags {
  color?: AnsiColor | null;
  priority?: number;
}

export interface ResolvedSessionDefaults {
  color: AnsiColor | null;
  priority: number;
}

/**
 * Resolves a session's accent color and sort priority. Explicit CLI flags take
 * precedence; otherwise the hierarchical config (`session.color` /
 * `session.priority`, repo-then-global) is consulted; otherwise the built-in
 * defaults (color none, priority 500) apply. A `session.color` of "none"
 * resolves to null.
 */
export function resolveSessionDefaults(
  flags: SessionDefaultFlags,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): ResolvedSessionDefaults {
  let color: AnsiColor | null;
  if (flags.color !== undefined) {
    color = flags.color;
  } else {
    const raw = resolveConfigSetting("session.color", env, cwd);
    color = typeof raw === "string" && ANSI_COLORS.has(raw) ? (raw as AnsiColor) : null;
  }

  let priority: number;
  if (typeof flags.priority === "number") {
    priority = flags.priority;
  } else {
    const raw = resolveConfigSetting("session.priority", env, cwd);
    const n = typeof raw === "number" ? raw : Number(raw);
    priority = Number.isInteger(n) && n >= 0 && n <= 1000 ? n : 500;
  }

  return { color, priority };
}

export async function startMonitoredCommand(
  command: string[],
  options: { headless?: boolean } & SessionMetaOptions = {}
): Promise<number> {
  if (command.length === 0) {
    throw new Error("Provide a command to monitor, e.g. `climon copilot`.");
  }
  if (!options.headless && process.env[SESSION_ENV_VAR]) {
    return runCommandDirectly(command);
  }
  await ensureClimonHome();
  const config = await loadConfig();
  const defaults = resolveSessionDefaults(
    { color: options.color, priority: options.priority },
    process.env,
    process.cwd()
  );

  if (options.headless) {
    const size = resolveLaunchSize(process.env);
    const id = await spawnHeadlessSession(command, process.cwd(), size, {
      name: options.name,
      priority: defaults.priority,
      color: defaults.color
    });
    const meta = await readSessionMeta(id);
    if (!meta) {
      throw new Error(`Session metadata for '${id}' not found.`);
    }
    await waitForHeadlessReady(id, meta.socketPath);
    process.stdout.write(`${id}\n`);
    return 0;
  }

  if (options.name === undefined && config.terminal.setTitle) {
    // No explicit --name: adopt the terminal's current title if we can read it,
    // otherwise fall back to the command string.
    const queried = await queryTerminalTitle();
    const inferred = queried ? sanitizeTitle(queried).trim() : "";
    options.name = inferred.length > 0 ? inferred : command.join(" ");
  }

  const id = generateSessionId();
  const { cols, rows } = terminalSize();
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    id,
    command,
    displayCommand: command.join(" "),
    name: options.name,
    priority: defaults.priority,
    color: defaults.color ?? undefined,
    cwd: process.cwd(),
    status: "running",
    priorityReason: "running",
    socketPath: getSocketPath(id),
    cols,
    rows,
    headless: false,
    clientVersion: VERSION,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now
  };
  await writeSessionMeta(meta);

  spawnDaemon(id, process.env);

  await ensureUplink();

  await waitForSocket(meta.socketPath);

  const dashboardUrl = `http://${config.server.host}:${config.server.port}/`;
  const detachKey = describeDetachKey(config.terminal.detachPrefix);
  process.stdout.write(`climon v${VERSION} monitoring session ${id} — dashboard: ${dashboardUrl}\r\n`);
  process.stdout.write(`Detach with ${detachKey} then d.\r\n`);

  const result = await connectToSession(meta.socketPath, config.terminal.detachPrefix);
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
  const config = await loadConfig();
  process.stdout.write(reconnectBanner(id));
  const result = await connectToSession(meta.socketPath, config.terminal.detachPrefix);
  if (result.detached) {
    process.stdout.write(`\r\nDetached. Reattach with: climon attach ${id}\r\n`);
    return 0;
  }
  return result.exitCode;
}

export function reconnectBanner(id: string): string {
  return `climon v${VERSION} connecting to session ${id}\r\n`;
}

export async function listSessionsCommand(): Promise<number> {
  const sessions = sortSessionsByPriority(await listSessions());
  if (sessions.length === 0) {
    process.stdout.write("No climon sessions found.\n");
    return 0;
  }
  for (const session of sessions) {
    const flag = session.status === "needs-attention" ? "!" : " ";
    const label = session.name ? `${session.name} (${session.displayCommand})` : session.displayCommand;
    process.stdout.write(
      `${flag} ${session.id.padEnd(16)} ${session.status.padEnd(16)} ${label}\n`
    );
  }
  return 0;
}

export async function killSession(
  id: string,
  kill: (pid: number, force: boolean) => boolean = killProcess,
  isAlive: (pid: number) => boolean = isProcessAlive
): Promise<number> {
  const meta = await readSessionMeta(id);
  if (!meta) {
    throw new Error(`No session found with id '${id}'.`);
  }
  if (meta.daemonPid) {
    // Try a graceful stop first. On POSIX a SIGTERM is "issued" successfully even
    // though the shell exits a moment later, so a successful graceful kill ends
    // here. If the graceful kill could not be delivered and the process is still
    // alive — e.g. a windowless console process on Windows, which `taskkill`
    // cannot stop without `/F` — escalate to a forced kill.
    if (!kill(meta.daemonPid, false) && isAlive(meta.daemonPid)) {
      kill(meta.daemonPid, true);
      if (isAlive(meta.daemonPid)) {
        process.stdout.write(
          `climon: could not terminate session ${id}; it may still be running.\n`
        );
        return 1;
      }
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
