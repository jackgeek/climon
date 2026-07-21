import { existsSync, rmSync, watch } from "node:fs";
import { type Socket } from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  type ControlPayload,
  type ExitPayload,
  type PtySizePayload,
  type ResizePayload,
  type SurfaceKind
} from "../ipc/frame.js";
import { sortSessionsByPriority } from "../priority.js";
import { atomicWrite, listSessions, patchSessionMeta, patchSessionMetaWithCurrent, patchSessionMetaFromCurrent, readScrollback, readSessionMeta, removeSessionMeta } from "../store.js";
import type { AnsiColor, ClimonConfig, SessionColorMode, SessionMeta, SessionMetaPatch, SessionStatus } from "../types.js";
import { getIngestPidPath, ingestNeedsRecycle, namespacedId, readRemoteHostState, resolveIngestBindAddress } from "../remote/ingest.js";
import type { SpawnControlRequest, SpawnControlResponse } from "../remote/ingest.js";
import { readIngestState, resolveIngestPort } from "../remote/ingest-state.js";
import { ensureSpawnSecret } from "../remote/spawn-secret.js";
import { requestRemoteSpawn } from "./remote-spawn-client.js";
import { isWsl, peerOsLabel } from "../remote/peer.js";
import { stopUplinkDaemon } from "../remote/teardown.js";
import { ensureIngestTunnel, deleteTunnel, parseTunnelInput, useManualTunnel, reconcileTunnelPort } from "../remote/tunnel.js";
import { connectSessionSocket } from "../session-socket.js";
import { sanitizeBrowserTerminalReplay } from "../terminal-replay.js";
import { VERSION } from "../version.js";
import { getStaticAsset, renderDashboard } from "./assets.js";
import { createDashboardTunnelManager } from "./dashboard-tunnel.js";
import { createDevtunnelGateway } from "../devtunnel/gateway.js";
import { DevtunnelError, type DevtunnelFailure, type DevtunnelHealth } from "../devtunnel/types.js";
import { runPromote } from "./promote.js";
import { collectDashboardPreferences, persistDashboardPreference } from "./dashboard-preferences.js";
import { buildPromoteDeps } from "./promote-probes.js";
import { resolveClientInvocation } from "../cli/client-exec.js";
import { resolveSessionDefaults } from "../session-defaults.js";
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
import { dualPromoteSettleDecision } from "./tie-break.js";
import { getLogger } from "../logging/logger.js";
import { logMsg } from "../i18n/log-msg.js";
import { createPushService, type PushService } from "./push/service.js";
import { isValidSubscription } from "./push/subscriptions.js";
import { isFeatureEnabled, resolveFeatureFlags } from "../features.js";


interface StartServerOptions {
  port?: number;
  /**
   * When true, never terminate or prompt to terminate an existing dashboard
   * server. Skips the existing-server check entirely and binds the next
   * available port instead. Used by tests so the suite cannot take down a
   * developer's running dashboard.
   */
  noTakeover?: boolean;
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
const LIVE_SESSION_STATUSES = new Set<SessionStatus>([
  "running",
  "acknowledged",
  "needs-attention",
  "paused"
]);

/** Whether the shared ingest daemon should run: either remote scenario enabled. */
export function computeRemotesActive(config: ClimonConfig): boolean {
  return isFeatureEnabled(config, "wslBridge") || isFeatureEnabled(config, "remotes");
}

// Bound the health probe so a process that holds the port but never answers
// HTTP (a stuck previous server or an unrelated listener) cannot hang start-up.
export const HEALTH_PROBE_TIMEOUT_MS = 2000;

const ATTACH_PATH = /^\/api\/sessions\/([^/]+)\/attach$/;
const SCROLLBACK_PATH = /^\/api\/sessions\/([^/]+)\/scrollback$/;
const SESSION_PATH = /^\/api\/sessions\/([^/]+)$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
/** Host suffix of Microsoft dev tunnels; the only non-loopback host the dashboard is served on. */
const DEV_TUNNEL_HOST_SUFFIX = ".devtunnels.ms";

function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  const unbracketed = normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  return LOOPBACK_HOSTS.has(unbracketed) || unbracketed === "::ffff:127.0.0.1";
}

export function buildInterimWslExposureWarning(input: {
  remotesActive: boolean;
  wslBridgeEnabled: boolean;
  ingestBindHost: string;
}): string | undefined {
  if (!input.remotesActive || input.wslBridgeEnabled || isLoopbackBindHost(input.ingestBindHost)) {
    return undefined;
  }
  return "climon: ingest is listening on the vEthernet (WSL) interface while the WSL bridge is disabled; the transport guard (gate #3) ships with the ingest cutover — same-machine WSL processes can reach this port until then.";
}

export function shouldWatchPeerShutdown(peerHome: string | undefined, remotesActive: boolean): boolean {
  return Boolean(peerHome) && !remotesActive;
}

/**
 * Whether a request's `Host` header targets a loopback hostname. The source IP
 * alone cannot distinguish truly-local traffic from dashboard requests arriving
 * over the dev tunnel: `devtunnel host` forwards tunnelled traffic from the local
 * connector, so those requests still present a 127.0.0.1 peer address. A browser
 * loading the dashboard over the tunnel sends its tunnel `Host` (e.g.
 * `<id>.devtunnels.ms`), so requiring a loopback `Host` keeps internal `/health`
 * fields off the tunnel-facing surface.
 */
export function isLoopbackHostHeader(host: string | null): boolean {
  return host !== null && LOOPBACK_HOSTS.has(hostHeaderHostname(host));
}

export interface HealthServerPorts {
  /** Main dashboard HTTP port this server process binds. */
  dashboard: number;
  /** Ingest daemon port, when the remote ingest listener is running. */
  ingest?: number;
}

