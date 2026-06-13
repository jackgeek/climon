import { existsSync, rmSync, watch } from "node:fs";
import { type Socket } from "node:net";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import type { ServerWebSocket } from "bun";
import {
  ensureClimonHome,
  getClimonHome,
  getSessionsDir,
  loadConfig,
  resolveConfigSetting,
  saveConfig
} from "../config.js";
import {
  encodeFrame,
  encodeJsonFrame,
  FrameDecoder,
  FrameType,
  parseJsonPayload,
  type AttentionPayload,
  type ExitPayload,
  type PtySizePayload,
  type TerminalModePayload,
  type ResizePayload,
  type TerminalResizeMode
} from "../ipc/frame.js";
import { sortSessionsByPriority } from "../priority.js";
import { atomicWrite, listSessions, patchSessionMeta, patchSessionMetaWithCurrent, readScrollback, readSessionMeta, removeSessionMeta } from "../store.js";
import type { AnsiColor, ClimonConfig, SessionColorMode, SessionMeta, SessionStatus } from "../types.js";
import { getIngestPidPath, ingestNeedsRecycle, readRemoteHostState, resolveIngestBindAddress } from "../remote/ingest.js";
import { readIngestState, resolveIngestPort } from "../remote/ingest-state.js";
import { isWsl, peerOsLabel } from "../remote/peer.js";
import { stopUplinkDaemon } from "../remote/teardown.js";
import { detectDevtunnel, createTunnel, deleteTunnel, parseTunnelInput, useManualTunnel, reconcileTunnelPort } from "../remote/tunnel.js";
import { connectSessionSocket } from "../session-socket.js";
import { sanitizeBrowserTerminalReplay } from "../terminal-replay.js";
import { VERSION } from "../version.js";
import { getStaticAsset, renderDashboard } from "./assets.js";
import { createDashboardTunnelManager, dashboardTunnelAuthMessage } from "./dashboard-tunnel.js";
import { runPromote } from "./promote.js";
import { buildPromoteDeps } from "./promote-probes.js";
import { resolveServerInvocation } from "../cli/server-exec.js";
import { spawnHeadlessSession as spawnHeadlessSessionDirect } from "../client/spawn-session.js";
import { resolveSessionDefaults } from "../launcher.js";
import { parseColor, parseColorMode, parsePriority } from "../session-meta.js";
import { isProcessAlive, killProcess } from "../process-kill.js";
import { canBindTcpPort, chooseAvailablePort, isAddressInUse, PORT_RETRY_ATTEMPTS } from "../port-choice.js";
import {
  getServerStatePath,
  readServerState,
  readServerStateFromDir,
  serializeServerState,
  type ServerState
} from "../server-state.js";
import { writeShutdownRequestToDir } from "../remote/shutdown-request.js";
import { createShutdownRequestWatcher } from "../remote/shutdown-watch.js";
import { tieBreakOutcome } from "./tie-break.js";
import { serverLog } from "./server-log.js";


interface StartServerOptions {
  port?: number;
  enableRemotes?: boolean;
}

interface WsData {
  sessionId: string;
  socketPath: string;
}

interface ServerShutdownOptions {
  reason?: string;
  stopIngest?: boolean;
}

export const DASHBOARD_IDLE_TIMEOUT_SECONDS = 255;
const INGEST_DEMOTION_SHUTDOWN_SOURCE = "ingest-demotion";

// Bound the health probe so a process that holds the port but never answers
// HTTP (a stuck previous server or an unrelated listener) cannot hang start-up.
export const HEALTH_PROBE_TIMEOUT_MS = 2000;

const ATTACH_PATH = /^\/api\/sessions\/([^/]+)\/attach$/;
const SCROLLBACK_PATH = /^\/api\/sessions\/([^/]+)\/scrollback$/;
const SESSION_PATH = /^\/api\/sessions\/([^/]+)$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export type KillMode = "none" | "graceful" | "force";

interface ExistingDashboardServer {
  url: string;
  pid?: number;
}

type ServerConflictAction = "continue" | "exit";

function dashboardUrl(host: string, port: number): string {
  return `http://${host}:${port}/`;
}

/**
 * Reads the recorded server pid from the state file and returns it only if that
 * process is still alive.
 */
async function readLiveServerPid(
  env: NodeJS.ProcessEnv = process.env,
  isAlive: (pid: number) => boolean = isProcessAlive
): Promise<number | undefined> {
  const state = await readServerState(env);
  if (!state) return undefined;
  return isAlive(state.pid) ? state.pid : undefined;
}

