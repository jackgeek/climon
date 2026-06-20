/**
 * ⚠️ LEGACY TypeScript client — frozen. Fix the Rust client instead.
 *
 * The shipping `climon` *client* is the Rust workspace under `rust/` (crates
 * `climon-cli`, `climon-session`, `climon-pty`, `climon-store`, `climon-config`,
 * `climon-remote`, `climon-install`, `climon-update`, …). This module belongs to
 * the legacy Bun/TypeScript client, kept only for local development and the Bun
 * test suite. Do NOT add features or fix client bugs here — make all client
 * changes in the Rust crates. (The Bun dashboard *server* under `src/server*`
 * and `src/web/` is NOT legacy and is still maintained.)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import {
  getClimonHome,
  getSessionsDir,
  resolveConfigSetting,
  writeConfigSetting
} from "../config.js";
import { listSessions, patchSessionMeta, readSessionMeta } from "../store.js";
import { acquireSingletonDetailed } from "./singleton.js";
import { encodeControl, encodeData, MuxDecoder } from "./mux.js";
import { devtunnelEnv } from "./tunnel.js";
import { connectSessionSocket } from "../session-socket.js";
import { discoverDashboard } from "./discovery.js";
import { isProcessAlive } from "../process-kill.js";
import { child, initLogger } from "../logging/logger.js";
import { logMsg } from "../i18n/log-msg.js";
import { muxIdleTimeoutMs } from "./keepalive.js";

const log = () => child("uplink");
import { defaultClientId } from "./client-id.js";

export interface UplinkConfig {
  enabled: boolean;
  host?: string;
  tunnelId?: string;
  port?: number;
}

/**
 * Resolves the devbox uplink config from the cascade. Remote is only considered
 * enabled when a direct host+port or tunnel id are present. The port is
 * optional for tunnel mode (discovered from the tunnel's port mapping).
 */