export function buildHealthPayload(input: {
  config: ClimonConfig;
  remotesActive: boolean;
  isLocalRequest: boolean;
  ports: HealthServerPorts;
}): Record<string, unknown> {
  return {
    ok: true,
    version: VERSION,
    remotesEnabled: input.remotesActive,
    ...(input.isLocalRequest ? { features: resolveFeatureFlags(input.config) } : {}),
    shortcuts: { focusTopSession: input.config.hotKeys?.focusTopSession ?? "Alt+J" },
    preferences: collectDashboardPreferences(input.config),
    ports: input.ports
  };
}

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
  logMsg(getLogger(), "debug", "server.find_existing_dashboard_probe", { url });
  let healthy = false;
  try {
    const res = await fetchFn(`${url}health`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    if (res.ok) {
      const body = (await res.json()) as { ok?: unknown };
      healthy = body.ok === true;
    }
    logMsg(getLogger(), "debug", "server.find_existing_health_response", { ok: res.ok, healthy });
  } catch (err) {
    logMsg(getLogger(), "debug", "server.find_existing_health_probe_failed", { error: err instanceof Error ? err.message : String(err) });
    healthy = false;
  }
  if (!healthy) {
    logMsg(getLogger(), "debug", "server.find_existing_not_healthy", {});
    return undefined;
  }

  const pid = await readLiveServerPid(options.env, options.isProcessAliveFn);
  logMsg(getLogger(), "debug", "server.find_existing_healthy_server_found", { pid: pid ?? "unknown" });
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
  stopIngest?: (options?: Parameters<typeof stopIngestDaemon>[0]) => Promise<boolean>;
} = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const kill = options.killProcess ?? killProcess;
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  const pollMs = options.pollMs ?? 50;
  const pid = await readLiveServerPid(env, isAlive);
  logMsg(getLogger(), "debug", "server.stop_dashboard_read_live_pid", { pid: pid ?? "undefined" });
  let result = false;
  if (pid !== undefined) {
    result = await terminatePidWithEscalation(pid, kill, isAlive, graceMs, pollMs);
    logMsg(getLogger(), "debug", "server.stop_dashboard_terminate_pid_result", { pid, result });
  }
  // The ingest daemon's lifecycle is owned by the dashboard server: stopping the
  // server must also stop its co-located ingest so it is never orphaned. The
  // signal/HTTP plainShutdown path already does this; doing it here covers the
  // PID-based termination path (restart/takeover via handleExistingDashboardServer)
  // where the server is force-killed and its own signal handler never runs.
  const stopIngest = options.stopIngest ?? stopIngestDaemon;
  try {
    const ingestStopped = await stopIngest({ env, killProcess: kill, isProcessAlive: isAlive, graceMs, pollMs });
    logMsg(getLogger(), "debug", "server.stop_dashboard_ingest_stop_result", { ingestStopped });
  } catch (error) {
    logMsg(getLogger(), "debug", "server.stop_dashboard_ingest_stop_failed", { error: error instanceof Error ? error.message : String(error) });
  }
  return result;
}

/**
 * Requests graceful shutdown via the server's internal HTTP endpoint.
 * Used when the PID is unknown (e.g. server running in WSL, server.json
 * deleted) but the server is reachable on localhost.
 */
