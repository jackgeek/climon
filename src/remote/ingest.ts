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
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { getClimonHome, getRemoteHostPath, resolveConfigSetting } from "../config.js";
import { patchSessionMeta, writeSessionMeta } from "../store.js";
import type { AnsiColor, PriorityReason, SessionMeta, SessionMetaPatch, SessionStatus } from "../types.js";
import { encodeControl, encodeData, MuxDecoder, type ControlMessage } from "./mux.js";
import { ReplayGuard, verifySignedControl, signNow, DEFAULT_FRESHNESS_WINDOW_MS } from "./spawn-auth.js";
import { devtunnelEnv } from "./tunnel.js";
import { cleanupSessionSocket, formatSessionSocketRef, listenOnSessionSocket } from "../session-socket.js";
import type { IngestState } from "./ingest-state.js";
import { resolveIngestBindHost } from "./ingest-bind-host.js";
import { child } from "../logging/logger.js";
import { logMsg } from "../i18n/log-msg.js";
import { muxIdleTimeoutMs } from "./keepalive.js";

const log = () => child("ingest");

const REMOTE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_STR = 4096;
const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_KEEPALIVE_SECONDS = 60;

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

const SESSION_STATUSES = new Set<SessionStatus>([
  "running",
  "acknowledged",
  "needs-attention",
  "completed",
  "paused",
  "failed",
  "disconnected"
]);
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
  if (typeof input.theme === "string") clean.theme = boundedString(input.theme);
  if (typeof input.terminalTitle === "string") clean.terminalTitle = boundedString(input.terminalTitle);
  if (typeof input.attentionSnippet === "string") clean.attentionSnippet = boundedString(input.attentionSnippet);
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
    theme: typeof input.theme === "string" && input.theme ? boundedString(input.theme as string) : undefined,
    terminalTitle:
      typeof input.terminalTitle === "string" && input.terminalTitle
        ? boundedString(input.terminalTitle as string)
        : undefined,
    attentionSnippet:
      typeof input.attentionSnippet === "string" && input.attentionSnippet
        ? boundedString(input.attentionSnippet as string)
        : undefined,
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

/**
 * Shared state across connections within the ingest daemon lifetime.
 * Tracks active connections per clientId to prevent races on reconnect,
 * and dismissed sessions that should not be re-materialized.
 */
/** Outcome of a remote spawn round-trip, correlated by requestId. */
export interface RemoteSpawnResult {
  requestId: string;
  id?: string;
  warning?: string;
  error?: string;
}

/** A spawn request received on the loopback control socket. */
export interface SpawnControlRequest {
  type: "spawn";
  requestId: string;
  clientId: string;
  command: string[];
  cwd: string;
  cols: number;
  rows: number;
  name?: string;
  priority?: number;
  color?: string;
  theme?: string;
  headless: boolean;
  /** Per-run bearer token authenticating the caller to the running ingest. */
  controlToken?: string;
}

/** A spawn response written back on the control socket. */
export interface SpawnControlResponse {
  type: "spawn-result";
  requestId: string;
  id?: string;
  warning?: string;
  error?: string;
}

export interface SpawnControlDeps {
  registry: IngestConnectionRegistry;
  spawnSecret: string | undefined;
  timeoutMs: number;
}

/** Default time the ingest waits for a devbox SpawnResult. */
export const DEFAULT_SPAWN_TIMEOUT_MS = 10_000;

/**
 * Signs and forwards a Spawn to the target devbox, awaiting the correlated
 * SpawnResult. Pure with respect to I/O: all socket access goes through the
 * registry's channel + pending-spawn correlation, so it is unit-testable.
 */
export async function handleSpawnControlRequest(
  req: SpawnControlRequest,
  deps: SpawnControlDeps
): Promise<SpawnControlResponse> {
  if (!deps.spawnSecret) {
    return { type: "spawn-result", requestId: req.requestId, error: "remote spawn not configured" };
  }
  const channel = deps.registry.getChannel(req.clientId);
  if (!channel || channel.destroyed) {
    return { type: "spawn-result", requestId: req.requestId, error: "client not connected" };
  }
  const pending = deps.registry.registerPendingSpawn(req.requestId, deps.timeoutMs);
  const signed = signNow(
    deps.spawnSecret,
    {
      kind: "spawn",
      requestId: req.requestId,
      command: req.command,
      cwd: req.cwd,
      cols: req.cols,
      rows: req.rows,
      name: req.name,
      priority: req.priority,
      color: req.color,
      theme: req.theme,
      headless: req.headless
    },
    Date.now()
  );
  channel.write(encodeControl(signed));
  const result = await pending;
  return {
    type: "spawn-result",
    requestId: result.requestId,
    id: result.id,
    warning: result.warning,
    error: result.error
  };
}

export class IngestConnectionRegistry {
  /** Active connection per clientId — new hellos evict the previous. */
  private active = new Map<string, { channel: Socket; teardown: Promise<void>; resolve: () => void }>();
  /** Sessions explicitly removed by the user (localId set). Cleared on daemon restart. */
  private dismissed = new Set<string>();
  /** In-flight remote spawns keyed by requestId. */
  private pendingSpawns = new Map<string, { resolve: (r: RemoteSpawnResult) => void; timer: ReturnType<typeof setTimeout> }>();

