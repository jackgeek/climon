import { existsSync, watch } from "node:fs";
import { type Socket } from "node:net";
import { spawn } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  ensureClimonHome,
  getClimonHome,
  getSessionsDir,
  loadConfig,
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
import { listSessions, patchSessionMeta, patchSessionMetaWithCurrent, readScrollback, readSessionMeta, removeSessionMeta } from "../store.js";
import type { AnsiColor, ClimonConfig, SessionColorMode, SessionMeta, SessionStatus } from "../types.js";
import { getIngestPidPath, DEFAULT_INGEST_PORT, readRemoteHostState } from "../remote/ingest.js";
import { detectDevtunnel, createTunnel, deleteTunnel, parseTunnelInput, useManualTunnel } from "../remote/tunnel.js";
import { connectSessionSocket } from "../session-socket.js";
import { sanitizeBrowserTerminalReplay } from "../terminal-replay.js";
import { VERSION } from "../version.js";
import { getStaticAsset, renderDashboard } from "./assets.js";
import { createDashboardTunnelManager, dashboardTunnelAuthMessage } from "./dashboard-tunnel.js";
import { resolveClientInvocation } from "../cli/client-exec.js";
import { resolveServerInvocation } from "../cli/server-exec.js";
import { resolveSessionDefaults } from "../launcher.js";
import { parseColor, parseColorMode, parsePriority } from "../session-meta.js";
import { isProcessAlive, killProcess } from "../process-kill.js";
import { canBindTcpPort, chooseAvailablePort, isAddressInUse, PORT_RETRY_ATTEMPTS } from "../port-choice.js";

interface StartServerOptions {
  port?: number;
  enableRemotes?: boolean;
}

interface WsData {
  sessionId: string;
  socketPath: string;
}

export const DASHBOARD_IDLE_TIMEOUT_SECONDS = 255;

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

export function getServerPidPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), "server.pid");
}

function dashboardUrl(host: string, port: number): string {
  return `http://${host}:${port}/`;
}