async function requestServerShutdownViaHttp(url: string): Promise<boolean> {
  const shutdownUrl = `${url.replace(/\/?$/, "")}/__internal/shutdown`;
  logMsg(getLogger(), "debug", "server.request_shutdown_http_posting", { shutdownUrl });
  try {
    const res = await fetch(shutdownUrl, {
      method: "POST",
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      logMsg(getLogger(), "error", "server.request_shutdown_http_status_failure", { status: res.status });
      return false;
    }
    logMsg(getLogger(), "debug", "server.request_shutdown_http_polling", {});
  } catch (err) {
    logMsg(getLogger(), "error", "server.request_shutdown_http_post_failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
  // Wait for the server to actually stop responding.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const probe = await fetch(`${url}health`, { signal: AbortSignal.timeout(500) });
      if (!probe.ok) {
        logMsg(getLogger(), "debug", "server.request_shutdown_health_non_ok", {});
        return true;
      }
    } catch {
      logMsg(getLogger(), "debug", "server.request_shutdown_health_threw", {});
      return true;
    }
  }
  logMsg(getLogger(), "error", "server.request_shutdown_timeout", {});
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

  logMsg(getLogger(), "debug", "server.handle_existing_dashboard_state", { existing: JSON.stringify(existing), tty: stdinIsTTY });

  if (!stdinIsTTY) {
    write(`climon server is already running at ${existing.url}\n`);
    logMsg(getLogger(), "debug", "server.handle_existing_non_interactive_exit", {});
    return "exit";
  }

  const ask = options.ask ?? askExistingServerTermination;
  const answer = (await ask(`climon server is already running at ${existing.url}. Terminate it? [y/N] `))
    .trim()
    .toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    write(`Existing server left running at ${existing.url}\n`);
    logMsg(getLogger(), "debug", "server.handle_existing_user_declined", { answer: JSON.stringify(answer) });
    return "exit";
  }

  logMsg(getLogger(), "debug", "server.handle_existing_user_confirmed", {});

  if (existing.pid !== undefined) {
    logMsg(getLogger(), "debug", "server.handle_existing_pid_stop_attempt", { pid: existing.pid });
    if (await stopServer(existing.pid)) {
      logMsg(getLogger(), "debug", "server.handle_existing_pid_stop_succeeded", {});
      write("Existing climon server terminated. Starting a new server...\n");
      return "continue";
    }
    logMsg(getLogger(), "error", "server.handle_existing_pid_stop_failed", {});
  }

  // PID unknown or kill failed — request graceful shutdown via HTTP.
  logMsg(getLogger(), "debug", "server.handle_existing_http_shutdown_attempt", { url: existing.url });
  if (await requestHttpShutdown(existing.url)) {
    logMsg(getLogger(), "debug", "server.handle_existing_http_shutdown_succeeded", {});
    write("Existing climon server terminated. Starting a new server...\n");
    return "continue";
  }

  logMsg(getLogger(), "error", "server.handle_existing_termination_failed", {});
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

/**
 * Authorizes a push subscription request that must be reachable OVER the dev
 * tunnel (the phone is not a loopback origin). Requires a JSON content-type and
 * that the request is same-origin: the Origin header's host (including port)
 * equals the Host header. Unlike isAllowedSpawnRequest this does not require a
 * loopback host, so it works for the tunnel origin while still blocking
 * cross-origin CSRF.
 */
export function isSameOriginRequest(
  contentType: string | null,
  origin: string | null,
  host: string | null
): boolean {
  if (!contentType || !contentType.toLowerCase().includes("application/json")) {
    return false;
  }
  if (origin === null || host === null) {
    return false;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  return originHost === host.trim().toLowerCase();
}

/**
 * Allowlists the `Host` the dashboard may legitimately be reached on: loopback
 * (direct/tunnel-relay) or the dev-tunnel domain. Rejecting everything else
 * defeats DNS-rebinding, where a page on `evil.com` rebinds to `127.0.0.1` and
 * sends `Host: evil.com`.
 */
export function isAllowedDashboardHost(host: string | null): boolean {
  if (host === null) return false;
  const hostname = hostHeaderHostname(host);
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  return hostname.endsWith(DEV_TUNNEL_HOST_SUFFIX);
}

/**
 * Authorizes a WebSocket attach upgrade. Browsers do NOT apply same-origin
 * policy when opening a WebSocket, so the server must check the Origin itself.
 * Requires: an Origin is present, it is same-origin with Host (blocks
 * cross-site WebSocket hijacking), and Host is an allowed dashboard host
 * (blocks DNS-rebinding). The handshake carries no JSON content-type, so this
 * cannot reuse isAllowedSpawnRequest.
 */
export function isAllowedAttachUpgrade(origin: string | null, host: string | null): boolean {
  if (!isAllowedDashboardHost(host)) return false;
  return isSameOriginRequest("application/json", origin, host);
}

export function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter((part) => part.length > 0);
}

export function browserResizePayload(message: {
  cols?: number;
  rows?: number;
  kind?: SurfaceKind;
  viewerId?: string;
}): ResizePayload | null {
  if (!message.cols || !message.rows) {
    return null;
  }
  const payload: ResizePayload = { cols: message.cols, rows: message.rows };
  if (message.kind === "terminal" || message.kind === "dashboard" || message.kind === "pwa") {
    payload.kind = message.kind;
  }
  if (typeof message.viewerId === "string") {
    payload.viewerId = message.viewerId;
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
  theme?: string;
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
  if (meta.theme !== undefined && meta.theme !== "") {
    flags.push("--theme", meta.theme);
  }
  return ["run", "--headless", ...flags, ...command];
}

export interface SpawnArgsInput {
  headless: boolean;
  cwd: string;
  cols: number;
  rows: number;
  meta: SpawnMetaOptions;
}

/**
 * Builds the `__spawn` argv passed to the canonical climon client binary. The
 * client creates the session on THIS machine (headless background session, or a
 * visible GUI terminal window). Flag order mirrors {@link buildRunArgs}.
 */
export function buildSpawnArgs(command: string[], input: SpawnArgsInput): string[] {
  const args: string[] = ["__spawn"];
  if (input.headless) {
    args.push("--headless");
  }
  args.push("--cwd", input.cwd, "--cols", String(input.cols), "--rows", String(input.rows));
  if (typeof input.meta.priority === "number") {
    args.push("--priority", String(input.meta.priority));
  }
  if (input.meta.color !== undefined) {
    args.push("--color", input.meta.color ?? "none");
  }
  if (input.meta.name !== undefined && input.meta.name !== "") {
    args.push("--name", input.meta.name);
  }
  if (input.meta.theme !== undefined && input.meta.theme !== "") {
    args.push("--theme", input.meta.theme);
  }
  return [...args, ...command];
}

export interface RemoteSpawnInput {
  argv: string[];
  cwd: string;
  headless: boolean;
  name?: string;
  theme?: string;
  priority?: number;
  color?: string;
}

export interface RouteResult {
  status: number;
  body: Record<string, unknown> | undefined;
}

/** Maps a remote parent + spawn input to a Response shape via the ingest. */
export async function routeRemoteSpawn(
  parent: { id: string; cols: number; rows: number },
  input: RemoteSpawnInput,
  send: (req: SpawnControlRequest) => Promise<SpawnControlResponse> = requestRemoteSpawn
): Promise<RouteResult> {
  const clientId = parent.id.slice(0, parent.id.indexOf("~"));
  const requestId = randomUUID();
  const res = await send({
    type: "spawn",
    requestId,
    clientId,
    command: input.argv,
    cwd: input.cwd,
    cols: parent.cols,
    rows: parent.rows,
    name: input.name,
    theme: input.theme,
    priority: input.priority,
    color: input.color,
    headless: input.headless
  });
  if (res.error === "timeout") return { status: 202, body: undefined };
  if (res.error) return { status: 502, body: { error: res.error } };
  if (res.id) {
    const body: Record<string, unknown> = { id: namespacedId(clientId, res.id) };
    if (res.warning) body.warning = res.warning;
    return { status: 201, body };
  }
  // No id (e.g. a visible spawn): the session appears via session-added.
  return { status: 202, body: res.warning ? { warning: res.warning } : undefined };
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

export function resolveIngestInvocation(
  env: NodeJS.ProcessEnv,
  execPath: string
): { file: string; args: string[] } {
  const inv = resolveClientInvocation(["__ingest"], env, execPath);
  if (inv.file !== "climon") {
    // CLIMON_CLIENT_BIN override or a sibling binary next to the server exe.
    return inv;
  }
  const devBinary = resolveDevClientBinary();
  if (devBinary) {
    return { file: devBinary, args: ["__ingest"] };
  }
  if (import.meta.url.startsWith("file:")) {
    // Dev checkout with no built binary: require it; never fall back to the Bun ingest.
    throw new Error(
      "climon: the Rust client binary is not built; the ingest cannot start. " +
        "Build it with `cargo build` in rust/ (or set CLIMON_CLIENT_BIN)."
    );
  }
  // Production with a bare `climon` on PATH (mirrors resolveSpawnInvocation):
  // still the Rust client `__ingest`, never the Bun ingest.
  return inv;
}

/**
 * Resolves the built Rust climon binary in a dev checkout (debug or release),
 * relative to this source file. Returns undefined outside a `file:` dev run or
 * when no binary has been built. In production the sibling `climon` binary next
 * to the server executable is used instead (via resolveClientInvocation).
 */
function resolveDevClientBinary(): string | undefined {
  if (!import.meta.url.startsWith("file:")) {
    return undefined;
  }
  const exe = process.platform === "win32" ? ".exe" : "";
  for (const profile of ["debug", "release"]) {
    try {
      const candidate = fileURLToPath(
        new URL(`../../rust/target/${profile}/climon${exe}`, import.meta.url)
      );
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore and try the next profile
    }
  }
  return undefined;
}

/**
 * Resolves how to invoke the climon client to spawn a session: an explicit
 * CLIMON_CLIENT_BIN override or sibling binary first, then (in a dev checkout)
 * the built Rust binary, then a bare `climon` on PATH.
 */
export function resolveSpawnInvocation(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath
): { file: string; args: string[] } {
  const inv = resolveClientInvocation(args, env, execPath);
  if (inv.file !== "climon") {
    // An override or a sibling binary was found.
    return inv;
  }
  const devBinary = resolveDevClientBinary();
  if (devBinary) {
    return { file: devBinary, args };
  }
  return inv;
}

interface SpawnOutcome {
  id?: string;
  warning?: string;
}

/**
 * Spawns the climon client with `args` in `cwd` and parses its single-line JSON
 * outcome (`{}` | `{"id":..}` | `{"id":..,"warning":..}`). Failures to launch or
 * parse yield an empty outcome so the caller maps it to a 202 (the session may
 * still appear via the normal sessions watch).
 */
async function runClimonSpawn(args: string[], cwd: string): Promise<SpawnOutcome> {
  const inv = resolveSpawnInvocation(args);
  const proc = Bun.spawn([inv.file, ...inv.args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
  try {
    return JSON.parse(line) as SpawnOutcome;
  } catch {
    return {};
  }
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
  if (!LIVE_SESSION_STATUSES.has(session.status)) {
    return false;
  }
  if (session.origin === "remote") {
    return false;
  }
  const pidAlive = session.daemonPid ? isProcessAlive(session.daemonPid) : false;
  const socketOk = pidAlive ? await probe(session.socketPath) : false;
  return !socketOk;
}

function isLiveLocalSession(session: SessionMeta): boolean {
  // Older local metadata may omit origin; only the explicit remote marker is excluded.
  return session.origin !== "remote" && LIVE_SESSION_STATUSES.has(session.status);
}

interface LiveLocalDisconnectDeps {
  readSession: (id: string) => Promise<SessionMeta | undefined>;
  probe: (socketPath: string) => Promise<boolean>;
  patchFromCurrent: (
    id: string,
    updateCurrent: (current: SessionMeta) => SessionMetaPatch | undefined
  ) => Promise<SessionMeta | undefined>;
}

const liveLocalDisconnectDeps: LiveLocalDisconnectDeps = {
  readSession: readSessionMeta,
  probe: probeSocket,
  patchFromCurrent: patchSessionMetaFromCurrent
};

export async function reconcileLiveLocalDaemonDisconnect(
  sessionId: string,
  deps: LiveLocalDisconnectDeps = liveLocalDisconnectDeps
): Promise<void> {
  const observed = await deps.readSession(sessionId);
  if (!observed || !isLiveLocalSession(observed)) {
    return;
  }
  if (await deps.probe(observed.socketPath)) {
    return;
  }
  await deps.patchFromCurrent(sessionId, (current) => {
    if (!isLiveLocalSession(current) || current.socketPath !== observed.socketPath) {
      return undefined;
    }
    return {
      status: "disconnected",
      priorityReason: "disconnected"
    };
  });
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
    if (!ingestNeedsRecycle(beacon, expectedHost)) {
      logMsg(getLogger(), "debug", "server.ingest_daemon_already_running", { pid: beacon?.pid ?? "?", port: beacon?.port ?? "?" });
      return;
    }
    logMsg(getLogger(), "debug", "server.ingest_daemon_recycling_stale", {});
    startupLog("recycling a stale or wrong-bound ingest singleton so it re-binds and publishes");
    try {
      await stopIngestDaemon();
    } catch {
      // Best-effort: the ingest is a detached singleton.
    }
  }
  logMsg(getLogger(), "debug", "server.ingest_daemon_starting", {});
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
    if (await isIngestDaemonAlive()) {
      const beacon = await readIngestState(process.env);
      logMsg(getLogger(), "debug", "server.ingest_daemon_ready", { pid: beacon?.pid ?? child.pid ?? "?", port: beacon?.port ?? "?" });
      return;
    }
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

/**
 * Records whether the Tunnel Link is enabled so the server re-establishes the
 * dashboard tunnel on its next startup. Mutates the passed config in place.
 */
export function applyDashboardTunnelEnabled(config: ClimonConfig, enabled: boolean): void {
  config.remote = { ...config.remote, dashboardTunnelEnabled: enabled };
}

/** Loads, updates, and persists the dashboard-tunnel enabled flag. Best-effort. */
async function persistDashboardTunnelEnabled(enabled: boolean): Promise<void> {
  try {
    const latest = await loadConfig();
    applyDashboardTunnelEnabled(latest, enabled);
    await saveConfig(latest);
  } catch (error) {
    logMsg(getLogger(), "debug", "server.persist_dashboard_tunnel_enabled_failed", { enabled, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Maps a {@link DevtunnelError} to an HTTP response carrying the structured
 * failure so the dashboard can render remediation and drive an explicit retry.
 * Non-DevtunnelError values fall back to a generic 500.
 */
function devtunnelErrorResponse(error: unknown): Response {
  if (!(error instanceof DevtunnelError)) {
    return Response.json({ error: { code: "unknown", summary: "Tunnel Link error" } }, { status: 500 });
  }
  const status = error.failure.code === "not_authenticated" ? 401
    : error.failure.code === "cli_missing" ? 503
    : error.failure.code === "permission_denied" ? 403
    : error.failure.code === "tunnel_quota_exhausted" ? 409
    : error.failure.retryClass === "transient" ? 503
    : 500;
  return Response.json({ error: error.failure }, { status });
}

/**
 * Structured failure for an unavailable devtunnel CLI. Reuses the health probe's
 * classified failure when present (e.g. a spawn error), otherwise synthesizes a
 * `cli_missing` failure so callers always receive actionable guidance instead of
 * an opaque string (covers the env-disabled path, which carries no lastFailure).
 */
function unavailableDevtunnelFailure(health: DevtunnelHealth): DevtunnelFailure {
  if (health.lastFailure) return health.lastFailure;
  return {
    code: "cli_missing",
    operation: "detect",
    summary: "Microsoft Dev Tunnels is not installed or is unavailable on this machine.",
    remediation: "Install the devtunnel CLI, then retry.",
    technicalDetail: "devtunnel CLI not available",
    occurredAt: new Date().toISOString(),
    retryClass: "actionable",
    retryable: false
  };
}

function startupLog(message: string): void {
  logMsg(getLogger(), "debug", "server.startup_log_detail", { detail: message });
}

/**
 * Awaits a promise but gives up after `ms`, so a single teardown step can never
 * block shutdown indefinitely. Resolves either way; a timeout is logged.
 */
async function withTimeout(label: string, promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logMsg(getLogger(), "debug", "server.shutdown_step_timeout", { label, ms });
      resolve();
    }, ms);
  });
  try {
    await Promise.race([Promise.resolve(promise).then(() => undefined, () => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const SHUTDOWN_HARD_TIMEOUT_MS = 10000;
const LISTENER_CLOSE_TIMEOUT_MS = 3000;
const TUNNEL_CLOSE_TIMEOUT_MS = 3000;

const TIE_BREAK_SETTLE_MS = 750;
const TIE_BREAK_POLL_MS = 150;

/**
 * Dual-promote settle window: after this OS declares host (server.json written),
 * watch the peer home briefly for a competing server.json. If the peer also
 * promoted, the most-recently-started server wins — it force-demotes the loser by
 * writing a (token-free, same-user-filesystem-authorized) shutdown-request into
 * the loser's home, whose ingest (or no-ingest shutdown watcher) consumes it and
 * stands down. This makes a deliberately-started newcomer take over an existing
 * host regardless of OS, even when the peer is unreachable over TCP (e.g. WSL2
 * NAT loopback isolation) so the cross-OS handoff could not complete directly.
 * An exact start-time tie, or a peer whose server.json predates the `startedAt`
 * field, falls back to the deterministic OS tie-break (WSL stays host). Both
 * sides compare the same two timestamps, so the outcome converges no matter which
 * re-checks first.
 */
async function settleDualPromote(peerHome: string, localStartedAt: number): Promise<void> {
  const localIsWsl = isWsl(process.env);
  const localLabel = localIsWsl ? "WSL" : "Windows";
  logMsg(getLogger(), "debug", "server.settle_dual_promote_started", {
    localIsWsl,
    localStartedAt,
    peerHome,
    settleMs: TIE_BREAK_SETTLE_MS
  });
  const deadline = Date.now() + TIE_BREAK_SETTLE_MS;
  let peerState: ServerState | undefined;
  while (Date.now() < deadline) {
    peerState = await readServerStateFromDir(peerHome);
    if (peerState) break;
    await new Promise((r) => setTimeout(r, TIE_BREAK_POLL_MS));
  }
  if (!peerState) {
    logMsg(getLogger(), "debug", "server.settle_dual_promote_no_peer", {});
    return;
  }

  const peerStartedAt = peerState.startedAt;
  const decision = dualPromoteSettleDecision({ localIsWsl, localStartedAt, peerStartedAt });
  const basis =
    typeof peerStartedAt === "number" && peerStartedAt !== localStartedAt
      ? `start-time (${localStartedAt} vs peer ${peerStartedAt})`
      : peerStartedAt === undefined
        ? "deterministic (peer has no startedAt)"
        : "deterministic (start-time tie)";
  logMsg(getLogger(), "debug", "server.settle_dual_promote_peer_decision", { decision, basis });

  if (decision === "win") {
    // Winner: force-demote the loser by writing a request into its home; its
    // ingest (or no-ingest shutdown watcher) consumes it and stands down.
    startupLog(`dual-promote: winning by ${basis}; force-demoting the peer`);
    logMsg(getLogger(), "debug", "server.settle_dual_promote_write_peer_shutdown", { peerHome });
    await writeShutdownRequestToDir(peerHome, { requestedBy: localLabel, ts: Date.now() });
    return;
  }
  // Loser: self-demote by writing a request into our OWN home. Our ingest stops
  // this server (stopLocalServer), spawns our uplink toward the winner, and frees
  // the ingest port — exactly the peer-initiated handoff path.
  startupLog(`dual-promote: losing by ${basis}; self-demoting via the local ingest`);
  logMsg(getLogger(), "debug", "server.settle_dual_promote_write_self_shutdown", { climonHome: getClimonHome(process.env) });
  await writeShutdownRequestToDir(getClimonHome(process.env), { requestedBy: localLabel, ts: Date.now() });
}


export async function startServer(options: StartServerOptions = {}): Promise<void> {
  logMsg(getLogger(), "info", "server.climon_server_starting", {});
  startupLog("startServer invoked");
  startupLog("ensuring climon home directory");
  await ensureClimonHome();
  startupLog("loading config");
  const config = await loadConfig();
  const remotesActive = computeRemotesActive(config);
  const wslBridgeEnabled = isFeatureEnabled(config, "wslBridge");
  startupLog(`config loaded (requested port ${config.server.port})`);
  if (options.port !== undefined) {
    config.server.port = options.port;
    startupLog(`port overridden from options to ${config.server.port}`);
  }
  const peerHome = ((value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined))(
    resolveConfigSetting("remote.peerHome", process.env, process.cwd())
  );
  config.server.host = "127.0.0.1";
  startupLog("saving config (host pinned to 127.0.0.1)");
  await saveConfig(config);

  startupLog(`checking for an existing dashboard server on port ${config.server.port}`);
  if (options.noTakeover) {
    startupLog("--no-takeover set; skipping existing-server check (will bind the next free port)");
  } else {
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
  }

  // Cross-OS promote: when a peer OS is configured, displace any peer host
  // before binding. Entirely skipped (zero cost) when remote.peerHome is unset.
  if (peerHome && wslBridgeEnabled) {
    const peerLabel = peerOsLabel(process.env);
    startupLog("peer configured and WSL bridge enabled; running cross-OS promote");
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

  // One shared gateway drives ingest tunnel setup and remote status health so
  // detect/create/port operations reuse a single devtunnel wiring. (The Dashboard
  // Tunnel Link manager keeps building its own gateway: its `spawnHost` routes
  // `devtunnel host` output through construction-time process handlers, which a
  // pre-built shared instance cannot carry — see dashboard-tunnel.ts.)
  const devtunnel = createDevtunnelGateway();
  // The most recent ingest tunnel failure (startup or explicit retry), surfaced
  // in /api/remote/status so the dashboard can render remediation + retry.
  let lastIngestFailure: DevtunnelFailure | undefined;
  async function currentDevtunnelHealth(): Promise<DevtunnelHealth> {
    const detected = await devtunnel.detect();
    return lastIngestFailure && !detected.lastFailure
      ? { ...detected, lastFailure: lastIngestFailure }
      : detected;
  }

  // Created only after the port is finalized so the tunnel maps and hosts the
  // port this server actually bound. Creating it earlier (with the requested
  // port) means a restart that shifts to the next free port — common during a
  // takeover while the old listener is still releasing the socket — would
  // forward the restored tunnel to a dead port, so the link never comes back.
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

  // Clean up stale sessions whose daemons are no longer responsive.
  startupLog("cleaning up stale sessions");
  await cleanupStaleSessions();
  if (remotesActive) {
    if ((await devtunnel.detect()).available) {
      try {
        const ingestPort = await resolveIngestPort();
        const ensured = await ensureIngestTunnel(ingestPort, { gateway: devtunnel });
        lastIngestFailure = undefined;
        startupLog(`ensured ingest tunnel ${ensured.tunnelId} (port ${ensured.ingestPort})`);
      } catch (error) {
        if (error instanceof DevtunnelError) lastIngestFailure = error.failure;
        startupLog(`ingest tunnel ensure failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      startupLog("devtunnel unavailable; skipping ingest tunnel ensure");
    }
    // A failure to bootstrap the ingest daemon (e.g. a dev checkout with no
    // built Rust client binary, or a stale singleton from another worktree)
    // must never take down the dashboard: bring the HTTP server up regardless
    // so local sessions and /health stay available, and just warn.
    try {
      startupLog("ensuring ingest daemon is running");
      await ensureIngestDaemon();
      const exposureWarning = buildInterimWslExposureWarning({
        remotesActive,
        wslBridgeEnabled,
        ingestBindHost: await resolveIngestBindAddress(process.env)
      });
      if (exposureWarning) {
        process.stderr.write(`${exposureWarning}\n`);
      }
      startupLog("ingest daemon ready");
      // Reconcile the tunnel port mapping with the ingest's actual bound port.
      // Read ingest.json directly — we just verified the daemon is alive, so its
      // beacon is authoritative regardless of what isProcessAlive() returns for
      // cross-session signal checks on Windows.
      const beacon = await readIngestState();
      const livePort = beacon?.port ?? await resolveIngestPort();
      startupLog(`resolved ingest port: ${livePort} (source: ${beacon ? "ingest.json" : "fallback"})`);
      const reconcile = await reconcileTunnelPort(livePort, { gateway: devtunnel });
      if (reconcile.failure) {
        lastIngestFailure = reconcile.failure;
        startupLog(`tunnel port reconcile failed: ${reconcile.failure.code}`);
      } else if (reconcile.changed) {
        startupLog(`reconciled tunnel port mapping → ${reconcile.port}${reconcile.recreated ? " (tunnel recreated)" : ""}`);
      } else {
        startupLog(`tunnel port mapping already correct (port ${reconcile.port})`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      startupLog(`ingest daemon bootstrap failed: ${detail}`);
      logMsg(getLogger(), "warn", "server.ingest_daemon_bootstrap_failed", { error: detail });
      process.stderr.write(`climon: warning: remote ingest could not start: ${detail}\n`);
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

  let pushService: PushService | undefined;

  async function publishSessions(): Promise<void> {
    const sessions = sortSessionsByPriority(await listSessions());
    broadcastSessions(JSON.stringify({ sessions }));
    if (pushService) {
      try {
        await pushService.notifyAttention(sessions);
      } catch (error) {
        logMsg(getLogger(), "error", "server.push_notify_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /**
   * Reports every TCP port opened on behalf of this server so the state is
   * discoverable from `/health`. The dashboard port is always present; the
   * ingest port is included only when the ingest daemon is running. Kept cheap
   * (filesystem reads only) so it never slows or hangs the health probe.
   */
  async function collectServerPorts(): Promise<HealthServerPorts> {
    const ports: HealthServerPorts = { dashboard: dashboardPort.port };
    try {
      if (await isIngestDaemonAlive()) {
        ports.ingest = await resolveIngestPort();
      }
    } catch {
      // Best-effort: never let port discovery fail the health probe.
    }
    return ports;
  }

  try {
    pushService = await createPushService(getClimonHome(process.env));
    // Seed the attention tracker with the current sessions so the first real
    // watcher-driven transition into needs-attention is detected (not consumed
    // as the seed).
    await pushService.notifyAttention(sortSessionsByPriority(await listSessions()));
    startupLog("push service ready");
  } catch (error) {
    logMsg(getLogger(), "error", "server.push_service_unavailable", { error: error instanceof Error ? error.message : String(error) });
  }

  let debounce: ReturnType<typeof setTimeout> | undefined;
  startupLog(`setting up sessions directory watcher (${getSessionsDir()})`);
  const watcher = watch(getSessionsDir(), () => {
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      void publishSessions();
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
        return Response.json(buildHealthPayload({
          config,
          remotesActive,
          isLocalRequest: isLocal(request, srv) && isLoopbackHostHeader(request.headers.get("host")),
          ports: await collectServerPorts()
        }));
      }

      // Internal graceful shutdown endpoint — loopback only, no auth token
      // needed.  Used by the ingest daemon during cross-OS demotion so the
      // server can exit 0 instead of being force-killed.
      if (url.pathname === "/__internal/shutdown" && request.method === "POST") {
        if (!isLocal(request, srv)) {
          logMsg(getLogger(), "warn", "server.internal_shutdown_rejected_non_local", { address: srv.requestIP(request)?.address });
          return new Response("Forbidden", { status: 403 });
        }
        const source = url.searchParams.get("source");
        logMsg(getLogger(), "debug", "server.internal_shutdown_accepted", { address: srv.requestIP(request)?.address });
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
        const headers: Record<string, string> = { "content-type": asset.contentType };
        if (asset.cacheControl) {
          headers["cache-control"] = asset.cacheControl;
        }
        return new Response(new Uint8Array(asset.body), { headers });
      }

      if (!authorize(request, srv)) {
        return new Response("Forbidden", { status: 403 });
      }

      if (url.pathname === "/") {
        return new Response(renderDashboard(), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }
        });
      }

      if (url.pathname === "/api/sessions" && request.method === "POST") {
        if (!isFeatureEnabled(config, "sessionSpawning")) {
          return new Response("Session spawning is disabled", { status: 403 });
        }
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
          name?: unknown; priority?: unknown; color?: unknown; headless?: unknown; theme?: unknown;
        };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        // The dashboard "+" defaults to a visible terminal window (headless
        // false); the caller opts into a background session with headless: true.
        const headless = payload.headless === true;
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
                : parseColorMode(String(payload.color)),
            theme: typeof payload.theme === "string" && payload.theme.trim() ? payload.theme.trim() : undefined
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
          // A remote parent lives on a devbox: route the spawn over the signed
          // ingest control socket instead of spawning on the server machine.
          if (parent.origin === "remote") {
            if (!isFeatureEnabled(config, "remoteSpawn")) {
              return new Response("Remote spawn is disabled", { status: 403 });
            }
            await ensureSpawnSecret(process.env);
            const route = await routeRemoteSpawn(
              { id: parent.id, cols: parent.cols, rows: parent.rows },
              {
                argv,
                cwd,
                headless,
                name: metaInput.name,
                theme: metaInput.theme,
                priority: metaInput.priority ?? parent.priority,
                color: metaInput.color === null ? "none" : metaInput.color ?? undefined
              }
            );
            return route.body
              ? Response.json(route.body, { status: route.status })
              : new Response(null, { status: route.status });
          }
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
            const outcome = await runClimonSpawn(
              buildSpawnArgs(argv, {
                headless,
                cwd,
                cols: parent.cols,
                rows: parent.rows,
                meta: {
                  name: metaInput.name,
                  priority: metaInput.priority ?? parent.priority,
                  color,
                  theme: metaInput.theme
                }
              }),
              cwd
            );
            if (outcome.id) {
              return Response.json({ id: outcome.id, warning: outcome.warning }, { status: 201 });
            }
            return Response.json({ warning: outcome.warning }, { status: 202 });
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
          const outcome = await runClimonSpawn(
            buildSpawnArgs(argv, {
              headless,
              cwd,
              cols: Number.parseInt(cols, 10),
              rows: Number.parseInt(rows, 10),
              meta: {
                name: metaInput.name,
                priority: defaults.priority,
                color: defaults.color,
                theme: metaInput.theme
              }
            }),
            cwd
          );
          if (outcome.id) {
            return Response.json({ id: outcome.id, warning: outcome.warning }, { status: 201 });
          }
          return Response.json({ warning: outcome.warning }, { status: 202 });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return new Response(`Failed to create session: ${message}`, { status: 500 });
        }
      }

      // ---- Remotes API (loopback only) ----

      if (url.pathname === "/api/remote/status" && request.method === "GET") {
        if (!isLocal(request, srv)) return new Response("Forbidden", { status: 403 });
        const health = await currentDevtunnelHealth();
        const state = await readRemoteHostState();
        const remoteSpawn = isFeatureEnabled(config, "remoteSpawn");
        const spawnSecret = remoteSpawn ? await ensureSpawnSecret(process.env) : undefined;
        return Response.json({
          devtunnelAvailable: health.available,
          version: health.version,
          devtunnel: health,
          ingestPort: await resolveIngestPort(),
          tunnel: state ? { id: state.tunnelId } : undefined,
          canHost: state?.canHost ?? health.available,
          remoteSpawn,
          spawnSecret
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
          const info = await dashboardTunnel.ensure();
          await persistDashboardTunnelEnabled(true);
          return Response.json(info);
        } catch (error) {
          return devtunnelErrorResponse(error);
        }
      }

      if (url.pathname === "/api/dashboard-tunnel/retry" && request.method === "POST") {
        if (!isLocal(request, srv)) return new Response("Forbidden", { status: 403 });
        if (!isAllowedSpawnRequest(
          request.headers.get("content-type"),
          request.headers.get("origin"),
          request.headers.get("host")
        )) {
          return new Response("Forbidden", { status: 403 });
        }
        try {
          const info = await dashboardTunnel.retry();
          await persistDashboardTunnelEnabled(true);
          return Response.json(info);
        } catch (error) {
          return devtunnelErrorResponse(error);
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
          await persistDashboardTunnelEnabled(false);
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
        const health = await currentDevtunnelHealth();
        const ingestPort = await resolveIngestPort();
        try {
          if (body.mode === "auto") {
            if (!health.available) {
              return devtunnelErrorResponse(new DevtunnelError(unavailableDevtunnelFailure(health)));
            }
            await ensureIngestTunnel(ingestPort, { gateway: devtunnel });
            lastIngestFailure = undefined;
          } else {
            const tunnelId = parseTunnelInput(typeof body.tunnelInput === "string" ? body.tunnelInput : "");
            if (!tunnelId) return new Response("Invalid tunnel id or URL.", { status: 400 });
            await useManualTunnel(
              { tunnelId, ingestPort },
              { devtunnelAvailable: health.available }
            );
            lastIngestFailure = undefined;
          }
        } catch (error) {
          if (error instanceof DevtunnelError) lastIngestFailure = error.failure;
          return devtunnelErrorResponse(error);
        }
        await ensureIngestDaemon();
        // Reconcile port mapping in case the ingest bound to a different port.
        const beaconForReconcile = await readIngestState();
        const livePort = beaconForReconcile?.port ?? await resolveIngestPort();
        const reconciled = await reconcileTunnelPort(livePort, { gateway: devtunnel });
        if (reconciled.failure) lastIngestFailure = reconciled.failure;
        const state = await readRemoteHostState();
        const refreshed = await currentDevtunnelHealth();
        return Response.json({
          devtunnelAvailable: refreshed.available,
          version: refreshed.version,
          devtunnel: refreshed,
          ingestPort: livePort,
          tunnel: state ? { id: state.tunnelId } : undefined,
          canHost: state?.canHost ?? refreshed.available
        });
      }

      if (url.pathname === "/api/remote/tunnel/retry" && request.method === "POST") {
        if (!isLocal(request, srv)) return new Response("Forbidden", { status: 403 });
        if (!isAllowedSpawnRequest(
          request.headers.get("content-type"),
          request.headers.get("origin"),
          request.headers.get("host")
        )) {
          return new Response("Forbidden", { status: 403 });
        }
        const ingestPort = await resolveIngestPort();
        try {
          await ensureIngestTunnel(ingestPort, { gateway: devtunnel });
          lastIngestFailure = undefined;
        } catch (error) {
          if (error instanceof DevtunnelError) lastIngestFailure = error.failure;
          return devtunnelErrorResponse(error);
        }
        // Only start/reconcile ingest once the tunnel setup has succeeded.
        await ensureIngestDaemon();
        const beacon = await readIngestState();
        const livePort = beacon?.port ?? await resolveIngestPort();
        const reconciled = await reconcileTunnelPort(livePort, { gateway: devtunnel });
        if (reconciled.failure) lastIngestFailure = reconciled.failure;
        const state = await readRemoteHostState();
        const refreshed = await currentDevtunnelHealth();
        return Response.json({
          devtunnelAvailable: refreshed.available,
          version: refreshed.version,
          devtunnel: refreshed,
          ingestPort: livePort,
          tunnel: state ? { id: state.tunnelId } : undefined,
          canHost: state?.canHost ?? refreshed.available
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

      if (url.pathname === "/api/push/vapid-public-key") {
        if (!pushService) {
          return new Response("Push unavailable", { status: 503 });
        }
        return Response.json({ key: pushService.getVapidPublicKey() });
      }

      if (url.pathname === "/api/push/subscribe" && request.method === "POST") {
        if (!pushService) {
          return new Response("Push unavailable", { status: 503 });
        }
        if (!isSameOriginRequest(
          request.headers.get("content-type"),
          request.headers.get("origin"),
          request.headers.get("host")
        )) {
          return new Response("Forbidden", { status: 403 });
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        if (!isValidSubscription(body)) {
          return new Response("Invalid subscription", { status: 400 });
        }
        await pushService.subscribe(body);
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/api/push/unsubscribe" && request.method === "POST") {
        if (!pushService) {
          return new Response("Push unavailable", { status: 503 });
        }
        if (!isSameOriginRequest(
          request.headers.get("content-type"),
          request.headers.get("origin"),
          request.headers.get("host")
        )) {
          return new Response("Forbidden", { status: 403 });
        }
        let body: { endpoint?: unknown };
        try {
          body = (await request.json()) as { endpoint?: unknown };
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        if (typeof body.endpoint !== "string" || body.endpoint.length === 0) {
          return new Response("Invalid endpoint", { status: 400 });
        }
        await pushService.unsubscribe(body.endpoint);
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/api/push/presence" && request.method === "POST") {
        if (!pushService) {
          return new Response("Push unavailable", { status: 503 });
        }
        if (!isSameOriginRequest(
          request.headers.get("content-type"),
          request.headers.get("origin"),
          request.headers.get("host")
        )) {
          return new Response("Forbidden", { status: 403 });
        }
        let body: { endpoint?: unknown; foreground?: unknown };
        try {
          body = (await request.json()) as { endpoint?: unknown; foreground?: unknown };
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        if (typeof body.endpoint !== "string" || body.endpoint.length === 0) {
          return new Response("Invalid endpoint", { status: 400 });
        }
        if (typeof body.foreground !== "boolean") {
          return new Response("Invalid foreground", { status: 400 });
        }
        pushService.recordPresence(body.endpoint, body.foreground);
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/api/dashboard/preferences" && request.method === "POST") {
        // Same-origin guard: reachable over the tunnel (remote viewers may change
        // cosmetic prefs) while blocking cross-origin CSRF / DNS-rebinding.
        if (!isSameOriginRequest(
          request.headers.get("content-type"),
          request.headers.get("origin"),
          request.headers.get("host")
        )) {
          return new Response("Forbidden", { status: 403 });
        }
        let body: { key?: unknown; value?: unknown };
        try {
          body = (await request.json()) as { key?: unknown; value?: unknown };
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
        if (typeof body.key !== "string") {
          return new Response("Missing key", { status: 400 });
        }
        const { result, config: latest } = await persistDashboardPreference(
          body.key,
          body.value,
          loadConfig,
          saveConfig
        );
        if (!result.ok) {
          return new Response(result.error, { status: result.status });
        }
        // Keep the in-memory config the server serves on /health in sync.
        Object.assign(config, latest);
        return Response.json({ ok: true, key: body.key, value: body.value });
      }

      if (url.pathname === "/api/sessions") {
        if (!isAllowedDashboardHost(request.headers.get("host"))) {
          return new Response("Forbidden", { status: 403 });
        }
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
        let body: { name?: unknown; priority?: unknown; color?: unknown; status?: unknown; theme?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        const patch: {
          name?: string;
          priority?: number;
          color?: AnsiColor | null;
          theme?: string;
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
          if (body.theme !== undefined) {
            const t = body.theme === null ? "" : String(body.theme);
            patch.theme = t.trim() === "" ? undefined : t;
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
        await publishSessions();
        return Response.json(updated, { status: 200 });
      }

      const sessionMatch = SESSION_PATH.exec(url.pathname);
      if (sessionMatch && request.method === "DELETE") {
        if (!isAllowedDashboardHost(request.headers.get("host"))) {
          return new Response("Forbidden", { status: 403 });
        }
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
        await publishSessions();
        return new Response(null, { status: 204 });
      }

      const scrollbackMatch = SCROLLBACK_PATH.exec(url.pathname);
      if (scrollbackMatch) {
        if (!isAllowedDashboardHost(request.headers.get("host"))) {
          return new Response("Forbidden", { status: 403 });
        }
        const data = await readScrollback(scrollbackMatch[1]);
        if (!data) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(exactArrayBuffer(sanitizeBrowserTerminalReplay(data)), {
          headers: { "content-type": "application/octet-stream" }
        });
      }

      if (url.pathname === "/api/events") {
        if (!isAllowedDashboardHost(request.headers.get("host"))) {
          return new Response("Forbidden", { status: 403 });
        }
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
        if (!isAllowedAttachUpgrade(request.headers.get("origin"), request.headers.get("host"))) {
          return new Response("Forbidden", { status: 403 });
        }
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

        daemon.on("data", (chunk: Buffer) => {
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
            } else if (frame.type === FrameType.Control) {
              const ctrl = parseJsonPayload<ControlPayload>(frame.payload);
              ws.send(JSON.stringify({ type: "control", controllerId: ctrl.controllerId, cols: ctrl.cols, rows: ctrl.rows }));
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
            kind?: SurfaceKind;
            viewerId?: string;
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
          } else if (message.type === "takeControl") {
            daemon.write(encodeFrame(FrameType.TakeControl));
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
  const localStartedAt = Date.now();
  const serverState: ServerState = { pid: process.pid, port: dashboardPort.port, startedAt: localStartedAt };
  if (recordedPorts.ingest !== undefined) serverState.ingest = recordedPorts.ingest;
  const serverStatePath = getServerStatePath();
  logMsg(getLogger(), "debug", "server.server_state_writing", { path: serverStatePath, content: JSON.stringify(serverState) });
  await atomicWrite(serverStatePath, serializeServerState(serverState));
  logMsg(getLogger(), "debug", "server.server_state_written", {});
  startupLog("state file written; advertising URL");
  printStartup(config, dashboardPort.port);

  // Re-establish a previously-enabled Tunnel Link. The dashboard tunnel manager
  // reuses the persisted tunnel identity, so the public URL is stable across
  // restarts. Best-effort and non-blocking: a failure (e.g. devtunnel missing or
  // unauthenticated) must not prevent the server from serving.
  if (config.remote?.dashboardTunnelEnabled) {
    startupLog("re-establishing previously enabled Tunnel Link");
    void dashboardTunnel.ensure().then(
      (info) => {
        startupLog(`Tunnel Link re-established at ${info.url}`);
        logMsg(getLogger(), "info", "server.tunnel_link_reestablished", { url: info.url });
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        logMsg(getLogger(), "warn", "server.tunnel_link_reestablish_failed", { message });
        process.stderr.write(`climon: could not re-establish the Tunnel Link: ${message}\n`);
      }
    );
  }

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
      // Bound each close so a stuck listener or tunnel host (seen on Windows)
      // can never block shutdown indefinitely.
      await withTimeout("dashboard listener close", Promise.resolve(server.stop(true)), LISTENER_CLOSE_TIMEOUT_MS);
      await withTimeout("Tunnel Link close", dashboardTunnel.close(), TUNNEL_CLOSE_TIMEOUT_MS);
    };
    // Plain shutdown (SIGINT/SIGTERM/internal HTTP): close the co-located ingest
    // too. The one exception is an ingest-initiated demotion request; that daemon
    // is already running its own graceful exit path after it stops this server.
    const plainShutdown = (reason?: string, options: { stopIngest?: boolean } = {}): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      const why = reason ?? "signal received";
      const shouldStopIngest = options.stopIngest ?? true;
      logMsg(getLogger(), "debug", "server.plain_shutdown_triggered", { pid: process.pid, reason: why, path: getServerStatePath() });
      startupLog("plain shutdown requested; releasing resources");
      logMsg(getLogger(), "info", "server.climon_server_shutting_down", { reason: why });
      // Remove server.json synchronously so it is guaranteed to be cleaned up
      // even if the process is force-killed shortly after Ctrl+C on Windows.
      try { rmSync(getServerStatePath(), { force: true }); } catch { /* best-effort */ }
      // Hard watchdog: guarantee the process exits even if a teardown step hangs.
      const forceExit = setTimeout(() => {
        process.stdout.write("climon: shutdown is taking too long; forcing exit.\n");
        logMsg(getLogger(), "debug", "server.plain_shutdown_hard_watchdog", {});
        process.exit(0);
      }, SHUTDOWN_HARD_TIMEOUT_MS);
      forceExit.unref?.();
      void (async () => {
        logMsg(getLogger(), "debug", "server.closing_dashboard_listener_streams", {});
        await closeListenerAndStreams();
        if (shouldStopIngest) {
          try {
            const stopped = await stopIngestDaemon();
            logMsg(getLogger(), "debug", "server.plain_shutdown_ingest_stop_result", { stopped });
          } catch (error) {
            logMsg(getLogger(), "error", "server.plain_shutdown_ingest_stop_failed", { error: error instanceof Error ? error.message : String(error) });
          }
        } else {
          logMsg(getLogger(), "debug", "server.plain_shutdown_leave_ingest_demote", {});
        }
        logMsg(getLogger(), "debug", "server.plain_shutdown_complete", {});
        startupLog("plain shutdown complete");
        clearTimeout(forceExit);
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
    if (shouldWatchPeerShutdown(peerHome, remotesActive)) {
      const shutdownWatcher = createShutdownRequestWatcher({
        dir: getClimonHome(),
        onValid: (req) => {
          logMsg(getLogger(), "debug", "server.shutdown_request_watcher_valid_request", { requestedBy: req.requestedBy });
          shutdownWatcher.stop();
          plainShutdown(`peer ${req.requestedBy} won the dual-promote tie-break`);
        }
      });
      // Ensure the watcher is cleaned up on any shutdown path.
      const origRequestShutdown = requestShutdown;
      requestShutdown = (options?: ServerShutdownOptions) => { shutdownWatcher.stop(); origRequestShutdown?.(options); };
      logMsg(getLogger(), "debug", "server.shutdown_request_watcher_started", {});
    }
    // Run the dual-promote settle window concurrently with serving, AFTER the
    // shutdown handlers are registered: if this OS loses the tie, its own ingest
    // SIGTERMs this server, so plainShutdown must already be installed to remove
    // server.json cleanly. Running it concurrently (not awaited before serving)
    // also keeps the settle window off every peer startup's critical path.
    if (peerHome && wslBridgeEnabled) void settleDualPromote(peerHome, localStartedAt);
  });
}

function printStartup(config: ClimonConfig, port: number): void {
  void config;
  logMsg(getLogger(), "info", "server.climon_server_listening", { version: VERSION, port });
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