  /** Returns true if the session has been dismissed and should not be re-materialized. */
  isDismissed(localId: string): boolean {
    return this.dismissed.has(localId);
  }

  /** Marks a session as dismissed (user explicitly removed it from the dashboard). */
  dismiss(localId: string): void {
    this.dismissed.add(localId);
  }

  /** Removes the dismissed flag (e.g. if the user re-starts a session with the same id on the devbox). */
  undismiss(localId: string): void {
    this.dismissed.delete(localId);
  }

  /**
   * Registers a new connection for a clientId. If an existing connection is
   * active for this clientId, forcibly closes it and awaits its teardown to
   * prevent races between the old connection's cleanup and the new one's setup.
   */
  async evictAndRegister(clientId: string, channel: Socket): Promise<void> {
    const existing = this.active.get(clientId);
    if (existing) {
      logMsg(log(), "debug", "ingest.evicting_previous_connection", { clientId });
      existing.channel.destroy();
      await existing.teardown;
    }
    let resolve!: () => void;
    const teardown = new Promise<void>((r) => { resolve = r; });
    this.active.set(clientId, { channel, teardown, resolve });
  }

  /** Signals that the connection for this clientId has fully torn down. */
  markTornDown(clientId: string, channel: Socket): void {
    const entry = this.active.get(clientId);
    if (entry && entry.channel === channel) {
      entry.resolve();
      this.active.delete(clientId);
    }
  }

  /** Returns the live channel for a clientId, or undefined if none is active. */
  getChannel(clientId: string): Socket | undefined {
    return this.active.get(clientId)?.channel;
  }

  /**
   * Registers an in-flight spawn and resolves when resolvePendingSpawn is called
   * with the same requestId, or after timeoutMs with `{ error: "timeout" }`.
   */
  registerPendingSpawn(requestId: string, timeoutMs: number): Promise<RemoteSpawnResult> {
    return new Promise<RemoteSpawnResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSpawns.delete(requestId);
        resolve({ requestId, error: "timeout" });
      }, timeoutMs);
      timer.unref?.();
      this.pendingSpawns.set(requestId, { resolve, timer });
    });
  }

  /** Resolves the in-flight spawn for requestId, if any. No-op otherwise. */
  resolvePendingSpawn(requestId: string, result: RemoteSpawnResult): void {
    const pending = this.pendingSpawns.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSpawns.delete(requestId);
    pending.resolve(result);
  }
}

