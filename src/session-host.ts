/**
 * Unified session host — owns the PTY, IPC socket, scrollback, attention
 * detection, AND the local terminal I/O in a single process. Replaces the
 * separate daemon process + socket-based local attach.
 *
 * The IPC socket is still exposed for the dashboard server and browser viewers
 * to connect to (same framing protocol as before).
 */
import { createServer, type Server, type Socket } from "node:net";
import { unwatchFile, watchFile } from "node:fs";
import { Buffer } from "node:buffer";
import { Terminal } from "@xterm/headless";
import { getSessionMetaPath, loadConfig, NEST_LEVEL_ENV_VAR, SESSION_ENV_VAR } from "./config.js";
import {
  encodeFrame,
  encodeJsonFrame,
  FrameDecoder,
  FrameType,
  parseJsonPayload,
  type ResizePayload,
  type AttentionPayload,
  type TerminalModePayload,
  type TerminalResizeMode,
  type TerminalWarningPayload
} from "./ipc/frame.js";
import { spawnPty, resolveCommand, type PtyHandle } from "./pty.js";
import { ScrollbackBuffer } from "./daemon/buffer.js";
import { ScreenIdleDetector } from "./daemon/idle-detector.js";
import { clampResize, revertSize, shouldApplyUserAttentionAcknowledgement } from "./daemon/daemon.js";
import { patchSessionMeta, patchSessionMetaFromCurrent, readSessionMeta, writeScrollback } from "./store.js";
import { cleanupSessionSocket, listenOnSessionSocket } from "./session-socket.js";
import type { SessionMeta } from "./types.js";


export interface SessionHostOptions {
  /** If true, no local terminal attach (background session). */
  headless?: boolean;
}

/**
 * Runs a session in-process: spawns the PTY, starts the IPC socket server for
 * dashboard clients, and (unless headless) relays local stdin/stdout directly.
 * Returns the PTY exit code when the command finishes.
 */
