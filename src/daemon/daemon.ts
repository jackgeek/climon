import { createServer, type Server, type Socket } from "node:net";
import { rm } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { ensureClimonHome, loadConfig, SESSION_ENV_VAR } from "../config.js";
import {
  encodeFrame,
  encodeJsonFrame,
  FrameDecoder,
  FrameType,
  parseJsonPayload,
  type ResizePayload,
  type AttentionPayload
} from "../ipc/frame.js";
import { spawnPty, resolveCommand, type PtyHandle } from "../pty.js";
import { ScrollbackBuffer } from "./buffer.js";
import { patchSessionMeta, readSessionMeta, writeScrollback } from "../store.js";

/**
 * Resolves a requested resize to the dimensions actually applied to the PTY.
 * With clamping enabled, a viewer (browser) request is capped to the host
 * terminal's size so the non-reflowing local terminal is never overgrown. Host
 * requests and the unclamped case pass through (floored at 1x1).
 */
export function clampResize(
  request: { cols: number; rows: number; source?: "host" | "viewer" },
  host: { cols: number; rows: number },
  clampBrowserToHost: boolean
): { cols: number; rows: number } {
  const cols = Math.max(request.cols, 1);
  const rows = Math.max(request.rows, 1);
  if (clampBrowserToHost && request.source !== "host") {
    return {
      cols: Math.min(cols, Math.max(host.cols, 1)),
      rows: Math.min(rows, Math.max(host.rows, 1))
    };
  }
  return { cols, rows };
}

export async function runSessionDaemon(id: string): Promise<void> {
  await ensureClimonHome();
  const config = await loadConfig();
  const meta = await readSessionMeta(id);
  if (!meta) {
    throw new Error(`Session metadata for '${id}' not found.`);
  }

  const scrollback = new ScrollbackBuffer();
  const clients = new Set<Socket>();

  const clampBrowserToHost = config.terminal.clampBrowserToHost;
  // The host terminal owns the maximum PTY size when clamping is enabled. It is
  // seeded from the launch dimensions and refreshed whenever the local terminal
  // reports a resize.
  let hostCols = meta.cols;
  let hostRows = meta.rows;
  // The size currently applied to the PTY, broadcast so browser viewers can
  // match it exactly instead of rendering at their own (larger) viewport.
  let appliedCols = meta.cols;
  let appliedRows = meta.rows;

  let lastAttentionState: boolean | undefined;
  let exited = false;
  let exitInfo: { exitCode: number } | undefined;
  let resolveExit: (() => void) | undefined;

  function broadcast(frame: Buffer): void {
    for (const client of clients) {
      client.write(frame);
    }
  }

  /**
   * Resolves a resize request to the size actually applied to the PTY. When
   * clamping is enabled, a browser viewer can never grow the PTY beyond the host
   * terminal's dimensions; the host terminal always sets the cap directly.
   */
  function applyResize(size: ResizePayload): void {
    if (size.source === "host") {
      hostCols = Math.max(size.cols, 1);
      hostRows = Math.max(size.rows, 1);
    }

    const { cols, rows } = clampResize(size, { cols: hostCols, rows: hostRows }, clampBrowserToHost);
    const changed = cols !== appliedCols || rows !== appliedRows;
    appliedCols = cols;
    appliedRows = rows;
    pty.resize(cols, rows);
    if (changed) {
      void patchSessionMeta(id, { cols, rows });
      broadcast(encodeJsonFrame(FrameType.PtySize, { cols, rows }));
    }
  }

  /**
   * Applies a client-reported attention transition. The daemon is the only
   * writer of session metadata, so detection state from the client funnels
   * through here. Transitions are de-duped against the last applied value and
   * ignored after the PTY exits so the completed/failed patch always wins.
   */
  function applyAttention(payload: AttentionPayload): void {
    if (exited) {
      return;
    }
    if (lastAttentionState === payload.needsAttention) {
      return;
    }
    lastAttentionState = payload.needsAttention;
    const now = new Date().toISOString();
    if (payload.needsAttention) {
      void patchSessionMeta(id, {
        status: "needs-attention",
        priorityReason: "attention",
        attentionMatchedAt: now,
        attentionReason: payload.reason,
        lastActivityAt: now
      });
    } else {
      void patchSessionMeta(id, {
        status: "running",
        priorityReason: "running",
        lastActivityAt: now
      });
    }
  }

  const { file, args } = resolveCommand(meta.command);
  const pty: PtyHandle = spawnPty({
    command: file,
    args,
    cwd: meta.cwd,
    cols: meta.cols,
    rows: meta.rows,
    env: { ...process.env, [SESSION_ENV_VAR]: id }
  });

  // Attach PTY listeners synchronously, before any await, so early output and a
  // fast-exiting command are never missed while metadata is being written.
  pty.onData((data) => {
    scrollback.append(data);
    broadcast(encodeFrame(FrameType.Output, data));
  });

  pty.onExit(async (exitCode) => {
    exited = true;
    exitInfo = { exitCode };
    await writeScrollback(id, scrollback.snapshot()).catch(() => undefined);
    await patchSessionMeta(id, {
      status: exitCode === 0 ? "completed" : "failed",
      priorityReason: exitCode === 0 ? "completed" : "failed",
      completedAt: new Date().toISOString(),
      exitCode,
      lastActivityAt: new Date().toISOString()
    }).catch(() => undefined);
    broadcast(encodeJsonFrame(FrameType.Exit, { exitCode }));
    for (const client of clients) {
      client.end();
    }
    resolveExit?.();
  });

  await patchSessionMeta(id, { status: "running", priorityReason: "running", daemonPid: pty.pid });

  const server: Server = createServer((socket) => {
    clients.add(socket);
    socket.write(encodeFrame(FrameType.Replay, scrollback.snapshot()));
    socket.write(encodeJsonFrame(FrameType.PtySize, { cols: appliedCols, rows: appliedRows }));
    if (exited && exitInfo) {
      socket.write(encodeJsonFrame(FrameType.Exit, exitInfo));
      socket.end();
      clients.delete(socket);
      return;
    }

    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === FrameType.Input) {
          pty.write(frame.payload.toString("utf8"));
        } else if (frame.type === FrameType.Resize) {
          const size = parseJsonPayload<ResizePayload>(frame.payload);
          applyResize(size);
        } else if (frame.type === FrameType.Attention) {
          applyAttention(parseJsonPayload<AttentionPayload>(frame.payload));
        }
      }
    });
    socket.on("error", () => {
      clients.delete(socket);
    });
    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  await listen(server, meta.socketPath);

  const shutdown = (): void => {
    if (!exited) {
      pty.kill();
    }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  if (!exited) {
    await new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupSocket(meta.socketPath);
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await cleanupSocket(socketPath);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function cleanupSocket(socketPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await rm(socketPath, { force: true }).catch(() => undefined);
}