async function readLivePid(
  path: string,
  isAlive: (pid: number) => boolean = isProcessAlive
): Promise<number | undefined> {
  try {
    const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
  let healthy = false;
  try {
    const res = await fetchFn(`${url}health`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    if (res.ok) {
      const body = (await res.json()) as { ok?: unknown };
      healthy = body.ok === true;
    }
  } catch {
    healthy = false;
  }
  if (!healthy) return undefined;

  const pid = await readLivePid(getServerPidPath(options.env), options.isProcessAliveFn);
  return pid === undefined ? { url } : { url, pid };
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
  const pid = await readLivePid(getServerPidPath(env), isAlive);
  if (pid === undefined) return false;
  if (!kill(pid, false)) return false;
  const waitForExit = async (): Promise<boolean> => {
    const deadline = Date.now() + graceMs;
    for (;;) {
      if (!isAlive(pid)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };
  if (await waitForExit()) return true;
  if (!kill(pid, true)) return false;
  return waitForExit();
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
  } = {}
): Promise<ServerConflictAction> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const stopServer =
    options.stopServer ??
    (async () => {
      return await stopDashboardServer();
    });

  if (!stdinIsTTY) {
    write(`climon server is already running at ${existing.url}\n`);
    return "exit";
  }

  const ask = options.ask ?? askExistingServerTermination;
  const answer = (await ask(`climon server is already running at ${existing.url}. Terminate it? [y/N] `))
    .trim()
    .toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    write(`Existing server left running at ${existing.url}\n`);
    return "exit";
  }
  if (existing.pid === undefined) {
    write(`Unable to determine the existing server process id. Existing server is at ${existing.url}\n`);
    return "exit";
  }
  if (!(await stopServer(existing.pid))) {
    write(`Unable to terminate the existing server. Existing server is at ${existing.url}\n`);
    return "exit";
  }
  write("Existing climon server terminated. Starting a new server...\n");
  return "continue";
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

function resolveDevClientEntrypoint(): string | undefined {
  if (!import.meta.url.startsWith("file:")) {
    return undefined;
  }
  try {
    const candidate = fileURLToPath(new URL("../index.ts", import.meta.url));
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
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

/**
 * Spawns `climon run --headless <argv>` using this process's own runtime and
 * entry script (the same mechanism the per-session daemon uses), captures the
 * session id it prints to stdout, and resolves with that id. Rejects on
 * non-zero exit, spawn error, or timeout.
 */
function spawnHeadlessSession(
  argv: string[],
  cwd: string,
  cols: string,
  rows: string,
  meta: ResolvedSpawnMetaOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { file, args } = resolveClientInvocation(
      buildRunArgs(argv, meta),
      process.env,
      process.execPath,
      resolveDevClientEntrypoint()
    );
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, CLIMON_COLS: cols, CLIMON_ROWS: rows },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out creating session"));
    }, 15000);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("climon client binary not found; set CLIMON_CLIENT_BIN to its path"));
        return;
      }
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const id = stdout.trim().split(/\s+/).pop() ?? "";
      if (code === 0 && id) {
        resolve(id);
      } else {
        reject(new Error(stderr.trim() || `climon run exited with code ${code ?? "unknown"}`));
      }
    });
  });
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
 * sessions have no per-session daemonPid (their socket is owned by the ingest
 * daemon), so they are judged purely by probing the socket directly.
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
    return !(await probe(session.socketPath));
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
  if (!kill(pid, false)) return false;
  const waitForExit = async (): Promise<boolean> => {
    const deadline = Date.now() + graceMs;
    for (;;) {
      if (!isAlive(pid)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };
  if (await waitForExit()) return true;
  if (!kill(pid, true)) return false;
  return waitForExit();
}

/**
 * Spawns the detached singleton ingest daemon if its pidfile is absent or dead.
 * Best-effort: the daemon itself re-checks the singleton, so a redundant spawn
 * is harmless.
 */
async function ensureIngestDaemon(): Promise<void> {
  const pidPath = getIngestPidPath();
  let alive = false;
  try {
    const pid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
    alive = Number.isInteger(pid) && pid > 0 && isProcessAlive(pid);
  } catch {
    alive = false;
  }
  if (alive) return;
  const inv = resolveIngestInvocation(process.env, process.execPath);
  const child = spawn(inv.file, inv.args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
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
  process.stderr.write(`[startup +${process.uptime().toFixed(3)}s] ${message}\n`);
}

export async function startServer(options: StartServerOptions = {}): Promise<void> {
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
  startupLog("creating dashboard tunnel manager");
  const dashboardTunnel = createDashboardTunnelManager({
    port: config.server.port,
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
  startupLog("ensuring ingest daemon is running");
  await ensureIngestDaemon();
  startupLog("ingest daemon ready");

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
        return Response.json({ ok: true, version: VERSION, remotesEnabled: options.enableRemotes === true });
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
          ingestPort: state?.ingestPort ?? DEFAULT_INGEST_PORT,
          tunnel: state ? { id: state.tunnelId, tokenExpiresAt: state.tokenExpiresAt } : undefined,
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
        let body: { mode?: unknown; tunnelInput?: unknown; connectToken?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        const detect = await detectDevtunnel();
        const ingestPort = (await readRemoteHostState())?.ingestPort ?? DEFAULT_INGEST_PORT;
        try {
          if (body.mode === "auto") {
            if (!detect.available) {
              return new Response("devtunnel CLI not available on this machine.", { status: 400 });
            }
            await createTunnel(ingestPort);
          } else {
            const tunnelId = parseTunnelInput(typeof body.tunnelInput === "string" ? body.tunnelInput : "");
            const token = typeof body.connectToken === "string" ? body.connectToken : "";
            if (!tunnelId) return new Response("Invalid tunnel id or URL.", { status: 400 });
            await useManualTunnel(
              { tunnelId, connectToken: token, ingestPort },
              { devtunnelAvailable: detect.available }
            );
          }
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "Tunnel error", { status: 500 });
        }
        await ensureIngestDaemon();
        const state = await readRemoteHostState();
        return Response.json({
          devtunnelAvailable: detect.available,
          version: detect.version,
          ingestPort: state?.ingestPort ?? DEFAULT_INGEST_PORT,
          tunnel: state ? { id: state.tunnelId, tokenExpiresAt: state.tokenExpiresAt } : undefined,
          // Returned ONLY from this mutating endpoint (loopback-only) so the
          // dialog can fold the secret into the generated script. The GET status
          // endpoint never returns the token.
          connectToken: state?.connectToken,
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
              ws.sendBinary(sanitizeBrowserTerminalReplay(frame.payload));
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
          }
        } catch {
          // Ignore malformed messages.
        }
      },
      close(ws: ServerWebSocket<WsData>) {
        const daemon = (ws.data as WsData & { daemon?: Socket }).daemon;
        daemon?.end();
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

  startupLog("Bun.serve started; writing server pid file");
  await writeFile(getServerPidPath(), `${process.pid}\n`, { mode: 0o600 });
  startupLog("pid file written; advertising URL");
  printStartup(config, dashboardPort.port);

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      watcher.close();
      server.stop();
      void rm(getServerPidPath(), { force: true })
        .then(() => stopIngestDaemon())
        .finally(resolve);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
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