export async function runSessionHost(id: string, meta: SessionMeta, options: SessionHostOptions = {}): Promise<number> {
  const config = await loadConfig();
  const scrollback = new ScrollbackBuffer();
  const clients = new Set<Socket>();
  const hosts = new Set<Socket>();
  const viewers = new Set<Socket>();

  const clampBrowserToHost = config.terminal.clampBrowserToHost;
  let terminalMode: TerminalResizeMode = clampBrowserToHost ? "clamped" : "fill";
  const setTitle = config.terminal.setTitle;
  let currentName = meta.name ?? "";
  let hostCols = meta.cols;
  let hostRows = meta.rows;
  let appliedCols = meta.cols;
  let appliedRows = meta.rows;

  let lastAttentionState: boolean | undefined;
  let currentAttentionMatchedAt: string | undefined;
  let currentAttentionFingerprint: string | undefined;
  const warnedHosts = new Set<Socket>();
  let hostWarningActive = false;
  let exited = false;
  let exitInfo: { exitCode: number } | undefined;
  let resolveExit: ((code: number) => void) | undefined;

  const headlessTerm = new Terminal({
    cols: Math.max(appliedCols, 1),
    rows: Math.max(appliedRows, 1),
    allowProposedApi: true
  });
  const idleDetector = new ScreenIdleDetector(config.attention.idleSeconds);
  const idleEnabled = config.attention.idleSeconds > 0;

  function fingerprint(): string {
    const buffer = headlessTerm.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < headlessTerm.rows; i++) {
      lines.push((buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "").trimEnd());
    }
    return `${headlessTerm.cols}x${headlessTerm.rows}\n${lines.join("\n")}`;
  }

  function broadcast(frame: Buffer): void {
    for (const client of clients) {
      client.write(frame);
    }
  }

  function broadcastTerminalMode(): void {
    broadcast(encodeJsonFrame(FrameType.TerminalMode, { mode: terminalMode } satisfies TerminalModePayload));
  }

  function writeHostWarning(payload: TerminalWarningPayload): void {
    const frame = encodeJsonFrame(FrameType.TerminalWarning, payload);
    for (const host of hosts) {
      if (!warnedHosts.has(host)) {
        host.write(frame);
        warnedHosts.add(host);
      }
    }
  }

  function overgrownWarningPayload(): TerminalWarningPayload | null {
    const overgrown =
      terminalMode === "fill" &&
      hosts.size > 0 &&
      (appliedCols > Math.max(hostCols, 1) || appliedRows > Math.max(hostRows, 1));
    if (!overgrown) return null;
    return {
      kind: "overgrown",
      cols: appliedCols,
      rows: appliedRows,
      hostCols: Math.max(hostCols, 1),
      hostRows: Math.max(hostRows, 1)
    };
  }

  function updateOvergrownWarning(): void {
    const payload = overgrownWarningPayload();
    if (payload) {
      writeHostWarning(payload);
      hostWarningActive = true;
    } else {
      if (hostWarningActive) {
        const frame = encodeJsonFrame(FrameType.TerminalWarning, { kind: "restored" } satisfies TerminalWarningPayload);
        for (const host of hosts) {
          host.write(frame);
        }
      }
      hostWarningActive = false;
      warnedHosts.clear();
    }
  }

  function applyTerminalMode(mode: TerminalResizeMode): void {
    const changed = mode !== terminalMode;
    terminalMode = mode;
    if (changed) broadcastTerminalMode();
    if (mode === "clamped") {
      revertToHostSize();
    } else {
      updateOvergrownWarning();
    }
  }

  function applyResize(size: ResizePayload): void {
    if (size.source === "host") {
      hostCols = Math.max(size.cols, 1);
      hostRows = Math.max(size.rows, 1);
      if (terminalMode === "fill" && viewers.size > 0) {
        updateOvergrownWarning();
        return;
      }
    }

    if (size.source !== "host" && size.mode && size.mode !== terminalMode) {
      terminalMode = size.mode;
      broadcastTerminalMode();
    }

    const { cols, rows } = clampResize(
      { ...size, mode: size.source === "host" ? undefined : terminalMode },
      { cols: hostCols, rows: hostRows },
      clampBrowserToHost
    );
    const changed = cols !== appliedCols || rows !== appliedRows;
    const clampedViewer =
      size.source !== "host" && (cols !== Math.max(size.cols, 1) || rows !== Math.max(size.rows, 1));
    appliedCols = cols;
    appliedRows = rows;
    pty.resize(cols, rows);
    if (changed) {
      headlessTerm.resize(Math.max(cols, 1), Math.max(rows, 1));
      // A viewer-driven resize reflows the screen but is not program activity;
      // re-baseline the idle detector so it does not read the reflow as a change
      // that clears an outstanding needs-attention/acknowledged state.
      idleDetector.absorbResize(fingerprint());
      void patchSessionMeta(id, { cols, rows });
      broadcast(encodeJsonFrame(FrameType.PtySize, { cols, rows }));
    } else if (clampedViewer) {
      broadcast(encodeJsonFrame(FrameType.PtySize, { cols, rows }));
    }
    updateOvergrownWarning();
  }

  function revertToHostSize(): void {
    if (exited) return;
    const target = revertSize({ cols: hostCols, rows: hostRows }, { cols: appliedCols, rows: appliedRows });
    if (!target) return;
    appliedCols = target.cols;
    appliedRows = target.rows;
    pty.resize(target.cols, target.rows);
    headlessTerm.resize(Math.max(target.cols, 1), Math.max(target.rows, 1));
    // Reverting to host size on last-viewer-disconnect also reflows the screen;
    // re-baseline so the revert is not read as activity that clears attention.
    idleDetector.absorbResize(fingerprint());
    void patchSessionMeta(id, { cols: target.cols, rows: target.rows });
    broadcast(encodeJsonFrame(FrameType.PtySize, { cols: target.cols, rows: target.rows }));
    updateOvergrownWarning();
  }

  async function applyAttention(
    payload: AttentionPayload,
    source: "detector" | "user" = "detector",
    currentFp: string = fingerprint()
  ): Promise<void> {
    if (exited) return;
    if (!payload.needsAttention) {
      if (
        source === "user" &&
        !shouldApplyUserAttentionAcknowledgement(
          lastAttentionState,
          currentAttentionMatchedAt,
          payload.attentionMatchedAt,
          currentAttentionFingerprint,
          currentFp
        )
      ) {
        return;
      }
      lastAttentionState = false;
      currentAttentionMatchedAt = undefined;
      currentAttentionFingerprint = undefined;
      const now = new Date().toISOString();
      void patchSessionMetaFromCurrent(id, (current) => ({
        status: current.status === "paused" ? "paused" : source === "user" ? "acknowledged" : "running",
        priorityReason: "running",
        attentionMatchedAt: undefined,
        attentionReason: undefined,
        lastActivityAt: now
      }));
      return;
    }
    if (lastAttentionState === payload.needsAttention) return;
    const now = new Date().toISOString();
    void patchSessionMetaFromCurrent(id, (current) => {
      if (current.status === "paused") return undefined;
      lastAttentionState = payload.needsAttention;
      currentAttentionMatchedAt = now;
      currentAttentionFingerprint = currentFp;
      return {
        status: "needs-attention",
        priorityReason: "attention",
        attentionMatchedAt: now,
        attentionReason: payload.reason,
        lastActivityAt: now
      };
    });
  }

  // --- Spawn PTY ---
  const { file, args } = resolveCommand(meta.command);
  let pty: PtyHandle;
  try {
    pty = spawnPty({
      command: file,
      args,
      cwd: meta.cwd,
      cols: meta.cols,
      rows: meta.rows,
      env: {
        ...process.env,
        [SESSION_ENV_VAR]: id,
        [NEST_LEVEL_ENV_VAR]: String((parseInt(process.env[NEST_LEVEL_ENV_VAR] ?? "0", 10) || 0) + 1)
      }
    });
  } catch (error) {
    const now = new Date().toISOString();
    await patchSessionMeta(id, {
      status: "failed",
      priorityReason: "failed",
      completedAt: now,
      exitCode: 1,
      error: error instanceof Error ? error.message : String(error),
      lastActivityAt: now
    });
    headlessTerm.dispose();
    return 1;
  }

  // --- PTY event handlers ---
  pty.onData((data) => {
    scrollback.append(data);
    headlessTerm.write(data);
    broadcast(encodeFrame(FrameType.Output, data));
    // Write directly to local stdout (unless headless)
    if (!options.headless) {
      process.stdout.write(data);
    }
  });

  const idleTimer = idleEnabled
    ? setInterval(() => {
        const currentFp = fingerprint();
        const transition = idleDetector.update(currentFp, Date.now());
        if (transition) {
          void applyAttention(transition, "detector", currentFp);
        }
      }, 1000)
    : undefined;
  idleTimer?.unref?.();

  pty.onExit(async (exitCode) => {
    exited = true;
    exitInfo = { exitCode };
    if (idleTimer) clearInterval(idleTimer);
    headlessTerm.dispose();
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
      client.destroy();
    }
    resolveExit?.(exitCode);
  });

  await patchSessionMetaFromCurrent(id, (current) =>
    current.status === "paused"
      ? { daemonPid: pty.pid, priorityReason: "running" }
      : { status: "running", priorityReason: "running", daemonPid: pty.pid }
  );

  // --- IPC socket server (for dashboard/browser viewers) ---
  const server: Server = createServer((socket) => {
    let initialized = false;
    const initialFramesTimer = setTimeout(writeInitialFrames, 10);

    function writeInitialFrames(): void {
      if (initialized) return;
      initialized = true;
      clearTimeout(initialFramesTimer);
      clients.add(socket);
      socket.write(encodeJsonFrame(FrameType.PtySize, { cols: appliedCols, rows: appliedRows }));
      socket.write(encodeJsonFrame(FrameType.TerminalMode, { mode: terminalMode } satisfies TerminalModePayload));
      updateOvergrownWarning();
      socket.write(encodeFrame(FrameType.Replay, scrollback.snapshot()));
      if (exited && exitInfo) {
        socket.write(encodeJsonFrame(FrameType.Exit, exitInfo));
        socket.end();
        clients.delete(socket);
        return;
      }
      if (setTitle && currentName.length > 0) {
        socket.write(encodeJsonFrame(FrameType.Title, { name: currentName }));
      }
    }

    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === FrameType.Input) {
          void applyAttention({ needsAttention: false, reason: "input" }, "user");
          pty.write(frame.payload.toString("utf8"));
        } else if (frame.type === FrameType.Resize) {
          const size = parseJsonPayload<ResizePayload>(frame.payload);
          if (size.source === "host") {
            hosts.add(socket);
          } else {
            viewers.add(socket);
          }
          applyResize(size);
          writeInitialFrames();
        } else if (frame.type === FrameType.TerminalMode) {
          const mode = parseJsonPayload<TerminalModePayload>(frame.payload).mode;
          if (mode === "clamped" || mode === "fill") {
            applyTerminalMode(mode);
          }
          writeInitialFrames();
        } else if (frame.type === FrameType.Attention) {
          void applyAttention(parseJsonPayload<AttentionPayload>(frame.payload), "user");
          writeInitialFrames();
        }
      }
    });
    socket.on("error", () => {
      clients.delete(socket);
      hosts.delete(socket);
      warnedHosts.delete(socket);
      updateOvergrownWarning();
    });
    socket.on("close", () => {
      clients.delete(socket);
      hosts.delete(socket);
      warnedHosts.delete(socket);
      updateOvergrownWarning();
      if (viewers.delete(socket) && viewers.size === 0) {
        const initialMode: TerminalResizeMode = clampBrowserToHost ? "clamped" : "fill";
        if (terminalMode !== initialMode) {
          terminalMode = initialMode;
          broadcastTerminalMode();
        }
        revertToHostSize();
      }
    });
  });

  meta.socketPath = await listenOnSessionSocket(server, meta.socketPath);
  await patchSessionMeta(id, { socketPath: meta.socketPath });

  // Watch for name changes from the dashboard
  const metaPath = getSessionMetaPath(id);
  if (setTitle) {
    watchFile(metaPath, { interval: 1000 }, () => {
      void readSessionMeta(id)
        .then((fresh) => {
          if (!fresh) return;
          const newName = fresh.name ?? "";
          if (newName !== currentName) {
            currentName = newName;
            broadcast(encodeJsonFrame(FrameType.Title, { name: newName }));
            // Also update terminal title for local terminal
            if (!options.headless) {
              process.stdout.write(`\x1b]0;${newName}\x07`);
            }
          }
        })
        .catch(() => undefined);
    });
  }

  // --- Local terminal I/O (unless headless) ---
  let onStdin: ((chunk: Buffer) => void) | undefined;
  let onResize: (() => void) | undefined;

  if (!options.headless && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    onStdin = (chunk: Buffer): void => {
      if (!exited) {
        pty.write(chunk.toString("utf8"));
      }
    };
    process.stdin.on("data", onStdin);

    onResize = (): void => {
      const cols = process.stdout.columns ?? 80;
      const rows = process.stdout.rows ?? 24;
      applyResize({ cols, rows, source: "host" });
    };
    process.stdout.on("resize", onResize);
  }

  // --- Signal handling ---
  const shutdown = (): void => {
    if (!exited) {
      pty.kill();
    }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // --- Wait for exit ---
  const exitCode = await new Promise<number>((resolve) => {
    if (exited && exitInfo) {
      resolve(exitInfo.exitCode);
    } else {
      resolveExit = resolve;
    }
  });

  // --- Cleanup ---
  process.removeListener("SIGTERM", shutdown);
  process.removeListener("SIGINT", shutdown);

  if (onStdin) {
    process.stdin.removeListener("data", onStdin);
  }
  if (onResize) {
    process.stdout.removeListener("resize", onResize);
  }
  if (!options.headless && process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  if (setTitle) {
    unwatchFile(metaPath);
  }
  for (const client of clients) {
    client.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupSessionSocket(meta.socketPath);

  return exitCode;
}


