import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { getClimonHome, getRemoteHostPath } from "../config.js";
import { listSessions, patchSessionMeta, writeSessionMeta } from "../store.js";
import type { AnsiColor, PriorityReason, SessionMeta, SessionMetaPatch, SessionStatus } from "../types.js";
import { encodeControl, encodeData, MuxDecoder, type ControlMessage } from "./mux.js";
import { acquireSingleton } from "./singleton.js";
import { devtunnelEnv } from "./tunnel.js";
import { cleanupSessionSocket, formatSessionSocketRef, listenOnSessionSocket } from "../session-socket.js";

const REMOTE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_STR = 4096;
const DEFAULT_MAX_SESSIONS = 256;

export function isValidRemoteId(id: unknown): id is string {
  return typeof id === "string" && REMOTE_ID.test(id);
}

export function namespacedId(label: string, remoteId: string): string {
  return `${label}~${remoteId}`;
}

function boundedString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.length > MAX_STR ? value.slice(0, MAX_STR) : value;
}

const SESSION_STATUSES = new Set<SessionStatus>(["running", "needs-attention", "completed", "failed", "disconnected"]);
const PRIORITY_REASONS = new Set<PriorityReason>([
  "attention",
  "completed",
  "failed",
  "running",
  "disconnected",
  "manual"
]);
const ANSI_COLORS = new Set<AnsiColor>(["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]);

function sanitizeRemotePatch(patch: SessionMetaPatch): SessionMetaPatch {
  const input = patch as Record<string, unknown>;
  const clean: SessionMetaPatch = {};
  if (SESSION_STATUSES.has(input.status as SessionStatus)) clean.status = input.status as SessionStatus;
  if (PRIORITY_REASONS.has(input.priorityReason as PriorityReason)) {
    clean.priorityReason = input.priorityReason as PriorityReason;
  }
  if (typeof input.lastActivityAt === "string") clean.lastActivityAt = boundedString(input.lastActivityAt);
  if (typeof input.attentionMatchedAt === "string") clean.attentionMatchedAt = boundedString(input.attentionMatchedAt);
  if (typeof input.attentionReason === "string") clean.attentionReason = boundedString(input.attentionReason);
  if (typeof input.completedAt === "string") clean.completedAt = boundedString(input.completedAt);
  if (typeof input.exitCode === "number") clean.exitCode = input.exitCode;
  if (typeof input.error === "string") clean.error = boundedString(input.error);
  if (Number.isInteger(input.cols)) clean.cols = input.cols as number;
  if (Number.isInteger(input.rows)) clean.rows = input.rows as number;
  if (typeof input.name === "string") clean.name = boundedString(input.name);
  if (typeof input.priority === "number") clean.priority = input.priority;
  if (input.color === null || ANSI_COLORS.has(input.color as AnsiColor)) clean.color = input.color as AnsiColor | null;
  return clean;
}

/**
 * Builds a trusted local SessionMeta from an untrusted advertised meta. Every
 * server-controlled field (id, socketPath, origin, clientLabel, daemonPid) is
 * set locally and never taken from the wire.
 */
export function toLocalMeta(
  remote: SessionMeta,
  label: string,
  localId: string,
  socketPath: string,
  _env: NodeJS.ProcessEnv
): SessionMeta {
  const input = remote as unknown as Record<string, unknown>;
  return {
    id: localId,
    command: Array.isArray(remote.command) ? remote.command.map((c) => boundedString(c)) : [],
    displayCommand: boundedString(remote.displayCommand),
    cwd: boundedString(remote.cwd),
    status: SESSION_STATUSES.has(input.status as SessionStatus) ? (input.status as SessionStatus) : "running",
    priorityReason: PRIORITY_REASONS.has(input.priorityReason as PriorityReason)
      ? (input.priorityReason as PriorityReason)
      : "running",
    socketPath,
    cols: Number.isInteger(remote.cols) ? remote.cols : 80,
    rows: Number.isInteger(remote.rows) ? remote.rows : 24,
    headless: typeof input.headless === "boolean" ? input.headless : undefined,
    clientVersion: remote.clientVersion ? boundedString(remote.clientVersion) : undefined,
    createdAt: boundedString(remote.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: boundedString(remote.lastActivityAt) || new Date().toISOString(),
    completedAt: typeof input.completedAt === "string" ? boundedString(input.completedAt) : undefined,
    exitCode: typeof input.exitCode === "number" ? input.exitCode : undefined,
    name: remote.name ? boundedString(remote.name) : undefined,
    priority: typeof remote.priority === "number" ? remote.priority : undefined,
    color: input.color === null ? null : ANSI_COLORS.has(input.color as AnsiColor) ? (input.color as AnsiColor) : undefined,
    origin: "remote",
    clientLabel: label
  };
}

interface RemoteSession {
  localId: string;
  socketPath: string;
  server: Server;
  sockets: Set<Socket>;
}

export interface IngestConnOptions {
  env?: NodeJS.ProcessEnv;
  maxSessions?: number;
}

/**
 * Handles a single inbound mux connection (raw TCP from a devbox via the dev
 * tunnel). The first frame must be `hello`; its clientId namespaces all of the
 * connection's sessions so reconnects reuse the same local ids. All other input
 * is untrusted: invalid ids/oversized frames tear this connection down only.
 */
export async function runIngestConnection(channel: Socket, options: IngestConnOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = new Map<string, RemoteSession>();
  const decoder = new MuxDecoder();
  let label: string | undefined;
  // Control frames are processed strictly in order via this FIFO chain. The
  // devbox re-sends `session-added` for every session on each fs.watch tick, so
  // duplicate same-id adds are routine; serializing prevents two concurrent
  // adds from both passing the existence check and racing to bind the socket.
  let controlChain: Promise<void> = Promise.resolve();

  const send = (buf: Buffer): void => {
    if (!channel.destroyed) channel.write(buf);
  };

  async function addSession(meta: SessionMeta): Promise<void> {
    if (!label) return; // hello not yet received; ignore.
    if (!isValidRemoteId(meta.id)) return;
    const existing = sessions.get(meta.id);
    if (existing) {
      const patch = sanitizeRemotePatch({ status: meta.status, priorityReason: meta.priorityReason });
      patch.lastActivityAt = new Date().toISOString();
      await patchSessionMeta(existing.localId, patch, env);
      return;
    }
    if (sessions.size >= maxSessions) return;
    const localId = namespacedId(label, meta.id);
    const socketPath = formatSessionSocketRef("127.0.0.1", 0);
    await writeSessionMeta(toLocalMeta(meta, label, localId, socketPath, env), env);
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      if (sockets.size === 1) send(encodeControl({ kind: "attach", id: meta.id }));
      socket.on("data", (chunk: Buffer) => send(encodeData(meta.id, chunk)));
      const cleanup = (): void => {
        sockets.delete(socket);
        if (sockets.size === 0) send(encodeControl({ kind: "detach", id: meta.id }));
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    });
    server.on("error", () => {});
    const actualSocketPath = await listenOnSessionSocket(server, socketPath);
    await patchSessionMeta(localId, { socketPath: actualSocketPath }, env);
    sessions.set(meta.id, { localId, socketPath: actualSocketPath, server, sockets });
  }

  async function removeSession(remoteId: string): Promise<void> {
    const session = sessions.get(remoteId);
    if (!session) return;
    for (const socket of session.sockets) socket.destroy();
    try {
      session.server.close();
    } catch {
      // Already closed or failed to listen.
    }
    await cleanupSessionSocket(session.socketPath);
    await patchSessionMeta(session.localId, { status: "disconnected", priorityReason: "disconnected" }, env);
    sessions.delete(remoteId);
  }

  async function handleControl(message: ControlMessage): Promise<void> {
    if (message.kind === "hello") {
      if (!label && isValidRemoteId(message.clientId)) label = message.clientId;
      return;
    }
    if (message.kind === "session-added") {
      await addSession(message.meta);
    } else if (message.kind === "session-updated") {
      if (!isValidRemoteId(message.id)) return;
      const session = sessions.get(message.id);
      if (session) await patchSessionMeta(session.localId, sanitizeRemotePatch(message.patch), env);
    } else if (message.kind === "session-removed") {
      if (!isValidRemoteId(message.id)) return;
      await removeSession(message.id);
    }
    // attach/detach are devbox-bound only; never received here.
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
        const message = msg.message;
        controlChain = controlChain.then(() => handleControl(message)).catch(() => {});
      } else {
        const session = sessions.get(msg.sessionId);
        if (session) {
          for (const socket of session.sockets) socket.write(msg.data);
        }
      }
    }
  });

  await new Promise<void>((resolve) => {
    let tearingDown = false;
    const teardown = async (): Promise<void> => {
      if (tearingDown) return;
      tearingDown = true;
      await controlChain;
      for (const remoteId of [...sessions.keys()]) await removeSession(remoteId);
      resolve();
    };
    channel.on("end", () => void teardown());
    channel.on("close", () => void teardown());
    channel.on("error", () => void teardown());
  });
}


