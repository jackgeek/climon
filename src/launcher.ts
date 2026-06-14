import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  ensureClimonHome,
  getClimonHome,
  loadConfig,
  NEST_LEVEL_ENV_VAR,
  SESSION_ENV_VAR,
  resolveConfigSetting
} from "./config.js";
import { spawnHeadlessSession } from "./client/spawn-session.js";
import { queryTerminalTitle } from "./client/query-title.js";
import { sanitizeTitle } from "./client/title.js";
import { sortSessionsByPriority } from "./priority.js";
import { selfSpawnArgs } from "./self-spawn.js";
import { AUTO_COLOR_ORDER, ANSI_COLORS, DEFAULT_PRIORITY, parseColorMode } from "./session-meta.js";
import { listSessions, patchSessionMeta, readSessionMeta, removeSessionMeta, writeSessionMeta } from "./store.js";
import { isProcessAlive, killProcess } from "./process-kill.js";
import { detectDevtunnel, type DetectResult } from "./remote/tunnel.js";
import { discoverDashboard } from "./remote/discovery.js";
import { maybeAutoLink } from "./remote/link.js";
import { generateSessionId } from "./session-id.js";
import { resolveClientId } from "./remote/client-id.js";
import { formatSessionSocketRef } from "./session-socket.js";
import { runSessionHost } from "./session-host.js";
import type { AnsiColor, SessionColorMode, SessionMeta } from "./types.js";
import { VERSION } from "./version.js";
import { child, suspendTerminal, resumeTerminal } from "./logging/logger.js";

const log = () => child("launcher");

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

export function launchBanner(version: string, id: string): string {
  return `climon v${version} monitoring session ${id}\r\n`;
}


interface UplinkStartConfig {
  enabled: boolean;
  host?: unknown;
  tunnelId?: unknown;
  port?: unknown;
}

interface UplinkStartPlan {
  shouldSpawn: boolean;
  warning?: string;
}

