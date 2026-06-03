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

export interface UplinkConfig {
  enabled: boolean;
  tunnelId?: string;
  tunnelToken?: string;
  port?: number;
}

/**
 * Resolves the devbox uplink config from the cascade. Remote is only considered
 * enabled when tunnelId, tunnelToken and port are all present — this defends
 * against stale SSH-era `remote.enabled: true` files.
 */
export function resolveUplinkConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): UplinkConfig {
  const enabledFlag = resolveConfigSetting("remote.enabled", env, cwd) === true;
  const tunnelId = asString(resolveConfigSetting("remote.tunnelId", env, cwd));
  const tunnelToken = asString(resolveConfigSetting("remote.tunnelToken", env, cwd));
  const port = asNumber(resolveConfigSetting("remote.port", env, cwd));
  return {
    enabled: enabledFlag && !!tunnelId && !!tunnelToken && !!port,
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
    const socket = connect(meta.socketPath);
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
 * Runs the mux bridge over an already-connected channel (a TCP socket to the
 * ingest daemon via the dev tunnel). Sends `hello` first, advertises local
 * sessions, and bridges attach/detach/data until the channel closes.
 */
export async function runUplinkBridge(
  channel: Socket,
  options: { env?: NodeJS.ProcessEnv; clientId: string }
): Promise<void> {
  const env = options.env ?? process.env;
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
      channel.destroy();
      return;
    }
    for (const msg of messages) {
      if (msg.type === "control") {
        if (msg.message.kind === "attach") attach(bridge, msg.message.id);
        else if (msg.message.kind === "detach") detach(bridge, msg.message.id);
      } else {
        const socket = bridge.attached.get(msg.sessionId);
        if (socket) socket.write(msg.data);
      }
    }
  });

  await new Promise<void>((resolve) => {
    const teardown = (): void => {
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
    env: { ...process.env, DEVTUNNEL_ACCESS_TOKEN: token }
  });
  let authRejected = false;
  const scan = (buf: Buffer): void => {
    if (AUTH_REJECT.test(buf.toString("utf8"))) authRejected = true;
  };
  child.stdout?.on("data", scan);
  child.stderr?.on("data", scan);
  return { child, authRejected: () => authRejected };
}

async function waitForPort(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect(port, "127.0.0.1");
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
 * Devbox uplink supervisor. Singleton; spawns `devtunnel connect`, opens a TCP
 * channel to the forwarded local port, and runs the bridge with backoff. Stops
 * retrying on a clear authentication rejection (expired/invalid token).
 */
export async function runUplink(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): Promise<number> {
  const config = resolveUplinkConfig(env, cwd);
  if (!config.enabled || !config.tunnelId || !config.tunnelToken || !config.port) return 0;

  const pidFile = join(getClimonHome(env), "uplink.pid");
  if (!(await acquireSingleton(pidFile))) return 0;

  const clientId = ensureClientId(env, cwd);
  let backoffMs = 1000;

  for (;;) {
    const startedAt = Date.now();
    const conn = spawnConnect(config.tunnelId, config.tunnelToken);
    try {
      const reachable = await waitForPort(config.port);
      if (!reachable) {
        if (conn.authRejected()) {
          process.stderr.write("climon uplink: dev tunnel token rejected (expired/invalid). Stopping.\n");
          conn.child.kill();
          return 1;
        }
        throw new Error("forwarded port not reachable");
      }
      const channel = connect(config.port, "127.0.0.1");
      await new Promise<void>((resolve, reject) => {
        channel.once("connect", resolve);
        channel.once("error", reject);
      });
      await runUplinkBridge(channel, { env, clientId });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        process.stderr.write(`climon uplink: local port ${config.port} already in use.\n`);
        conn.child.kill();
        return 1;
      }
      // transient: fall through to backoff
    } finally {
      conn.child.kill();
    }
    if (conn.authRejected()) {
      process.stderr.write("climon uplink: dev tunnel token rejected (expired/invalid). Stopping.\n");
      return 1;
    }
    if (Date.now() - startedAt > 30_000) backoffMs = 1000;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
}
