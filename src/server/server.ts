import { watch } from "node:fs";
import { networkInterfaces } from "node:os";
import { connect, type Socket } from "node:net";
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
import { listSessions, readScrollback, readSessionMeta, removeSessionMeta } from "../store.js";
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
