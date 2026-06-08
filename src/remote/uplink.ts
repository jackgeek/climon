import { spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  getClimonHome,
  getSessionsDir,
  resolveConfigSetting,
  writeConfigSetting
} from "../config.js";
import { listSessions, readSessionMeta } from "../store.js";
import { acquireSingleton } from "./singleton.js";
import { encodeControl, encodeData, MuxDecoder } from "./mux.js";
import { devtunnelEnv } from "./tunnel.js";
import { connectSessionSocket } from "../session-socket.js";
import { discoverDashboard } from "./discovery.js";
import { debugUplink as log } from "./debug.js";

export interface UplinkConfig {
  enabled: boolean;
  host?: string;
  tunnelId?: string;
  tunnelToken?: string;
  port?: number;
}

/**
 * Resolves the devbox uplink config from the cascade. Remote is only considered
 * enabled when a direct host+port or tunnel id+token+port are present. This
 * defends against stale SSH-era `remote.enabled: true` files.
 */
export function resolveUplinkConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): UplinkConfig {
  const enabledFlag = resolveConfigSetting("remote.enabled", env, cwd) === true;
  const host = asString(resolveConfigSetting("remote.host", env, cwd));
  const tunnelId = asString(resolveConfigSetting("remote.tunnelId", env, cwd));
  const tunnelToken = asString(resolveConfigSetting("remote.tunnelToken", env, cwd));
  const port = asNumber(resolveConfigSetting("remote.port", env, cwd));
  const hasDirectTarget = !!host && !!port;
  const hasTunnelTarget = !!tunnelId && !!tunnelToken && !!port;
  return {
    enabled: enabledFlag && (hasDirectTarget || hasTunnelTarget),
    host,
    tunnelId,
    tunnelToken,
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
  const id = `dev-${randomBytes(5).toString("hex")}`;
  writeConfigSetting("remote.clientId", id, "global", env, cwd);
  return id;
}

interface Bridge {
  write: (buf: Buffer) => void;
  attached: Map<string, Socket>;
  advertised: Set<string>;
  env: NodeJS.ProcessEnv;
}

async function reconcile(bridge: Bridge): Promise<void> {
  const current = new Set<string>();
  for (const meta of await listSessions(bridge.env)) {
    if (meta.origin === "remote") continue;
    current.add(meta.id);
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
export async function runUplinkBridge(
  channel: Socket,
  options: { env?: NodeJS.ProcessEnv; clientId: string }
): Promise<void> {
  const env = options.env ?? process.env;
  log(`bridge connected, sending hello (clientId=${options.clientId})`);
  const bridge: Bridge = {
    write: (buf) => {
      if (!channel.destroyed) channel.write(buf);
    },
    attached: new Map(),
    advertised: new Set(),
    env
  };
  const decoder = new MuxDecoder();

  bridge.write(encodeControl({ kind: "hello", clientId: options.clientId }));
  await reconcile(bridge);
  log(`initial reconcile done, advertised ${bridge.advertised.size} session(s)`);

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(getSessionsDir(env), () => void reconcile(bridge));
  } catch {
    // watch unsupported; sessions still advertised at connect time.
  }

  channel.on("data", (chunk: Buffer) => {
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch {
      log("mux decode error, destroying channel");
      channel.destroy();
      return;
    }
    for (const msg of messages) {
      if (msg.type === "control") {
        if (msg.message.kind === "attach") {
          log(`ingest requested attach for session ${msg.message.id}`);
          attach(bridge, msg.message.id);
        } else if (msg.message.kind === "detach") {
          log(`ingest requested detach for session ${msg.message.id}`);
          detach(bridge, msg.message.id);
        }
      } else {
        const socket = bridge.attached.get(msg.sessionId);
        if (socket) socket.write(msg.data);
      }
    }
  });

  await new Promise<void>((resolve) => {
    const teardown = (): void => {
      log("channel closed, tearing down bridge");
      watcher?.close();
      for (const socket of bridge.attached.values()) socket.destroy();
      resolve();
    };
    channel.on("close", teardown);
    channel.on("end", teardown);
    channel.on("error", () => {});
  });
}

const AUTH_REJECT = /unauthor|forbidden|expired|invalid token|401|403/i;

interface ConnectChild {
  child: ChildProcess;
  authRejected: () => boolean;
}

/** Spawns `devtunnel connect`, watching stderr for auth-rejection signatures. */
function spawnConnect(tunnelId: string, token: string): ConnectChild {
  const child = spawn("devtunnel", ["connect", tunnelId], {
    stdio: ["ignore", "pipe", "pipe"],
    env: devtunnelEnv({ ...process.env, DEVTUNNEL_ACCESS_TOKEN: token }),
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
  const peerHome = asString(resolveConfigSetting("remote.peerHome", env, cwd));
  const initialLegacy = resolveUplinkConfig(env, cwd);
  // Nothing to do: no peer link configured and no legacy direct/tunnel target.
  if (!peerHome && (!initialLegacy.enabled || !initialLegacy.port)) {
    log("no remote target configured (no peerHome, no enabled tunnel/direct), exiting");
    return 0;
  }

  const pidFile = join(getClimonHome(env), "uplink.pid");
  if (!(await acquireSingleton(pidFile))) {
    log("another uplink instance is already running, exiting");
    return 0;
  }

  log("singleton acquired, starting supervisor loop");
  const clientId = ensureClientId(env, cwd);
  log(`clientId: ${clientId}`);
  let backoffMs = 1000;

  for (;;) {
    const startedAt = Date.now();

    const peerTarget = peerHome ? await resolvePeerUplinkTarget(env, cwd) : undefined;
    const config = resolveUplinkConfig(env, cwd);

    let host: string | undefined;
    let port: number | undefined;
    let conn: ConnectChild | undefined;
    if (peerTarget) {
      log(`resolved peer target: ${peerTarget.host}:${peerTarget.port}`);
      host = peerTarget.host;
      port = peerTarget.port;
    } else if (config.enabled && config.port) {
      if (config.host) {
        log(`direct target: ${config.host}:${config.port}`);
        host = config.host;
        port = config.port;
      } else if (config.tunnelId && config.tunnelToken) {
        log(`spawning devtunnel connect for tunnel ${config.tunnelId}, forwarding port ${config.port}`);
        conn = spawnConnect(config.tunnelId, config.tunnelToken);
        host = "127.0.0.1";
        port = config.port;
      }
    }

    if (!host || !port) {
      // No reachable target yet. If a peer link is configured the dashboard may
      // simply not be up yet, so back off and retry; otherwise there is nothing
      // more to do.
      log(`no reachable target resolved${peerHome ? ", peer may not be up yet — retrying" : ", exiting"}`);
      conn?.child.kill();
      if (!peerHome) return 0;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 30_000);
      continue;
    }

    try {
      log(`waiting for port ${host}:${port} to become reachable...`);
      const reachable = await waitForPort(port, host);
      if (!reachable) {
        if (conn?.authRejected()) {
          process.stderr.write("climon uplink: dev tunnel token rejected (expired/invalid). Stopping.\n");
          log("auth rejected during port wait, stopping");
          conn.child.kill();
          return 1;
        }
        const reason = conn ? "forwarded port not reachable (tunnel may not be hosted)" : "ingest port not reachable";
        log(`port ${host}:${port} not reachable: ${reason}`);
        throw new Error(reason);
      }
      log(`port reachable, connecting to ${host}:${port}`);
      const channel = connect(port, host);
      await new Promise<void>((resolve, reject) => {
        channel.once("connect", resolve);
        channel.once("error", reject);
      });
      log("TCP channel established, starting mux bridge");
      await runUplinkBridge(channel, { env, clientId });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        process.stderr.write(`climon uplink: local port ${port} already in use.\n`);
        conn?.child.kill();
        return 1;
      }
      log(`connection error: ${(error as Error).message} (code=${code ?? "none"})`);
      // transient: fall through to backoff
    } finally {
      conn?.child.kill();
    }
    if (conn?.authRejected()) {
      process.stderr.write("climon uplink: dev tunnel token rejected (expired/invalid). Stopping.\n");
      log("auth rejected after bridge closed, stopping");
      return 1;
    }
    if (Date.now() - startedAt > 30_000) backoffMs = 1000;
    log(`reconnecting in ${backoffMs}ms...`);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
}