export function resolveUplinkConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): UplinkConfig {
  const enabledFlag = resolveConfigSetting("remote.enabled", env, cwd) === true;
  const host = asString(resolveConfigSetting("remote.host", env, cwd));
  const tunnelId = asString(resolveConfigSetting("remote.tunnelId", env, cwd));
  const port = asNumber(resolveConfigSetting("remote.port", env, cwd));
  const hasDirectTarget = !!host && !!port;
  const hasTunnelTarget = !!tunnelId;
  return {
    enabled: enabledFlag && (hasDirectTarget || hasTunnelTarget),
    host,
    tunnelId,
    port
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/** Returns the stable devbox client id, generating + persisting it globally if absent. */
export function ensureClientId(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const existing = asString(resolveConfigSetting("remote.clientId", env, cwd));
  if (existing) return existing;
  const id = defaultClientId();
  writeConfigSetting("remote.clientId", id, "global", env, cwd);
  return id;
}

interface Bridge {
  write: (buf: Buffer) => void;
  attached: Map<string, Socket>;
  advertised: Set<string>;
  env: NodeJS.ProcessEnv;
}

const LIVE_STATUSES = new Set(["running", "acknowledged", "needs-attention", "paused"]);

async function reconcile(bridge: Bridge): Promise<void> {
  const current = new Set<string>();
  for (const meta of await listSessions(bridge.env)) {
    if (meta.origin === "remote") continue;
    current.add(meta.id);
    // Check daemon liveness for sessions that claim to be running.
    // If the daemon is dead, advertise as disconnected so the dashboard
    // doesn't show an unresponsive session. Also persist the update locally
    // so a future reconcile doesn't repeat the check.
    if (LIVE_STATUSES.has(meta.status) && meta.daemonPid && !isProcessAlive(meta.daemonPid)) {
      meta.status = "disconnected";
      meta.priorityReason = "disconnected";
      void patchSessionMeta(meta.id, { status: "disconnected", priorityReason: "disconnected" }, bridge.env);
    }
    bridge.write(encodeControl({ kind: "session-added", meta }));
  }
  for (const id of bridge.advertised) {
    if (!current.has(id)) bridge.write(encodeControl({ kind: "session-removed", id }));
  }
  bridge.advertised = current;
}

function attach(bridge: Bridge, sessionId: string): void {
  if (bridge.attached.has(sessionId)) return;
  void readSessionMeta(sessionId, bridge.env).then((meta) => {
    if (!meta) return;
    const socket = connectSessionSocket(meta.socketPath);
    bridge.attached.set(sessionId, socket);
    socket.on("data", (chunk: Buffer) => bridge.write(encodeData(sessionId, chunk)));
    const cleanup = (): void => {
      bridge.attached.delete(sessionId);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}

function detach(bridge: Bridge, sessionId: string): void {
  const socket = bridge.attached.get(sessionId);
  if (socket) {
    socket.destroy();
    bridge.attached.delete(sessionId);
  }
}

/**
 * Runs the mux bridge over an already-connected channel to an ingest daemon.
 * Sends `hello` first, advertises local sessions, and bridges attach/detach/data
 * until the channel closes.
 */
/** Default keepalive interval in seconds. */
export const DEFAULT_KEEPALIVE_SECONDS = 60;

function resolveKeepAlive(env: NodeJS.ProcessEnv, cwd: string): number {
  const value = resolveConfigSetting("remote.keepAlive", env, cwd);
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return DEFAULT_KEEPALIVE_SECONDS;
}

export async function runUplinkBridge(
  channel: Socket,
  options: { env?: NodeJS.ProcessEnv; clientId: string; keepAliveSeconds?: number }
): Promise<void> {
  const env = options.env ?? process.env;
  const keepAliveMs = Math.max(0, (options.keepAliveSeconds ?? DEFAULT_KEEPALIVE_SECONDS) * 1000);
  const idleTimeoutMs = muxIdleTimeoutMs(keepAliveMs);
  logMsg(log(), "debug", "uplink.bridge_connected", { clientId: options.clientId, keepAlive: keepAliveMs });
  let bytesSent = 0;
  let bytesReceived = 0;
  const bridge: Bridge = {
    write: (buf) => {
      if (!channel.destroyed) { bytesSent += buf.length; channel.write(buf); }
    },
    attached: new Map(),
    advertised: new Set(),
    env
  };
  const decoder = new MuxDecoder();

  bridge.write(encodeControl({ kind: "hello", clientId: options.clientId }));
  await reconcile(bridge);
  logMsg(log(), "debug", "uplink.initial_reconcile_done", { advertisedCount: bridge.advertised.size, bytesSent });

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(getSessionsDir(env), () => void reconcile(bridge));
  } catch {
    // watch unsupported; sessions still advertised at connect time.
  }

  // Periodic keepalive ping prevents the dev tunnel relay from dropping idle
  // forwarded connections. Both sides send pings; any inbound mux frame keeps the
  // channel alive, while a silent peer is torn down so the supervisor reconnects.
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = (): void => {
    if (idleTimeoutMs <= 0) {
      return;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      logMsg(log(), "debug", "uplink.channel_idle_destroying_bridge", { idleTimeout: idleTimeoutMs });
      channel.destroy();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };
  if (keepAliveMs > 0) {
    keepAliveTimer = setInterval(() => {
      bridge.write(encodeControl({ kind: "ping" }));
    }, keepAliveMs);
    keepAliveTimer.unref?.();
    armIdleTimer();
  }

  channel.on("data", (chunk: Buffer) => {
    armIdleTimer();
    bytesReceived += chunk.length;
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch {
      logMsg(log(), "error", "uplink.mux_decode_error", {});
      channel.destroy();
      return;
    }
    for (const msg of messages) {
      if (msg.type === "control") {
        if (msg.message.kind === "attach") {
          logMsg(log(), "debug", "uplink.ingest_requested_attach", { sessionId: msg.message.id });
          attach(bridge, msg.message.id);
        } else if (msg.message.kind === "detach") {
          logMsg(log(), "debug", "uplink.ingest_requested_detach", { sessionId: msg.message.id });
          detach(bridge, msg.message.id);
        } else if (msg.message.kind === "ping") {
          bridge.write(encodeControl({ kind: "pong" }));
        }
      } else {
        const socket = bridge.attached.get(msg.sessionId);
        if (socket) socket.write(msg.data);
      }
    }
  });

  await new Promise<void>((resolve) => {
    const teardown = (reason: string): void => {
      logMsg(log(), "debug", "uplink.channel_teardown", { reason, bytesSent, bytesReceived });
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (idleTimer) clearTimeout(idleTimer);
      watcher?.close();
      for (const socket of bridge.attached.values()) socket.destroy();
      resolve();
    };
    channel.on("close", (hadError: boolean) => teardown(`closed${hadError ? " (with error)" : ""}`));
    channel.on("end", () => teardown("received FIN (remote end closed)"));
    channel.on("error", (err: Error) => logMsg(log(), "error", "uplink.channel_error", { message: err.message }));
  });
}

const AUTH_REJECT = /unauthor|forbidden|expired|invalid token|401|403/i;

interface ConnectChild {
  child: ChildProcess;
  authRejected: () => boolean;
}

/** Spawns `devtunnel connect` using the caller's logged-in devtunnel identity. */
function spawnConnect(tunnelId: string): ConnectChild {
  const child = spawn("devtunnel", ["connect", tunnelId], {
    stdio: ["ignore", "pipe", "pipe"],
    env: devtunnelEnv(),
    windowsHide: true
  });
  let authRejected = false;
  const scan = (buf: Buffer): void => {
    if (AUTH_REJECT.test(buf.toString("utf8"))) authRejected = true;
  };
  child.stdout?.on("data", scan);
  child.stderr?.on("data", scan);
  return { child, authRejected: () => authRejected };
}

/**
 * Discovers the forwarded port for a tunnel by querying `devtunnel port list`.
 * Returns the first port number found, or undefined if the query fails or
 * no ports are mapped.
 */
async function discoverTunnelPort(tunnelId: string): Promise<number | undefined> {
  const result = await new Promise<{ status: number; stdout: string }>((resolve) => {
    const child = spawn("devtunnel", ["port", "list", tunnelId, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: devtunnelEnv(),
      windowsHide: true
    });
    let stdout = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.on("error", () => resolve({ status: 127, stdout: "" }));
    child.on("close", (code) => resolve({ status: code ?? 1, stdout }));
  });
  if (result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout);
    // devtunnel port list --json returns an array of port entries with a portNumber field,
    // or an object with a ports array.
    const ports = Array.isArray(parsed) ? parsed : (parsed.ports ?? parsed.value ?? []);
    for (const entry of ports) {
      const p = entry.portNumber ?? entry.port ?? entry.Port;
      if (typeof p === "number" && p > 0) return p;
    }
  } catch {
    // Try a line-based fallback: look for a number in the output.
    const match = result.stdout.match(/\b(\d{2,5})\b/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

async function waitForPort(port: number, host = "127.0.0.1", timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect(port, host);
      s.once("connect", () => {
        s.end();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Resolves a live peer-discovery uplink target from the peer's `server.json`
 * beacon. Reading it here (rather than caching) means a collision-bumped ingest
 * port on the dashboard side is always picked up on the next reconnect.
 */
async function resolvePeerUplinkTarget(
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<{ host: string; port: number } | undefined> {
  const peerHome = asString(resolveConfigSetting("remote.peerHome", env, cwd));
  if (!peerHome) return undefined;
  const target = await discoverDashboard(env, cwd);
  if (target?.location === "peer" && target.ingest) {
    return { host: target.host, port: target.ingest };
  }
  return undefined;
}

/**
 * Devbox uplink supervisor. Singleton. Prefers a same-machine peer dashboard
 * discovered via `remote.peerHome` (WSL<->Windows), connecting directly to its
 * ingest port. Otherwise opens a direct TCP channel when `remote.host` is
 * configured, or spawns `devtunnel connect` and opens a channel to the
 * forwarded local port. Stops retrying on clear tunnel auth rejection.
 */
export async function runUplink(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): Promise<number> {
  initLogger("uplink");
  const peerHome = asString(resolveConfigSetting("remote.peerHome", env, cwd));
  const initialLegacy = resolveUplinkConfig(env, cwd);
  // Nothing to do: no peer link configured and no legacy direct/tunnel target.
  if (!peerHome && !initialLegacy.enabled) {
    logMsg(log(), "debug", "uplink.no_remote_target_configured", {});
    return 0;
  }

  const pidFile = join(getClimonHome(env), "uplink.pid");
  const singleton = await acquireSingletonDetailed(pidFile);
  if (!singleton.acquired) {
    logMsg(log(), "debug", "uplink.singleton_already_running", { pid: singleton.holder });
    return 0;
  }

  logMsg(log(), "debug", "uplink.singleton_acquired_supervisor_loop", {});
  const clientId = ensureClientId(env, cwd);
  logMsg(log(), "debug", "uplink.client_id", { clientId });
  let backoffMs = 1000;

  for (;;) {
    const startedAt = Date.now();

    const peerTarget = peerHome ? await resolvePeerUplinkTarget(env, cwd) : undefined;
    const config = resolveUplinkConfig(env, cwd);

    let host: string | undefined;
    let port: number | undefined;
    let conn: ConnectChild | undefined;
    if (peerTarget) {
      logMsg(log(), "debug", "uplink.resolved_peer_target", { host: peerTarget.host, port: peerTarget.port });
      host = peerTarget.host;
      port = peerTarget.port;
    } else if (config.enabled) {
      if (config.host && config.port) {
        logMsg(log(), "debug", "uplink.direct_target", { host: config.host, port: config.port });
        host = config.host;
        port = config.port;
      } else if (config.tunnelId) {
        // Discover the port from the tunnel's port mapping if not explicitly configured.
        const tunnelPort = config.port ?? await discoverTunnelPort(config.tunnelId);
        if (!tunnelPort) {
          logMsg(log(), "debug", "uplink.tunnel_port_not_found", { tunnelId: config.tunnelId });
        } else {
          logMsg(log(), "debug", "uplink.devtunnel_connect_spawning", { tunnelId: config.tunnelId, port: tunnelPort });
          conn = spawnConnect(config.tunnelId);
          host = "127.0.0.1";
          port = tunnelPort;
        }
      }
    }

    if (!host || !port) {
      // No reachable target yet. If a peer link is configured the dashboard may
      // simply not be up yet, so back off and retry; otherwise there is nothing
      // more to do.
      logMsg(log(), "debug", "uplink.no_reachable_target_resolved", { detail: peerHome ? ", peer may not be up yet — retrying" : ", exiting" });
      conn?.child.kill();
      if (!peerHome) return 0;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 30_000);
      continue;
    }

    try {
      logMsg(log(), "debug", "uplink.waiting_for_port", { host, port });
      const reachable = await waitForPort(port, host);
      if (!reachable) {
        if (conn?.authRejected()) {
          process.stderr.write("climon uplink: dev tunnel auth rejected (not authorized for this tunnel). Stopping.\n");
          logMsg(log(), "error", "uplink.auth_rejected_port_wait", {});
          conn.child.kill();
          return 1;
        }
        const reason = conn ? "forwarded port not reachable (tunnel may not be hosted)" : "ingest port not reachable";
        logMsg(log(), "debug", "uplink.port_not_reachable", { host, port, reason });
        throw new Error(reason);
      }
      logMsg(log(), "debug", "uplink.port_reachable_connecting", { host, port });
      const channel = connect(port, host);
      await new Promise<void>((resolve, reject) => {
        channel.once("connect", resolve);
        channel.once("error", reject);
      });
      logMsg(log(), "debug", "uplink.tcp_channel_established", {});
      await runUplinkBridge(channel, { env, clientId, keepAliveSeconds: resolveKeepAlive(env, cwd) });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        process.stderr.write(`climon uplink: local port ${port} already in use.\n`);
        conn?.child.kill();
        return 1;
      }
      logMsg(log(), "error", "uplink.connection_error", { message: (error as Error).message, code: code ?? "none" });
      // transient: fall through to backoff
    } finally {
      conn?.child.kill();
    }
    if (conn?.authRejected()) {
      process.stderr.write("climon uplink: dev tunnel auth rejected (not authorized for this tunnel). Stopping.\n");
      logMsg(log(), "error", "uplink.auth_rejected_bridge_closed", {});
      return 1;
    }
    if (Date.now() - startedAt > 30_000) backoffMs = 1000;
    logMsg(log(), "debug", "uplink.reconnecting", { backoff: backoffMs });
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
}