export interface RemoteHostState {
  tunnelId: string;
  connectToken?: string;
  ingestPort: number;
  tokenExpiresAt?: string;
  canHost?: boolean;
}

export interface HostProcess {
  stop: () => void;
}

export interface SupervisorOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to spawning the real `devtunnel host`. */
  spawnHost?: (tunnelId: string) => HostProcess;
}

/** Reads the desired tunnel-hosting state from ~/.climon/remote-host.json, or undefined. */
export async function readRemoteHostState(env: NodeJS.ProcessEnv = process.env): Promise<RemoteHostState | undefined> {
  try {
    const raw = await readFile(getRemoteHostPath(env), "utf8");
    const parsed = JSON.parse(raw) as RemoteHostState;
    if (typeof parsed.tunnelId !== "string" || !Number.isInteger(parsed.ingestPort)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function defaultSpawnHost(tunnelId: string): HostProcess {
  const child: ChildProcess = spawn("devtunnel", ["host", tunnelId], {
    stdio: ["ignore", "inherit", "inherit"],
    env: devtunnelEnv()
  });
  return {
    stop: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
  };
}

/**
 * Desired-state supervisor for `devtunnel host`. `reconcile()` compares the
 * persisted remote-host.json against the running host child and starts/stops/
 * restarts to match. Idempotent: calling it repeatedly with unchanged state is a
 * no-op.
 */
export class TunnelHostSupervisor {
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnHost: (tunnelId: string) => HostProcess;
  private current?: { tunnelId: string; proc: HostProcess };

  constructor(options: SupervisorOptions = {}) {
    this.env = options.env ?? process.env;
    this.spawnHost = options.spawnHost ?? defaultSpawnHost;
  }

  async reconcile(): Promise<void> {
    const desired = await readRemoteHostState(this.env);
    const desiredId = desired?.tunnelId;
    if (this.current?.tunnelId === desiredId) return;
    if (this.current) {
      this.current.proc.stop();
      this.current = undefined;
    }
    if (desiredId) {
      this.current = { tunnelId: desiredId, proc: this.spawnHost(desiredId) };
    }
  }

  stop(): void {
    this.current?.proc.stop();
    this.current = undefined;
  }
}

export function getIngestPidPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), "ingest.pid");
}