export interface IngestConnOptions {
  env?: NodeJS.ProcessEnv;
  maxSessions?: number;
  keepAliveSeconds?: number;
  registry?: IngestConnectionRegistry;
  /** When set, inbound SpawnResults must be signed with this secret. */
  spawnSecret?: string;
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
  const registry = options.registry;
  const sessions = new Map<string, RemoteSession>();
  const decoder = new MuxDecoder();
  const spawnSecret = options.spawnSecret;
  const replayGuard = new ReplayGuard(DEFAULT_FRESHNESS_WINDOW_MS);
  let label: string | undefined;
  logMsg(log(), "debug", "ingest.inbound_connection", { host: channel.remoteAddress ?? "unknown", port: channel.remotePort ?? "?" });
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
    const localId = namespacedId(label, meta.id);
    // Check dismissal first — if the user deleted this session from the
    // dashboard, don't re-materialize or patch it (which would recreate the file).
    if (registry?.isDismissed(localId)) {
      const existing = sessions.get(meta.id);
      if (existing) {
        // Tear down the in-memory entry so we stop bridging data for it.
        for (const socket of existing.sockets) socket.destroy();
        try { existing.server.close(); } catch {}
        await cleanupSessionSocket(existing.socketPath);
        sessions.delete(meta.id);
      }
      return;
    }
    const existing = sessions.get(meta.id);
    if (existing) {
      const patch = sanitizeRemotePatch({ status: meta.status, priorityReason: meta.priorityReason });
      patch.lastActivityAt = new Date().toISOString();
      await patchSessionMeta(existing.localId, patch, env);
      return;
    }
    if (sessions.size >= maxSessions) return;
    const socketPath = formatSessionSocketRef("127.0.0.1", 0);
    await writeSessionMeta(toLocalMeta(meta, label, localId, socketPath, env), env);
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      send(encodeControl({ kind: "attach", id: meta.id }));
      socket.on("data", (chunk: Buffer) => send(encodeData(meta.id, chunk)));
      let cleanedUp = false;
      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
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
    if (message.kind === "signed") {
      if (!spawnSecret) return; // not expecting signed traffic; ignore.
      const verified = verifySignedControl(spawnSecret, message, replayGuard, Date.now());
      if (!verified.ok) {
        logMsg(log(), "warn", "ingest.signed_control_rejected", { reason: verified.reason, clientId: label ?? "unknown" });
        return;
      }
      await handleControl(verified.message);
      return;
    }
    if (message.kind === "spawn-result") {
      if (registry) {
        registry.resolvePendingSpawn(message.requestId, {
          requestId: message.requestId,
          id: message.id,
          warning: message.warning,
          error: message.error
        });
      }
      return;
    }
    if (message.kind === "hello") {
      if (!label && isValidRemoteId(message.clientId)) {
        label = message.clientId;
        logMsg(log(), "debug", "ingest.hello_received", { clientId: label });
        // Evict any previous connection for this clientId and wait for its
        // teardown to complete, preventing races between old cleanup and new setup.
        if (registry) {
          await registry.evictAndRegister(label, channel);
        }
      }
      return;
    }
    if (message.kind === "ping") {
      send(encodeControl({ kind: "pong" }));
      return;
    }
    if (message.kind === "pong") return;
    if (message.kind === "session-added") {
      logMsg(log(), "debug", "ingest.session_added", { sessionId: message.meta.id, displayCommand: message.meta.displayCommand, status: message.meta.status });
      await addSession(message.meta);
    } else if (message.kind === "session-updated") {
      if (!isValidRemoteId(message.id)) return;
      const session = sessions.get(message.id);
      if (session) {
        logMsg(log(), "trace", "ingest.session_updated", { sessionId: message.id, patch: JSON.stringify(message.patch) });
        await patchSessionMeta(session.localId, sanitizeRemotePatch(message.patch), env);
      }
    } else if (message.kind === "session-removed") {
      if (!isValidRemoteId(message.id)) return;
      logMsg(log(), "debug", "ingest.session_removed", { sessionId: message.id });
      await removeSession(message.id);
    }
    // attach/detach are devbox-bound only; never received here.
  }

  // Keepalive ping from the ingest side keeps the tunnel relay alive even before
  // a devbox connects (the tunnel host process maintains the forwarded port).
  const keepAliveMs = Math.max(0, (options.keepAliveSeconds ?? DEFAULT_KEEPALIVE_SECONDS) * 1000);
  const idleTimeoutMs = muxIdleTimeoutMs(keepAliveMs);
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
      logMsg(log(), "debug", "ingest.client_idle_destroying_channel", { clientId: label ?? "unknown", idleTimeout: idleTimeoutMs });
      channel.destroy();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };
  if (keepAliveMs > 0) {
    keepAliveTimer = setInterval(() => {
      send(encodeControl({ kind: "ping" }));
    }, keepAliveMs);
    keepAliveTimer.unref?.();
    armIdleTimer();
  }

  channel.on("data", (chunk: Buffer) => {
    armIdleTimer();
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch {
      logMsg(log(), "error", "ingest.mux_decode_error_from_client", { clientId: label ?? "unknown" });
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
      logMsg(log(), "debug", "ingest.client_disconnected_cleanup", { clientId: label ?? "unknown", sessionCount: sessions.size });
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (idleTimer) clearTimeout(idleTimer);
      await controlChain;
      for (const remoteId of [...sessions.keys()]) await removeSession(remoteId);
      if (label && registry) registry.markTornDown(label, channel);
      resolve();
    };
    channel.on("end", () => void teardown());
    channel.on("close", () => void teardown());
    channel.on("error", () => void teardown());
  });
}


export interface RemoteHostState {
  tunnelId: string;
  ingestPort: number;
  ingestHost?: string;
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
    env: devtunnelEnv(),
    windowsHide: true
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

export { DEFAULT_INGEST_PORT } from "./ingest-port.js";
const INGEST_PORT_RETRY_ATTEMPTS = 100;

/** Resolves the configured port-shift retry count, falling back to the default. */
export function resolveIngestRetryAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = resolveConfigSetting("remote.ingestPortRetryAttempts", env);
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) return raw;
  return INGEST_PORT_RETRY_ATTEMPTS;
}

/**
 * The interface this OS's ingest should bind, sharing one formula with the
 * daemon: an explicit `remote.ingestHost` override, then the devtunnel
 * `remote-host.json` host (cross-machine path, unchanged), then the same-machine
 * `resolveIngestBindHost` (WSL→loopback / Windows→vEthernet / loopback).
 */
export async function resolveIngestBindAddress(
  env: NodeJS.ProcessEnv = process.env,
  state?: RemoteHostState
): Promise<string> {
  const s = state ?? (await readRemoteHostState(env));
  const configIngestHost = asString(resolveConfigSetting("remote.ingestHost", env));
  return configIngestHost ?? s?.ingestHost ?? resolveIngestBindHost(env, { configuredHost: () => undefined });
}

/**
 * True when a live ingest must be recycled: it never published a beacon (the
 * pre-feature singleton / migration bug) or it bound an interface that differs
 * from what this OS should bind now (e.g. a changed vEthernet IP).
 */
export function ingestNeedsRecycle(beacon: IngestState | undefined, expectedHost: string): boolean {
  if (!beacon || !beacon.host) return true;
  return beacon.host !== expectedHost;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