export async function findExistingDashboardServer(
  host: string,
  port: number,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchFn?: typeof fetch;
    isProcessAliveFn?: (pid: number) => boolean;
  } = {}
): Promise<ExistingDashboardServer | undefined> {
  const url = dashboardUrl(host, port);
  const fetchFn = options.fetchFn ?? fetch;
  serverLog(`findExistingDashboardServer: probing ${url}health`);
  let healthy = false;
  try {
    const res = await fetchFn(`${url}health`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    if (res.ok) {
      const body = (await res.json()) as { ok?: unknown };
      healthy = body.ok === true;
    }
    serverLog(`findExistingDashboardServer: health response ok=${res.ok}, healthy=${healthy}`);
  } catch (err) {
    serverLog(`findExistingDashboardServer: health probe failed: ${err instanceof Error ? err.message : String(err)}`);
    healthy = false;
  }
  if (!healthy) {
    serverLog("findExistingDashboardServer: not healthy — no existing server");
    return undefined;
  }

  const pid = await readLiveServerPid(options.env, options.isProcessAliveFn);
  serverLog(`findExistingDashboardServer: healthy server found, pid=${pid ?? "unknown"}`);
  return pid === undefined ? { url } : { url, pid };
}

/**
 * Terminates a known-alive pid, escalating from a graceful stop to a forced
 * kill. The graceful attempt is best-effort: if it cannot even be issued (e.g.
 * Windows `taskkill` without /F on a windowless console process reports
 * failure), we do not give up — we re-check liveness and force-kill rather than
 * leaving the process running. Returns true once the process is gone.
 */
async function terminatePidWithEscalation(
  pid: number,
  kill: (pid: number, force: boolean) => boolean,
  isAlive: (pid: number) => boolean,
  graceMs: number,
  pollMs: number
): Promise<boolean> {
  const waitForExit = async (): Promise<boolean> => {
    const deadline = Date.now() + graceMs;
    for (;;) {
      if (!isAlive(pid)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };
  if (kill(pid, false) && (await waitForExit())) return true;
  if (!isAlive(pid)) return true;
  if (!kill(pid, true)) return false;
  return waitForExit();
}

export async function stopDashboardServer(options: {
  env?: NodeJS.ProcessEnv;
  killProcess?: (pid: number, force: boolean) => boolean;
  isProcessAlive?: (pid: number) => boolean;
  graceMs?: number;
  pollMs?: number;
} = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const kill = options.killProcess ?? killProcess;
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  const pollMs = options.pollMs ?? 50;
  const pid = await readLiveServerPid(env, isAlive);
  serverLog(`stopDashboardServer: readLiveServerPid returned ${pid ?? "undefined"}`);
  if (pid === undefined) return false;
  const result = await terminatePidWithEscalation(pid, kill, isAlive, graceMs, pollMs);
  serverLog(`stopDashboardServer: terminatePidWithEscalation(${pid}) returned ${result}`);
  return result;
}

/**
 * Requests graceful shutdown via the server's internal HTTP endpoint.
 * Used when the PID is unknown (e.g. server running in WSL, server.json
 * deleted) but the server is reachable on localhost.
 */
async function requestServerShutdownViaHttp(url: string): Promise<boolean> {
  const shutdownUrl = `${url.replace(/\/?$/, "")}/__internal/shutdown`;
  serverLog(`requestServerShutdownViaHttp: POSTing to ${shutdownUrl}`);
  try {
    const res = await fetch(shutdownUrl, {
      method: "POST",
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      serverLog(`requestServerShutdownViaHttp: POST returned ${res.status} — treating as failure`);
      return false;
    }
    serverLog(`requestServerShutdownViaHttp: POST returned 200; polling for shutdown`);
  } catch (err) {
    serverLog(`requestServerShutdownViaHttp: POST failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  // Wait for the server to actually stop responding.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const probe = await fetch(`${url}health`, { signal: AbortSignal.timeout(500) });
      if (!probe.ok) {
        serverLog("requestServerShutdownViaHttp: health probe returned non-ok — server is down");
        return true;
      }
    } catch {
      serverLog("requestServerShutdownViaHttp: health probe threw — server is down");
      return true;
    }
  }
  serverLog("requestServerShutdownViaHttp: timed out waiting for server to stop");
  return false;
}

async function askExistingServerTermination(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function handleExistingDashboardServer(
  existing: ExistingDashboardServer,
  options: {
    stdinIsTTY?: boolean;
    write?: (text: string) => void;
    ask?: (question: string) => Promise<string>;
    stopServer?: (pid: number) => Promise<boolean>;
    requestShutdown?: (url: string) => Promise<boolean>;
  } = {}
): Promise<ServerConflictAction> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const stopServer =
    options.stopServer ??
    (async () => {
      return await stopDashboardServer();
    });
  const requestHttpShutdown = options.requestShutdown ?? requestServerShutdownViaHttp;

  serverLog(`handleExistingDashboardServer: existing=${JSON.stringify(existing)}, tty=${stdinIsTTY}`);

  if (!stdinIsTTY) {
    write(`climon server is already running at ${existing.url}\n`);
    serverLog("handleExistingDashboardServer: non-interactive — exiting");
    return "exit";
  }

  const ask = options.ask ?? askExistingServerTermination;
  const answer = (await ask(`climon server is already running at ${existing.url}. Terminate it? [y/N] `))
    .trim()
    .toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    write(`Existing server left running at ${existing.url}\n`);
    serverLog(`handleExistingDashboardServer: user declined (answer=${JSON.stringify(answer)})`);
    return "exit";
  }

  serverLog(`handleExistingDashboardServer: user confirmed termination`);

  if (existing.pid !== undefined) {
    serverLog(`handleExistingDashboardServer: attempting PID-based stop (pid=${existing.pid})`);
    if (await stopServer(existing.pid)) {
      serverLog("handleExistingDashboardServer: PID-based stop succeeded");
      write("Existing climon server terminated. Starting a new server...\n");
      return "continue";
    }
    serverLog("handleExistingDashboardServer: PID-based stop failed");
  }

  // PID unknown or kill failed — request graceful shutdown via HTTP.
  serverLog(`handleExistingDashboardServer: trying HTTP shutdown for ${existing.url}`);
  if (await requestHttpShutdown(existing.url)) {
    serverLog("handleExistingDashboardServer: HTTP shutdown succeeded");
    write("Existing climon server terminated. Starting a new server...\n");
    return "continue";
  }

  serverLog("handleExistingDashboardServer: all termination methods failed");
  write(`Unable to terminate the existing server at ${existing.url}\n`);
  return "exit";
}

/**
 * Parses the `kill` query parameter of a DELETE request. An absent (`null`),
 * empty, or `"none"` value means cleanup-only. `"graceful"` and `"force"` are
 * passed through. Anything else is invalid (caller should reject with 400).
 */
export function parseKillMode(value: string | null): KillMode | null {
  if (value === null || value === "" || value === "none") {
    return "none";
  }
  if (value === "graceful" || value === "force") {
    return value;
  }
  return null;
}

export function parseBrowserStatusPatch(value: unknown): Extract<SessionStatus, "paused" | "running"> {
  if (value === "paused" || value === "running") {
    return value;
  }
  throw new Error("Invalid status; expected paused or running");
}

export function validateBrowserStatusTransition(
  current: SessionStatus,
  next: Extract<SessionStatus, "paused" | "running">
): void {
  if (next === "paused") {
    if (current === "running" || current === "acknowledged" || current === "needs-attention" || current === "paused") {
      return;
    }
  } else if (current === "paused") {
    return;
  }
  throw new Error(`Invalid status transition from ${current} to ${next}`);
}

/** Grace period before rechecking liveness after a graceful (SIGTERM) kill. */
const KILL_GRACE_MS = 3000;

/**
 * Applies the requested kill mode to a session's daemon and reports whether the
 * daemon is still running afterwards. Signaling is best-effort: an already-dead
 * process (ESRCH) is treated as success. Only `graceful` can report
 * `stillRunning: true`, when the process survives SIGTERM past the grace period.
 */
export async function applySessionKill(
  pid: number | undefined,
  mode: KillMode,
  graceMs: number = KILL_GRACE_MS
): Promise<{ stillRunning: boolean }> {
  if (mode === "none" || pid === undefined) {
    return { stillRunning: false };
  }
  if (mode === "force") {
    killProcess(pid, true);
    return { stillRunning: false };
  }
  if (!killProcess(pid, false)) {
    return { stillRunning: false };
  }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  return { stillRunning: isProcessAlive(pid) };
}

/**
 * Extracts the hostname from a Host header value, stripping an optional port
 * and IPv6 brackets. Examples: "127.0.0.1:3131" -> "127.0.0.1",
 * "[::1]:3131" -> "::1", "localhost" -> "localhost".
 */
function hostHeaderHostname(value: string): string {
  let host = value.trim();
  const match = host.match(/^(\[[^\]]+\]|[^:]+)(?::\d+)?$/);
  if (match) {
    host = match[1];
  }
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

/**
 * Authorizes a privileged spawn request beyond loopback source-IP checking, to
 * defend against browser-mediated CSRF and DNS-rebinding from a page running on
 * the same machine. Requires a JSON content-type (so cross-origin requests must
 * attempt a CORS preflight, which the server never grants) and rejects any
 * non-loopback Origin or Host.
 */
export function isAllowedSpawnRequest(
  contentType: string | null,
  origin: string | null,
  host: string | null
): boolean {
  if (!contentType || !contentType.toLowerCase().includes("application/json")) {
    return false;
  }
  if (origin !== null) {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return false;
    }
    if (!LOOPBACK_HOSTS.has(originHost.replace(/^\[|\]$/g, "").toLowerCase())) {
      return false;
    }
  }
  if (host !== null && !LOOPBACK_HOSTS.has(hostHeaderHostname(host))) {
    return false;
  }
  return true;
}

export function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter((part) => part.length > 0);
}

export function browserResizePayload(message: {
  cols?: number;
  rows?: number;
  mode?: TerminalResizeMode;
}): ResizePayload | null {
  if (!message.cols || !message.rows) {
    return null;
  }
  const payload: ResizePayload = { cols: message.cols, rows: message.rows, source: "viewer" };
  if (message.mode === "clamped" || message.mode === "fill") {
    payload.mode = message.mode;
  }
  return payload;
}

export function browserAttentionPayload(message: {
  needsAttention?: boolean;
  attentionMatchedAt?: unknown;
  reason?: unknown;
}): AttentionPayload | null {
  if (message.needsAttention !== false || typeof message.attentionMatchedAt !== "string") {
    return null;
  }
  return { needsAttention: false, reason: "viewed", attentionMatchedAt: message.attentionMatchedAt };
}

export interface SpawnMetaOptions {
  name?: string;
  priority?: number;
  color?: SessionColorMode | null;
}

interface ResolvedSpawnMetaOptions {
  name?: string;
  priority?: number;
  color?: AnsiColor | null;
}

/**
 * Builds the argv passed to the climon client to spawn a headless session,
 * prepending --priority/--color/--name flags (when set) before the monitored
 * command. `color: null` is emitted as `--color none` so an inherited color can
 * be explicitly cleared.
 */
export function buildRunArgs(command: string[], meta: SpawnMetaOptions): string[] {
  const flags: string[] = [];
  if (typeof meta.priority === "number") {
    flags.push("--priority", String(meta.priority));
  }
  if (meta.color !== undefined) {
    flags.push("--color", meta.color ?? "none");
  }
  if (meta.name !== undefined && meta.name !== "") {
    flags.push("--name", meta.name);
  }
  return ["run", "--headless", ...flags, ...command];
}

function normalizeDimension(value: unknown, fallback: number): string {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (Number.isFinite(n) && n > 0) {
    return String(Math.trunc(n));
  }
  return String(fallback);
}

function defaultColorFlag(color: SessionColorMode | null | undefined): AnsiColor | "auto" | null | undefined {
  return color === "none" ? null : color;
}

export async function resolveParentSpawnColor(
  color: SessionColorMode | null | undefined,
  parentColor: AnsiColor | null | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<AnsiColor | null> {
  if (color === "auto") {
    return (await resolveSessionDefaults({ color: "auto" }, env, cwd)).color;
  }
  if (color === "none" || color === null) {
    return null;
  }
  if (color !== undefined) {
    return color;
  }
  return parentColor ?? null;
}

export function resolveParentSpawnCwd(cwd: unknown, parentCwd: string): string {
  return typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : parentCwd;
}

function resolveDevIngestEntrypoint(): string | undefined {
  if (!import.meta.url.startsWith("file:")) {
    return undefined;
  }
  try {
    const candidate = fileURLToPath(new URL("../server.ts", import.meta.url));
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function resolveIngestInvocation(
  env: NodeJS.ProcessEnv,
  execPath: string,
  devEntrypoint: string | undefined = resolveDevIngestEntrypoint()
): { file: string; args: string[] } {
  const inv = resolveServerInvocation([], env, execPath, devEntrypoint);
  return { file: inv.file, args: [...inv.args, "__ingest"] };
}

function spawnHeadlessSession(
  argv: string[],
  cwd: string,
  cols: string,
  rows: string,
  meta: ResolvedSpawnMetaOptions = {}
): Promise<string> {
  return spawnHeadlessSessionDirect(
    argv,
    cwd,
    { cols: Number.parseInt(cols, 10), rows: Number.parseInt(rows, 10) },
    meta,
    process.env
  );
}

/**
 * Tries to open and immediately close a connection to a daemon's socket to
 * confirm it is still listening. Resolves false on timeout or error.
 */
function probeSocket(socketPath: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectSessionSocket(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Decides whether a session should be marked disconnected on dashboard startup.
 * Local sessions require a live daemonPid AND a responsive socket. Remote
 * sockets are active ingest bridges: connecting to them is observable by the
 * remote side, so liveness is owned by the ingest/uplink keepalive lifecycle.
 */
export async function shouldMarkDisconnected(
  session: SessionMeta,
  probe: (socketPath: string) => Promise<boolean>
): Promise<boolean> {
  if (
    session.status !== "running" &&
    session.status !== "acknowledged" &&
    session.status !== "needs-attention" &&
    session.status !== "paused"
  ) {
    return false;
  }
  if (session.origin === "remote") {
    return false;
  }
  const pidAlive = session.daemonPid ? isProcessAlive(session.daemonPid) : false;
  const socketOk = pidAlive ? await probe(session.socketPath) : false;
  return !socketOk;
}

async function cleanupStaleSessions(): Promise<void> {
  const sessions = await listSessions();
  for (const session of sessions) {
    if (await shouldMarkDisconnected(session, probeSocket)) {
      await patchSessionMeta(session.id, {
        status: "disconnected",
        priorityReason: "disconnected",
      });
    }
  }
}

export async function stopIngestDaemon(options: {
  env?: NodeJS.ProcessEnv;
  killProcess?: (pid: number, force: boolean) => boolean;
  isProcessAlive?: (pid: number) => boolean;
  graceMs?: number;
  pollMs?: number;
} = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const kill = options.killProcess ?? killProcess;
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  const pollMs = options.pollMs ?? 50;
  let raw: string;
  try {
    raw = await readFile(getIngestPidPath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return false;
  return terminatePidWithEscalation(pid, kill, isAlive, graceMs, pollMs);
}

export function shouldStopIngestForShutdown(source: string | null): boolean {
  return source !== INGEST_DEMOTION_SHUTDOWN_SOURCE;
}

/**
 * Returns whether the singleton ingest daemon is currently running, based on
 * its pidfile.
 */
async function isIngestDaemonAlive(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const pid = Number.parseInt((await readFile(getIngestPidPath(env), "utf8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid);
  } catch {
    return false;
  }
}

/**
 * Spawns the detached singleton ingest daemon if its pidfile is absent or dead.
 * Best-effort: the daemon itself re-checks the singleton, so a redundant spawn
 * is harmless.
 */
async function ensureIngestDaemon(): Promise<void> {
  if (await isIngestDaemonAlive()) {
    const beacon = await readIngestState(process.env);
    const expectedHost = await resolveIngestBindAddress(process.env);
    if (!ingestNeedsRecycle(beacon, expectedHost)) return;
    startupLog("recycling a stale or wrong-bound ingest singleton so it re-binds and publishes");
    try {
      await stopIngestDaemon();
    } catch {
      // Best-effort: the ingest is a detached singleton.
    }
  }
  const inv = resolveIngestInvocation(process.env, process.execPath);
  const child = spawn(inv.file, inv.args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();

  // Wait for the child to acquire the singleton and write its pidfile.
  // If it silently exits (e.g. another ingest from a different worktree holds
  // the lock), warn the user rather than falsely reporting success.
  const pidPath = getIngestPidPath(process.env);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isIngestDaemonAlive()) return;
  }
  process.stderr.write(
    "climon: warning: ingest daemon did not start within 5 s. " +
    "A stale ingest process from another worktree may hold the lock. " +
    `Check ${pidPath} and kill the owning process.\n`
  );
}

export type DashboardTunnelPersistenceAction =
  | { type: "persist"; tunnelId: string; cluster?: string }
  | { type: "clear" };

export function applyDashboardTunnelPersistence(
  config: ClimonConfig,
  action: DashboardTunnelPersistenceAction
): void {
  if (action.type === "persist") {
    config.remote = {
      ...config.remote,
      dashboardTunnelId: action.tunnelId,
      dashboardTunnelCluster: action.cluster
    };
    return;
  }

  if (!config.remote) return;
  delete config.remote.dashboardTunnelId;
  delete config.remote.dashboardTunnelCluster;
}

function startupLog(message: string): void {
  serverLog(message);
  if (process.env.CLIMON_DEBUG === "1") {
    process.stderr.write(`[startup +${process.uptime().toFixed(3)}s] ${message}\n`);
  }
}

const TIE_BREAK_SETTLE_MS = 750;
const TIE_BREAK_POLL_MS = 150;

/**
 * Dual-promote settle window: after this OS declares host (server.json written),
 * watch the peer home briefly for a competing server.json. If the peer also
 * promoted, apply the deterministic tie-break — WSL stays host and force-demotes
 * the loser; Windows demotes itself by asking its OWN ingest to stand down. Both
 * sides converge on the loser's ingest demoting, so the outcome is the same
 * regardless of which re-checks first. The requests are token-free (authorized by
 * same-user filesystem write access).
 */
async function settleDualPromote(peerHome: string): Promise<void> {
  const localIsWsl = isWsl(process.env);
  const localLabel = localIsWsl ? "WSL" : "Windows";
  serverLog(`settleDualPromote: started (localIsWsl=${localIsWsl}, peerHome=${peerHome}, settle=${TIE_BREAK_SETTLE_MS}ms)`);
  const deadline = Date.now() + TIE_BREAK_SETTLE_MS;
  let peerServerPresent = false;
  while (Date.now() < deadline) {
    if (await readServerStateFromDir(peerHome)) {
      peerServerPresent = true;
      break;
    }
    await new Promise((r) => setTimeout(r, TIE_BREAK_POLL_MS));
  }
  const outcome = tieBreakOutcome({ localIsWsl, peerServerPresent });
  serverLog(`settleDualPromote: peerServerPresent=${peerServerPresent}, outcome=${outcome}`);
  if (outcome === "stay-host") {
    if (peerServerPresent) {
      // Winner: belt-and-suspenders force-demote the loser by writing a request
      // into its home; its ingest consumes it and stands down.
      startupLog("dual-promote: winning the tie; force-demoting the peer");
      serverLog(`settleDualPromote: writing shutdown request to peerHome=${peerHome}`);
      await writeShutdownRequestToDir(peerHome, { requestedBy: localLabel, ts: Date.now() });
    }
    return;
  }
  // Loser: self-demote by writing a request into our OWN home. Our ingest stops
  // this server (stopLocalServer), spawns our uplink toward the winner, and frees
  // the ingest port — exactly the peer-initiated handoff path.
  startupLog("dual-promote: losing the tie; self-demoting via the local ingest");
  serverLog(`settleDualPromote: LOSING tie-break — writing self-shutdown request to ${getClimonHome(process.env)}`);
  await writeShutdownRequestToDir(getClimonHome(process.env), { requestedBy: localLabel, ts: Date.now() });
}


export async function startServer(options: StartServerOptions = {}): Promise<void> {
  process.stdout.write("climon server starting...\n");
  startupLog("startServer invoked");
  startupLog("ensuring climon home directory");
  await ensureClimonHome();
  startupLog("loading config");
  const config = await loadConfig();
  startupLog(`config loaded (requested port ${config.server.port})`);
  if (options.port !== undefined) {
    config.server.port = options.port;
    startupLog(`port overridden from options to ${config.server.port}`);
  }
  const peerHome = ((value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined))(
    resolveConfigSetting("remote.peerHome", process.env, process.cwd())
  );
  startupLog("creating dashboard tunnel manager");
  const keepAliveSec = config.tunnelLink?.keepAlive ?? 60;
  const dashboardTunnel = createDashboardTunnelManager({
    port: config.server.port,
    keepAliveMs: keepAliveSec * 1000,
    persisted: {
      tunnelId: config.remote?.dashboardTunnelId,
      cluster: config.remote?.dashboardTunnelCluster
    },
    onPersistTunnel: async ({ tunnelId, cluster }) => {
      const latest = await loadConfig();
      applyDashboardTunnelPersistence(latest, { type: "persist", tunnelId, cluster });
      await saveConfig(latest);
    },
    onClearPersistedTunnel: async () => {
      const latest = await loadConfig();
      applyDashboardTunnelPersistence(latest, { type: "clear" });
      await saveConfig(latest);
    }
  });
  config.server.host = "127.0.0.1";
  startupLog("saving config (host pinned to 127.0.0.1)");
  await saveConfig(config);

  startupLog(`checking for an existing dashboard server on port ${config.server.port}`);
  const existing = await findExistingDashboardServer(config.server.host, config.server.port);
  if (existing) {
    startupLog(`existing dashboard server found at ${existing.url}; prompting for action`);
    const action = await handleExistingDashboardServer(existing);
    if (action === "exit") {
      startupLog("leaving existing server running; exiting startup");
      return;
    }
    startupLog("existing server handled; continuing startup");
  } else {
    startupLog("no existing dashboard server found");
  }

  // Cross-OS promote: when a peer OS is configured, displace any peer host
  // before binding. Entirely skipped (zero cost) when remote.peerHome is unset.
  if (peerHome) {
    const peerLabel = peerOsLabel(process.env);
    startupLog("peer configured; running cross-OS promote");
    const outcome = await runPromote(
      buildPromoteDeps(peerHome, process.env, peerLabel, (message) => startupLog(`promote: ${message}`))
    );
    if (outcome.kind === "aborted") {
      process.stderr.write(
        `climon: cannot take over the dashboard — ${outcome.reason}\n` +
          `Run \`climon cleanup\` on ${outcome.cleanupOn}, then start the server again.\n`
      );
      return;
    }
    // Becoming host: stop our own now-redundant uplink (our sessions are local).
    try {
      await stopUplinkDaemon();
    } catch {
      // Best-effort: no uplink running.
    }
    const summary =
      outcome.via === "graceful"
        ? `displaced the ${peerLabel} host via the filesystem handoff`
        : `found no live ${peerLabel} host — starting fresh`;
    startupLog(`promote complete: ${summary}`);
    process.stdout.write(`climon: ${summary}.\n`);
  }

  startupLog(`choosing an available port starting from ${config.server.port}`);
  const dashboardPort = await chooseAvailablePort(config.server.port, {
    canBind: (port) => canBindTcpPort(config.server.host, port)
  });
  startupLog(`selected port ${dashboardPort.port}${dashboardPort.changed ? " (changed)" : ""}`);
  if (dashboardPort.changed) {
    process.stdout.write(
      `climon server port ${config.server.port} is busy; using ${dashboardPort.port} instead.\n`
    );
    config.server.port = dashboardPort.port;
    startupLog("saving config with updated port");
    await saveConfig(config);
  }

  // Clean up stale sessions whose daemons are no longer responsive.
  startupLog("cleaning up stale sessions");
  await cleanupStaleSessions();
  if (options.enableRemotes) {
    startupLog("ensuring ingest daemon is running");
    await ensureIngestDaemon();
    startupLog("ingest daemon ready");
    // Reconcile the tunnel port mapping with the ingest's actual bound port.
    // Read ingest.json directly — we just verified the daemon is alive, so its
    // beacon is authoritative regardless of what isProcessAlive() returns for
    // cross-session signal checks on Windows.
    const beacon = await readIngestState();
    const livePort = beacon?.port ?? await resolveIngestPort();
    startupLog(`resolved ingest port: ${livePort} (source: ${beacon ? "ingest.json" : "fallback"})`);
    const reconcile = await reconcileTunnelPort(livePort);
    if (reconcile.changed) {
      startupLog(`reconciled tunnel port mapping → ${reconcile.port}${reconcile.recreated ? " (tunnel recreated)" : ""}`);
    } else {
      startupLog(`tunnel port mapping already correct (port ${reconcile.port})`);
    }
  } else {
    startupLog("remotes not enabled; skipping ingest daemon");
  }

  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();

  function broadcastSessions(payload: string): void {
    const message = encoder.encode(`event: sessions\ndata: ${payload}\n\n`);
    for (const controller of sseClients) {
      try {
        controller.enqueue(message);
      } catch {
        sseClients.delete(controller);
      }
    }
  }

  async function sessionsPayload(): Promise<string> {
    const sessions = sortSessionsByPriority(await listSessions());
    return JSON.stringify({ sessions });
  }

  interface ServerPorts {
    /** Main dashboard HTTP port this server process binds. */
    dashboard: number;
    /** Ingest daemon port, when the remote ingest listener is running. */
    ingest?: number;
  }

  /**
   * Reports every TCP port opened on behalf of this server so the state is
   * discoverable from `/health`. The dashboard port is always present; the
   * ingest port is included only when the ingest daemon is running. Kept cheap
   * (filesystem reads only) so it never slows or hangs the health probe.
   */
  async function collectServerPorts(): Promise<ServerPorts> {
    const ports: ServerPorts = { dashboard: dashboardPort.port };
    try {
      if (await isIngestDaemonAlive()) {
        ports.ingest = await resolveIngestPort();
      }
    } catch {
      // Best-effort: never let port discovery fail the health probe.
    }
    return ports;
  }

  let debounce: ReturnType<typeof setTimeout> | undefined;
  startupLog(`setting up sessions directory watcher (${getSessionsDir()})`);
  const watcher = watch(getSessionsDir(), () => {
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      void sessionsPayload().then(broadcastSessions);
    }, 150);
  });

  function isLocal(request: Request, server: Bun.Server<WsData>): boolean {
    const address = server.requestIP(request)?.address ?? "";
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  }

  function authorize(request: Request, server: Bun.Server<WsData>): boolean {
    return isLocal(request, server);
  }

  // Mutable reference assigned after Bun.serve() returns so the fetch handler
  // can invoke the graceful shutdown path (defined later in the same scope).
  let requestShutdown: ((options?: ServerShutdownOptions) => void) | undefined;

  let server: Bun.Server<WsData>;
  try {
    startupLog(`starting Bun.serve on ${config.server.host}:${dashboardPort.port}`);
    server = Bun.serve<WsData>({
    hostname: config.server.host,
    port: dashboardPort.port,
    idleTimeout: DASHBOARD_IDLE_TIMEOUT_SECONDS,
    async fetch(request, srv) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          version: VERSION,
          remotesEnabled: options.enableRemotes === true,
          ports: await collectServerPorts()
        });
      }

      // Internal graceful shutdown endpoint — loopback only, no auth token
      // needed.  Used by the ingest daemon during cross-OS demotion so the
      // server can exit 0 instead of being force-killed.
      if (url.pathname === "/__internal/shutdown" && request.method === "POST") {
        if (!isLocal(request, srv)) {
          serverLog(`/__internal/shutdown: rejected non-local request from ${srv.requestIP(request)?.address}`);
          return new Response("Forbidden", { status: 403 });
        }
        const source = url.searchParams.get("source");
        serverLog(`/__internal/shutdown: accepted from ${srv.requestIP(request)?.address}; scheduling shutdown`);
        // Defer shutdown to next tick so the HTTP response is sent before
        // closeListenerAndStreams() tears down Bun.serve.
        setImmediate(() => requestShutdown?.({
          reason: "HTTP /__internal/shutdown request",
          stopIngest: shouldStopIngestForShutdown(source)
        }));
        return new Response("ok");
      }

      const asset = await getStaticAsset(url.pathname);
      if (asset) {
        return new Response(new Uint8Array(asset.body), { headers: { "content-type": asset.contentType } });
      }

      if (!authorize(request, srv)) {
        return new Response("Forbidden", { status: 403 });
      }

      if (url.pathname === "/") {
        return new Response(renderDashboard(), { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/api/sessions" && request.method === "POST") {
        // Spawning processes is privileged: loopback only.
        if (!isLocal(request, srv)) {
          return new Response("Forbidden", { status: 403 });
        }
        // Defend against browser-mediated CSRF / DNS-rebinding: the user's own
        // browser is a loopback client, so source-IP alone is not enough.
        if (!isAllowedSpawnRequest(
          request.headers.get("content-type"),
          request.headers.get("origin"),
          request.headers.get("host")
        )) {
          return new Response("Forbidden", { status: 403 });
        }
        let payload: {
          command?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown; parentId?: unknown;
          name?: unknown; priority?: unknown; color?: unknown;
        };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        const commandStr = typeof payload.command === "string" ? payload.command.trim() : "";
        const argv = splitCommand(commandStr);
        if (argv.length === 0) {
          return new Response("Missing command", { status: 400 });
        }

        let metaInput: SpawnMetaOptions;
        try {
          metaInput = {
            name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : undefined,
            priority: payload.priority === undefined || payload.priority === null
              ? undefined
              : parsePriority(payload.priority as string | number),
            color: payload.color === undefined
              ? undefined
              : payload.color === null
                ? null
                : parseColorMode(String(payload.color))
          };
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "Invalid metadata", { status: 400 });
        }

        const parentId = typeof payload.parentId === "string" ? payload.parentId.trim() : "";
        if (parentId) {
          const parent = await readSessionMeta(parentId);
          if (!parent) {
            return new Response("Parent session not found", { status: 404 });
          }
          const cwd = resolveParentSpawnCwd(payload.cwd, parent.cwd);
          try {
            const info = await stat(cwd);
            if (!info.isDirectory()) {
              return new Response(`Working directory is not a directory: ${cwd}`, { status: 400 });
            }
          } catch {
            return new Response(`Working directory not found: ${cwd}`, { status: 400 });
          }
          try {
            const color = await resolveParentSpawnColor(metaInput.color, parent.color, cwd);
            const id = await spawnHeadlessSession(
              argv,
              cwd,
              String(parent.cols),
              String(parent.rows),
              {
                name: metaInput.name,
                priority: metaInput.priority ?? parent.priority,
                color
              }
            );
            return Response.json({ id }, { status: 201 });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return new Response(`Failed to create session: ${message}`, { status: 500 });
          }
        }
        const cwd = typeof payload.cwd === "string" && payload.cwd.trim().length > 0
          ? payload.cwd.trim()
          : process.cwd();
        try {
          const info = await stat(cwd);
          if (!info.isDirectory()) {
            return new Response(`Working directory is not a directory: ${cwd}`, { status: 400 });
          }
        } catch {
          return new Response(`Working directory not found: ${cwd}`, { status: 400 });
        }
        const cols = normalizeDimension(payload.cols, 80);
        const rows = normalizeDimension(payload.rows, 24);
        try {
          const defaults = await resolveSessionDefaults(
            { color: defaultColorFlag(metaInput.color), priority: metaInput.priority },
            process.env,
            cwd
          );
          const id = await spawnHeadlessSession(argv, cwd, cols, rows, {
            name: metaInput.name,
            priority: defaults.priority,
            color: defaults.color
          });
          return Response.json({ id }, { status: 201 });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return new Response(`Failed to create session: ${message}`, { status: 500 });
        }
      }

      // ---- Remotes API (loopback only) ----

      if (url.pathname === "/api/remote/status" && request.method === "GET") {
        if (!isLocal(request, srv)) return new Response("Forbidden", { status: 403 });
        const detect = await detectDevtunnel();
        const state = await readRemoteHostState();
        return Response.json({
          devtunnelAvailable: detect.available,
          version: detect.version,
          ingestPort: await resolveIngestPort(),
          tunnel: state ? { id: state.tunnelId } : undefined,
          canHost: state?.canHost ?? detect.available
        });
      }

      if (url.pathname === "/api/dashboard-tunnel/status" && request.method === "GET") {
        if (!isLocal(request, srv)) return new Response("Forbidden", { status: 403 });
        return Response.json(await dashboardTunnel.status());
      }

      if (url.pathname === "/api/dashboard-tunnel" && request.method === "POST") {
        if (!isLocal(request, srv)) return new Response("Forbidden", { status: 403 });
        if (!isAllowedSpawnRequest(
          request.headers.get("content-type"),
          request.headers.get("origin"),
          request.headers.get("host")
        )) {
          return new Response("Forbidden", { status: 403 });
        }
        try {
          return Response.json(await dashboardTunnel.ensure());
        } catch (error) {
          const message = error instanceof Error ? error.message : "Tunnel Link error";
          return new Response(message, { status: message === dashboardTunnelAuthMessage ? 401 : 500 });
        }
      }

      if (url.pathname === "/api/dashboard-tunnel" && request.method === "DELETE") {
        if (!isLocal(request, srv)) return new Response("Forbidden", { status: 403 });
        if (!isAllowedSpawnRequest(
          request.headers.get("content-type") ?? "application/json",
          request.headers.get("origin"),
          request.headers.get("host")
        )) {
          return new Response("Forbidden", { status: 403 });
        }
        try {
          await dashboardTunnel.close();
          return new Response(null, { status: 204 });
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "Tunnel Link error", { status: 500 });
        }
      }

      if (url.pathname === "/api/remote/tunnel" && request.method === "POST") {
        if (!isLocal(request, srv)) return new Response("Forbidden", { status: 403 });
        if (!isAllowedSpawnRequest(
          request.headers.get("content-type"),
          request.headers.get("origin"),
          request.headers.get("host")
        )) {
          return new Response("Forbidden", { status: 403 });
        }
        let body: { mode?: unknown; tunnelInput?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        const detect = await detectDevtunnel();
        const ingestPort = await resolveIngestPort();
        try {
          if (body.mode === "auto") {
            if (!detect.available) {
              return new Response("devtunnel CLI not available on this machine.", { status: 400 });
            }
            await createTunnel(ingestPort);
          } else {
            const tunnelId = parseTunnelInput(typeof body.tunnelInput === "string" ? body.tunnelInput : "");
            if (!tunnelId) return new Response("Invalid tunnel id or URL.", { status: 400 });
            await useManualTunnel(
              { tunnelId, ingestPort },
              { devtunnelAvailable: detect.available }
            );
          }
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "Tunnel error", { status: 500 });
        }
        await ensureIngestDaemon();
        // Reconcile port mapping in case the ingest bound to a different port.
        const beaconForReconcile = await readIngestState();
        const livePort = beaconForReconcile?.port ?? await resolveIngestPort();
        await reconcileTunnelPort(livePort);
        const state = await readRemoteHostState();
        return Response.json({
          devtunnelAvailable: detect.available,
          version: detect.version,
          ingestPort: livePort,
          tunnel: state ? { id: state.tunnelId } : undefined,
          canHost: state?.canHost ?? detect.available
        });
      }

      if (url.pathname === "/api/remote/tunnel" && request.method === "DELETE") {
        if (!isLocal(request, srv)) return new Response("Forbidden", { status: 403 });
        if (!isAllowedSpawnRequest(
          request.headers.get("content-type") ?? "application/json",
          request.headers.get("origin"),
          request.headers.get("host")
        )) {
          return new Response("Forbidden", { status: 403 });
        }
        await deleteTunnel();
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/api/sessions") {
        return new Response(await sessionsPayload(), { headers: { "content-type": "application/json" } });
      }

      const patchMatch = SESSION_PATH.exec(url.pathname);
      if (patchMatch && request.method === "PATCH") {
        if (!isAllowedSpawnRequest(
          request.headers.get("content-type"),
          request.headers.get("origin"),
          request.headers.get("host")
        )) {
          return new Response("Forbidden", { status: 403 });
        }
        let body: { name?: unknown; priority?: unknown; color?: unknown; status?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        const patch: {
          name?: string;
          priority?: number;
          color?: AnsiColor | null;
          status?: Extract<SessionStatus, "paused" | "running">;
          priorityReason?: "running";
          userPaused?: boolean;
          attentionMatchedAt?: undefined;
          attentionReason?: undefined;
        } = {};
        let requestedStatus: Extract<SessionStatus, "paused" | "running"> | undefined;
        try {
          if (body.name !== undefined) {
            patch.name = String(body.name);
          }
          if (body.priority !== undefined) {
            patch.priority = parsePriority(body.priority as string | number);
          }
          if (body.color !== undefined) {
            patch.color = body.color === null ? null : parseColor(String(body.color));
          }
          if (body.status !== undefined) {
            requestedStatus = parseBrowserStatusPatch(body.status);
            patch.status = requestedStatus;
            patch.priorityReason = "running";
            patch.userPaused = requestedStatus === "paused";
            if (requestedStatus === "running") {
              patch.attentionMatchedAt = undefined;
              patch.attentionReason = undefined;
            }
          }
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "Invalid metadata", { status: 400 });
        }
        let updated: SessionMeta | undefined;
        if (requestedStatus !== undefined) {
          let transitionError: unknown;
          try {
            updated = await patchSessionMetaWithCurrent(
              patchMatch[1],
              patch,
              (current) => {
                try {
                  validateBrowserStatusTransition(current.status, requestedStatus);
                } catch (error) {
                  transitionError = error;
                  throw error;
                }
              }
            );
          } catch (error) {
            if (error === transitionError) {
              return new Response(error instanceof Error ? error.message : "Invalid status transition", { status: 400 });
            }
            throw error;
          }
        } else {
          updated = await patchSessionMeta(patchMatch[1], patch);
        }
        if (!updated) {
          return new Response("Not found", { status: 404 });
        }
        broadcastSessions(await sessionsPayload());
        return Response.json(updated, { status: 200 });
      }

      const sessionMatch = SESSION_PATH.exec(url.pathname);
      if (sessionMatch && request.method === "DELETE") {
        // The optional `kill` query parameter decides whether to also stop the
        // per-session daemon. Absent/`none` is cleanup only (metadata +
        // scrollback): it deliberately does NOT signal the daemon, so any climon
        // client still attached keeps running. `graceful` SIGTERMs and rechecks;
        // if the daemon survives the grace period the session is left intact and
        // the client is told so it can confirm a `force` (SIGKILL).
        const id = sessionMatch[1];
        const mode = parseKillMode(url.searchParams.get("kill"));
        if (mode === null) {
          return new Response("Invalid kill mode", { status: 400 });
        }
        const meta = await readSessionMeta(id);
        const { stillRunning } = await applySessionKill(meta?.daemonPid, mode);
        if (stillRunning) {
          return Response.json({ stillRunning: true }, { status: 200 });
        }
        const removed = await removeSessionMeta(id);
        if (!removed) {
          return new Response("Not found", { status: 404 });
        }
        broadcastSessions(await sessionsPayload());
        return new Response(null, { status: 204 });
      }

      const scrollbackMatch = SCROLLBACK_PATH.exec(url.pathname);
      if (scrollbackMatch) {
        const data = await readScrollback(scrollbackMatch[1]);
        if (!data) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(exactArrayBuffer(sanitizeBrowserTerminalReplay(data)), {
          headers: { "content-type": "application/octet-stream" }
        });
      }

      if (url.pathname === "/api/events") {
        let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controllerRef = controller;
            sseClients.add(controller);
            void sessionsPayload().then((payload) => {
              try {
                controller.enqueue(encoder.encode(`event: sessions\ndata: ${payload}\n\n`));
              } catch {
                sseClients.delete(controller);
              }
            });
          },
          cancel() {
            if (controllerRef) {
              sseClients.delete(controllerRef);
            }
          }
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive"
          }
        });
      }

      const attachMatch = ATTACH_PATH.exec(url.pathname);
      if (attachMatch) {
        const meta = await readSessionMeta(attachMatch[1]);
        if (!meta) {
          return new Response("Not found", { status: 404 });
        }
        const upgraded = srv.upgrade(request, {
          data: { sessionId: meta.id, socketPath: meta.socketPath } satisfies WsData
        });
        if (upgraded) {
          return undefined;
        }
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        const daemon: Socket = connectSessionSocket(ws.data.socketPath);
        const decoder = new FrameDecoder();
        (ws.data as WsData & { daemon?: Socket }).daemon = daemon;

        daemon.on("data", (chunk) => {
          for (const frame of decoder.push(chunk)) {
            if (frame.type === FrameType.Output) {
              ws.sendBinary(frame.payload);
            } else if (frame.type === FrameType.Replay) {
              const replay = sanitizeBrowserTerminalReplay(frame.payload);
              ws.send(JSON.stringify({ type: "replay" }));
              ws.sendBinary(replay);
            } else if (frame.type === FrameType.Exit) {
              const exit = parseJsonPayload<ExitPayload>(frame.payload);
              ws.send(JSON.stringify({ type: "exit", exitCode: exit.exitCode }));
            } else if (frame.type === FrameType.PtySize) {
              const size = parseJsonPayload<PtySizePayload>(frame.payload);
              ws.send(JSON.stringify({ type: "size", cols: size.cols, rows: size.rows }));
            } else if (frame.type === FrameType.TerminalMode) {
              const mode = parseJsonPayload<TerminalModePayload>(frame.payload);
              ws.send(JSON.stringify({ type: "mode", mode: mode.mode }));
            }
          }
        });
        daemon.on("error", () => ws.close());
        daemon.on("close", () => ws.close());
      },
      message(ws: ServerWebSocket<WsData>, raw) {
        const daemon = (ws.data as WsData & { daemon?: Socket }).daemon;
        if (!daemon) {
          return;
        }
        if (typeof raw !== "string") {
          return;
        }
        try {
          const message = JSON.parse(raw) as {
            type: string;
            data?: string;
            cols?: number;
            rows?: number;
            mode?: TerminalResizeMode;
            needsAttention?: boolean;
            attentionMatchedAt?: string;
          };
          if (message.type === "input" && typeof message.data === "string") {
            daemon.write(encodeFrame(FrameType.Input, Buffer.from(message.data, "utf8")));
          } else if (message.type === "resize" && message.cols && message.rows) {
            const payload = browserResizePayload(message);
            if (payload) {
              daemon.write(encodeJsonFrame(FrameType.Resize, payload));
            }
          } else if (message.type === "mode" && (message.mode === "clamped" || message.mode === "fill")) {
            daemon.write(encodeJsonFrame(FrameType.TerminalMode, { mode: message.mode }));
          } else if (message.type === "attention") {
            const payload = browserAttentionPayload(message);
            if (payload) {
              daemon.write(encodeJsonFrame(FrameType.Attention, payload));
            }
          } else if (message.type === "replay") {
            daemon.write(encodeFrame(FrameType.Replay));
          }
        } catch {
          // Ignore malformed messages.
        }
      },
      close(ws: ServerWebSocket<WsData>) {
        const daemon = (ws.data as WsData & { daemon?: Socket }).daemon;
        daemon?.destroy();
      }
    }
    });
  } catch (error) {
    if (isAddressInUse(error)) {
      throw new Error(
        `No available dashboard port found from ${config.server.port} to ${config.server.port + PORT_RETRY_ATTEMPTS - 1}.`
      );
    }
    throw describeListenError(error, config.server.host, config.server.port);
  }

  startupLog("Bun.serve started; writing server state file");
  const recordedPorts = await collectServerPorts();
  const serverState: ServerState = { pid: process.pid, port: dashboardPort.port };
  if (recordedPorts.ingest !== undefined) serverState.ingest = recordedPorts.ingest;
  const serverStatePath = getServerStatePath();
  serverLog(`writing server.json: path=${serverStatePath}, content=${JSON.stringify(serverState)}`);
  await atomicWrite(serverStatePath, serializeServerState(serverState));
  serverLog(`server.json written successfully`);
  startupLog("state file written; advertising URL");
  printStartup(config, dashboardPort.port);

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    // Closes the HTTP listener, SSE streams, watcher, and dashboard tunnel.
    // Does NOT remove server.json (callers decide) and does NOT touch the ingest.
    const closeListenerAndStreams = async (): Promise<void> => {
      watcher.close();
      if (debounce) {
        clearTimeout(debounce);
        debounce = undefined;
      }
      for (const controller of sseClients) {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
      sseClients.clear();
      try {
        await server.stop(true);
      } catch {
        // Listener already stopped.
      }
      try {
        await dashboardTunnel.close();
      } catch {
        // No tunnel running or already closed.
      }
    };
    // Plain shutdown (SIGINT/SIGTERM/internal HTTP): close the co-located ingest
    // too. The one exception is an ingest-initiated demotion request; that daemon
    // is already running its own graceful exit path after it stops this server.
    const plainShutdown = (reason?: string, options: { stopIngest?: boolean } = {}): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      const why = reason ?? "signal received";
      const shouldStopIngest = options.stopIngest ?? true;
      serverLog(`plainShutdown triggered (pid=${process.pid}, reason=${why}); removing ${getServerStatePath()}`);
      startupLog("plain shutdown requested; releasing resources");
      process.stdout.write(`climon server shutting down (${why}).\n`);
      // Remove server.json synchronously so it is guaranteed to be cleaned up
      // even if the process is force-killed shortly after Ctrl+C on Windows.
      try { rmSync(getServerStatePath(), { force: true }); } catch { /* best-effort */ }
      void (async () => {
        await closeListenerAndStreams();
        if (shouldStopIngest) {
          try {
            const stopped = await stopIngestDaemon();
            serverLog(`plainShutdown: stopIngestDaemon returned ${stopped}`);
          } catch (error) {
            serverLog(`plainShutdown: stopIngestDaemon failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          serverLog("plainShutdown: leaving ingest shutdown to its demotion path");
        }
        serverLog("plainShutdown: shutdown complete");
        startupLog("plain shutdown complete");
        resolve();
        // Ensure the process exits even if stale handles keep the event loop alive.
        process.exit(0);
      })();
    };
    process.on("SIGINT", () => plainShutdown("SIGINT"));
    process.on("SIGTERM", () => plainShutdown("SIGTERM"));
    requestShutdown = (options?: ServerShutdownOptions) =>
      plainShutdown(options?.reason ?? "HTTP /__internal/shutdown request", { stopIngest: options?.stopIngest });
    // When a peer is configured but no ingest daemon is running, the server
    // itself must watch for shutdown-request.json. Without this, a peer that
    // wins the dual-promote tie-break writes a request that nobody consumes.
    if (peerHome && !options.enableRemotes) {
      const shutdownWatcher = createShutdownRequestWatcher({
        dir: getClimonHome(),
        onValid: (req) => {
          serverLog(`shutdown-request watcher: received valid request from ${req.requestedBy}; invoking shutdown`);
          shutdownWatcher.stop();
          plainShutdown(`peer ${req.requestedBy} won the dual-promote tie-break`);
        }
      });
      // Ensure the watcher is cleaned up on any shutdown path.
      const origRequestShutdown = requestShutdown;
      requestShutdown = (options?: ServerShutdownOptions) => { shutdownWatcher.stop(); origRequestShutdown?.(options); };
      serverLog("shutdown-request watcher started (no ingest, peer configured)");
    }
    // Run the dual-promote settle window concurrently with serving, AFTER the
    // shutdown handlers are registered: if this OS loses the tie, its own ingest
    // SIGTERMs this server, so plainShutdown must already be installed to remove
    // server.json cleanly. Running it concurrently (not awaited before serving)
    // also keeps the settle window off every peer startup's critical path.
    if (peerHome) void settleDualPromote(peerHome);
  });
}

function printStartup(config: ClimonConfig, port: number): void {
  void config;
  process.stdout.write(`climon server v${VERSION} listening on http://127.0.0.1:${port}/\n`);
}

/**
 * Turns a low-level listen failure into an actionable message. Binding to a
 * privileged port (<1024) without elevated permissions is the common case.
 */
export function describeListenError(error: unknown, host: string, port: number): Error {
  const message = error instanceof Error ? error.message : String(error);
  const denied = /permission denied|EACCES/i.test(message);
  if (denied && port < 1024) {
    return new Error(
      `permission denied binding ${host}:${port}. Ports below 1024 require elevated privileges. ` +
        `Run climon with a higher port (e.g. --port 3131), or grant the capability with ` +
        `\`sudo setcap 'cap_net_bind_service=+ep' $(which bun)\`, or run as root.`
    );
  }
  if (/address already in use|EADDRINUSE/i.test(message)) {
    return new Error(`${host}:${port} is already in use. Choose another port with --port N.`);
  }
  return error instanceof Error ? error : new Error(message);
}