export function planUplinkStart(config: UplinkStartConfig, detect: DetectResult): UplinkStartPlan {
  if (!config.enabled) {
    return { shouldSpawn: false };
  }
  if (config.host && config.port) {
    return { shouldSpawn: true };
  }
  if (!config.tunnelId) {
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
  const host = resolveConfigSetting("remote.host", process.env, process.cwd());
  const tunnelId = resolveConfigSetting("remote.tunnelId", process.env, process.cwd());
  const port = resolveConfigSetting("remote.port", process.env, process.cwd());
  const peerHome = resolveConfigSetting("remote.peerHome", process.env, process.cwd());

  log().debug(`ensureUplink: enabled=${enabled} host=${host ?? "unset"} tunnelId=${tunnelId ? "set" : "unset"} port=${port ?? "unset"} peerHome=${peerHome ? "set" : "unset"}`);

  let shouldSpawn = false;

  // Same-machine WSL<->Windows: if a dashboard is discovered on the peer OS,
  // bridge this local session to it over the uplink/ingest mux.
  if (typeof peerHome === "string" && peerHome.length > 0) {
    const target = await discoverDashboard(process.env, process.cwd());
    if (target?.location === "peer") {
      shouldSpawn = true;
      process.stdout.write(
        `climon: dashboard detected on the peer OS; this session will appear at ${target.url}\r\n`
      );
    }
  }

  if (!shouldSpawn) {
    const needsTunnel = enabled && !host && tunnelId;
    const detect = needsTunnel ? await detectDevtunnel() : { available: false };
    const plan = planUplinkStart({ enabled, host, tunnelId, port }, detect);
    if (plan.warning) process.stderr.write(plan.warning);
    shouldSpawn = plan.shouldSpawn;
    log().debug(`ensureUplink: planUplinkStart → shouldSpawn=${shouldSpawn}${plan.warning ? " (with warning)" : ""}`);
  }

  if (!shouldSpawn) {
    log().debug("ensureUplink: not spawning uplink");
    return;
  }
  log().debug("ensureUplink: spawning detached __uplink process");
  const child = spawn(process.execPath, selfSpawnArgs(["__uplink"]), {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

/**
 * Builds a user-friendly display command from the raw argv. If the first
 * element is an absolute path, replaces it with just the executable name
 * (stripping `.exe` on Windows) so "C:\...\powershell.exe" becomes "powershell".
 */
function buildDisplayCommand(command: string[]): string {
  if (command.length === 0) return "";
  const first = command[0];
  const isAbsolute = first.startsWith("/") || /^[A-Za-z]:[/\\]/.test(first);
  if (!isAbsolute) return command.join(" ");
  const short = basename(first).replace(/\.exe$/i, "");
  return [short, ...command.slice(1)].join(" ");
}

export interface SessionDefaultFlags {
  color?: SessionColorMode | null;
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
 * defaults (color auto, priority 500) apply. A `session.color` of "auto"
 * resolves to the least-used concrete color, and "none" resolves to null.
 */
export async function chooseAutoSessionColor(env: NodeJS.ProcessEnv = process.env): Promise<AnsiColor> {
  const sessions = await listSessions(env);
  const counts = new Map<AnsiColor, number>();
  for (const color of AUTO_COLOR_ORDER) counts.set(color, 0);
  for (const session of sessions) {
    if (session.color && (ANSI_COLORS as readonly string[]).includes(session.color)) {
      counts.set(session.color, (counts.get(session.color) ?? 0) + 1);
    }
  }
  let selected = AUTO_COLOR_ORDER[0];
  let selectedCount = counts.get(selected) ?? 0;
  for (const color of AUTO_COLOR_ORDER.slice(1)) {
    const count = counts.get(color) ?? 0;
    if (count < selectedCount) {
      selected = color;
      selectedCount = count;
    }
  }
  return selected;
}

export async function resolveSessionDefaults(
  flags: SessionDefaultFlags,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): Promise<ResolvedSessionDefaults> {
  let color: AnsiColor | null;
  if (flags.color !== undefined) {
    color = flags.color === "auto" ? await chooseAutoSessionColor(env) : flags.color === "none" ? null : flags.color;
  } else {
    const raw = resolveConfigSetting("session.color", env, cwd);
    const mode = typeof raw === "string" ? parseColorMode(raw) : "auto";
    color = mode === "auto" ? await chooseAutoSessionColor(env) : mode === "none" ? null : mode;
  }

  let priority: number;
  if (typeof flags.priority === "number") {
    priority = flags.priority;
  } else {
    const raw = resolveConfigSetting("session.priority", env, cwd);
    const n = typeof raw === "number" ? raw : Number(raw);
    priority = Number.isInteger(n) && n >= 0 && n <= 1000 ? n : DEFAULT_PRIORITY;
  }

  return { color, priority };
}

export async function startMonitoredCommand(
  command: string[],
  options: { headless?: boolean; name?: string } & SessionDefaultFlags = {}
): Promise<number> {
  if (process.env[SESSION_ENV_VAR]) {
    process.stderr.write("climon: cannot start a nested session from inside an existing climon session.\n");
    return 1;
  }

  // Warn about nested sessions immediately
  const nestLevel = parseInt(process.env[NEST_LEVEL_ENV_VAR] ?? "0", 10) || 0;
  if (nestLevel > 0) {
    process.stderr.write(`\x1b[33mclimon: nested session (depth ${nestLevel + 1})\x1b[0m\n`);
  }

  if (command.length === 0) {
    throw new Error("Provide a command to monitor, e.g. `climon copilot`.");
  }
  // Verify the command exists before starting. Skip check for paths
  // (which might be scripts) — only validate bare command names via PATH lookup.
  if (!command[0].includes("/") && !command[0].includes("\\")) {
    const resolved = Bun.which(command[0]);
    if (!resolved) {
      throw new Error(`${command[0]}: command not found`);
    }
  }
  await ensureClimonHome();
  const config = await loadConfig();
  const defaults = await resolveSessionDefaults(
    { color: options.color, priority: options.priority },
    process.env,
    process.cwd()
  );

  if (options.headless) {
    const id = await spawnHeadlessSession(command, process.cwd(), resolveLaunchSize(process.env), {
      name: options.name,
      priority: defaults.priority,
      color: defaults.color ?? undefined
    });
    await maybeAutoLink();
    await ensureUplink();
    process.stdout.write(`${id}\n`);
    return 0;
  }

  if (options.name === undefined && config.terminal.setTitle) {
    const queried = await queryTerminalTitle();
    const inferred = queried ? sanitizeTitle(queried).trim() : "";
    options.name = inferred.length > 0 ? inferred : buildDisplayCommand(command);
  }

  const id = await generateSessionId();
  const { cols, rows } = terminalSize();
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    id,
    command,
    displayCommand: buildDisplayCommand(command),
    name: options.name,
    priority: defaults.priority,
    color: defaults.color ?? undefined,
    cwd: process.cwd(),
    status: "running",
    priorityReason: "running",
    socketPath: formatSessionSocketRef("127.0.0.1", 0),
    cols,
    rows,
    headless: options.headless ?? false,
    clientLabel: resolveClientId(),
    clientVersion: VERSION,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now
  };
  await writeSessionMeta(meta);

  await maybeAutoLink();
  await ensureUplink();

  log().info(launchBanner(VERSION, id).trimEnd());

  suspendTerminal();
  let exitCode: number;
  try {
    exitCode = await runSessionHost(id, meta, { headless: options.headless });
  } finally {
    resumeTerminal();
  }

  if (nestLevel > 0) {
    process.stderr.write(`\x1b[33mclimon: returning to session (depth ${nestLevel})\x1b[0m\n`);
  }
  return exitCode;
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

async function killSessionMeta(
  meta: SessionMeta,
  kill: (pid: number, force: boolean) => boolean,
  isAlive: (pid: number) => boolean
): Promise<boolean> {
  const id = meta.id;
  if (meta.daemonPid === undefined) {
    if (meta.origin !== "remote") {
      process.stdout.write(
        `climon: could not terminate session ${id}; daemon pid is not available yet.\n`
      );
      return false;
    }
  } else if (!kill(meta.daemonPid, false) && isAlive(meta.daemonPid)) {
    kill(meta.daemonPid, true);
    if (isAlive(meta.daemonPid)) {
      process.stdout.write(
        `climon: could not terminate session ${id}; it may still be running.\n`
      );
      return false;
    }
  }
  await patchSessionMeta(id, { status: "failed", priorityReason: "failed" });
  await removeSessionMeta(id);
  return true;
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
  if (!(await killSessionMeta(meta, kill, isAlive))) {
    return 1;
  }
  process.stdout.write(`Killed session ${id}.\n`);
  return 0;
}

export async function killAllSessions(
  kill: (pid: number, force: boolean) => boolean = killProcess,
  isAlive: (pid: number) => boolean = isProcessAlive
): Promise<number> {
  const activeSessions = (await listSessions())
    .filter(
      (session) =>
        session.status === "running" ||
        session.status === "acknowledged" ||
        session.status === "needs-attention" ||
        session.status === "paused"
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (activeSessions.length === 0) {
    process.stdout.write("No active climon sessions found.\n");
    return 0;
  }

  let killed = 0;
  let removed = 0;
  let failed = 0;
  for (const session of activeSessions) {
    if (await killSessionMeta(session, kill, isAlive)) {
      if (session.daemonPid === undefined) {
        removed += 1;
      } else {
        killed += 1;
      }
    } else {
      failed += 1;
    }
  }

  if (killed > 0) {
    process.stdout.write(`Killed ${killed} climon session${killed === 1 ? "" : "s"}.\n`);
  }
  if (removed > 0) {
    process.stdout.write(`Removed ${removed} daemon-less climon session${removed === 1 ? "" : "s"}.\n`);
  }
  return failed === 0 ? 0 : 1;
}

export async function climonHomeExists(): Promise<boolean> {
  try {
    await stat(getClimonHome());
    return true;
  } catch {
    return false;
  }
}
