import { watch } from "node:fs";
import { networkInterfaces } from "node:os";
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { Buffer } from "node:buffer";
import type { ServerWebSocket } from "bun";
import {
  ensureClimonHome,
  getSessionsDir,
  loadConfig,
  saveConfig
} from "../config.js";
import { encodeFrame, encodeJsonFrame, FrameDecoder, FrameType, parseJsonPayload, type ExitPayload, type PtySizePayload } from "../ipc/frame.js";
import { sortSessionsByPriority } from "../priority.js";
import { listSessions, patchSessionMeta, readScrollback, readSessionMeta, removeSessionMeta } from "../store.js";
import type { ClimonConfig } from "../types.js";
import { getStaticAsset, renderDashboard } from "./assets.js";

interface StartServerOptions {
  lan?: boolean;
  port?: number;
}

interface WsData {
  sessionId: string;
  socketPath: string;
}

const ATTACH_PATH = /^\/api\/sessions\/([^/]+)\/attach$/;
const SCROLLBACK_PATH = /^\/api\/sessions\/([^/]+)\/scrollback$/;
const SESSION_PATH = /^\/api\/sessions\/([^/]+)$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function normalizeDimension(value: unknown, fallback: number): string {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (Number.isFinite(n) && n > 0) {
    return String(Math.trunc(n));
  }
  return String(fallback);
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
  rows: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [process.argv[1], "run", "--headless", ...argv],
      {
        cwd,
        env: { ...process.env, CLIMON_COLS: cols, CLIMON_ROWS: rows },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
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

function probeSocket(socketPath: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
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

async function cleanupStaleSessions(): Promise<void> {
  const sessions = await listSessions();
  for (const session of sessions) {
    if (session.status !== "running" && session.status !== "needs-attention") {
      continue;
    }
    const pidAlive = session.daemonPid ? isProcessAlive(session.daemonPid) : false;
    const socketOk = pidAlive ? await probeSocket(session.socketPath) : false;
    if (!socketOk) {
      await patchSessionMeta(session.id, {
        status: "disconnected",
        priorityReason: "disconnected",
      });
    }
  }
}

export async function startServer(options: StartServerOptions = {}): Promise<void> {
  await ensureClimonHome();
  const config = await loadConfig();
  if (options.lan !== undefined) {
    config.server.lan = options.lan;
  }
  if (options.port !== undefined) {
    config.server.port = options.port;
  }
  config.server.host = config.server.lan ? "0.0.0.0" : "127.0.0.1";
  await saveConfig(config);

  // Clean up stale sessions whose daemons are no longer responsive.
  await cleanupStaleSessions();

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
    if (isLocal(request, server)) {
      return true;
    }
    if (!config.server.lan) {
      return false;
    }
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? request.headers.get("x-climon-token");
    return token === config.server.token;
  }

  let server: Bun.Server<WsData>;
  try {
    server = Bun.serve<WsData>({
    hostname: config.server.host,
    port: config.server.port,
    async fetch(request, srv) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return Response.json({ ok: true });
      }

      const asset = getStaticAsset(url.pathname);
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
        // Spawning processes is privileged: allow loopback only, even when a
        // valid LAN token is present.
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
        let payload: { command?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown };
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
        const cwd =
          typeof payload.cwd === "string" && payload.cwd.trim().length > 0
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
          const id = await spawnHeadlessSession(argv, cwd, cols, rows);
          return Response.json({ id }, { status: 201 });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return new Response(`Failed to create session: ${message}`, { status: 500 });
        }
      }

      if (url.pathname === "/api/sessions") {
        return new Response(await sessionsPayload(), { headers: { "content-type": "application/json" } });
      }

      const sessionMatch = SESSION_PATH.exec(url.pathname);
      if (sessionMatch && request.method === "DELETE") {
        // Clean up only removes the recorded session (metadata + scrollback) from
        // the dashboard. It deliberately does NOT signal the daemon, so any climon
        // client still attached to this session keeps running uninterrupted.
        const removed = await removeSessionMeta(sessionMatch[1]);
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
        return new Response(new Uint8Array(data), { headers: { "content-type": "application/octet-stream" } });
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
        const daemon: Socket = connect(ws.data.socketPath);
        const decoder = new FrameDecoder();
        (ws.data as WsData & { daemon?: Socket }).daemon = daemon;

        daemon.on("data", (chunk) => {
          for (const frame of decoder.push(chunk)) {
            if (frame.type === FrameType.Output || frame.type === FrameType.Replay) {
              ws.sendBinary(frame.payload);
            } else if (frame.type === FrameType.Exit) {
              const exit = parseJsonPayload<ExitPayload>(frame.payload);
              ws.send(JSON.stringify({ type: "exit", exitCode: exit.exitCode }));
            } else if (frame.type === FrameType.PtySize) {
              const size = parseJsonPayload<PtySizePayload>(frame.payload);
              ws.send(JSON.stringify({ type: "size", cols: size.cols, rows: size.rows }));
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
          const message = JSON.parse(raw) as { type: string; data?: string; cols?: number; rows?: number };
          if (message.type === "input" && typeof message.data === "string") {
            daemon.write(encodeFrame(FrameType.Input, Buffer.from(message.data, "utf8")));
          } else if (message.type === "resize" && message.cols && message.rows) {
            daemon.write(encodeJsonFrame(FrameType.Resize, { cols: message.cols, rows: message.rows, source: "viewer" }));
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
    throw describeListenError(error, config.server.host, config.server.port);
  }

  printStartup(config, config.server.port);

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      watcher.close();
      server.stop();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

/**
 * Returns the non-internal IPv4 addresses of this machine, so the LAN startup
 * banner can show how to reach the server instead of a placeholder.
 */
function localLanAddresses(): string[] {
  const addresses: string[] = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const info of iface ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
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

function printStartup(config: ClimonConfig, port: number): void {
  if (config.server.lan) {
    const addresses = localLanAddresses();
    const query = `?token=${config.server.token}`;
    if (addresses.length > 0) {
      for (const address of addresses) {
        process.stdout.write(`climon server listening on http://${address}:${port}/${query}\n`);
      }
    } else {
      process.stdout.write(`climon server listening on http://<this-machine-ip>:${port}/${query}\n`);
    }
    process.stdout.write(`LAN access enabled. Open a URL above (token included) from another machine.\n`);
    return;
  }
  process.stdout.write(`climon server listening on http://127.0.0.1:${port}/\n`);
}