/** Default loopback port the ingest daemon listens on. */
export const DEFAULT_INGEST_PORT = 3132;

/** Marks any leftover running remote sessions from a previous daemon as disconnected. */
async function reconcileStaleRemoteSessions(env: NodeJS.ProcessEnv): Promise<void> {
  for (const meta of await listSessions(env)) {
    if (meta.origin === "remote" && (meta.status === "running" || meta.status === "needs-attention")) {
      await patchSessionMeta(meta.id, { status: "disconnected", priorityReason: "disconnected" }, env);
    }
  }
}

/**
 * Long-lived, detached singleton ingest daemon. Binds the loopback ingest port
 * first, then supervises `devtunnel host` per remote-host.json (watched + polled),
 * and materializes inbound mux connections as remote sessions.
 */
export async function runIngestDaemon(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!(await acquireSingleton(getIngestPidPath(env)))) return 0;
  await reconcileStaleRemoteSessions(env);

  const state = await readRemoteHostState(env);
  const port = state?.ingestPort ?? DEFAULT_INGEST_PORT;

  const server = createNetServer((socket) => {
    void runIngestConnection(socket, { env });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const supervisor = new TunnelHostSupervisor({ env });
  await supervisor.reconcile();

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(getClimonHome(env), (_event, filename) => {
      if (!filename || String(filename) === "remote-host.json") void supervisor.reconcile();
    });
  } catch {
    // fs.watch unsupported here; rely on polling.
  }
  const poll = setInterval(() => void supervisor.reconcile(), 5000);

  const shutdown = (): void => {
    clearInterval(poll);
    watcher?.close();
    supervisor.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Run forever.
  await new Promise<void>(() => {});
  return 0;
}
