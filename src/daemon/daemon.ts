import { createServer, type Server, type Socket } from "node:net";
import { unwatchFile, watchFile } from "node:fs";
import { Buffer } from "node:buffer";
import { Terminal } from "@xterm/headless";
import { ensureClimonHome, getSessionMetaPath, loadConfig, NEST_LEVEL_ENV_VAR, SESSION_ENV_VAR } from "../config.js";
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
} from "../ipc/frame.js";
import { spawnPty, resolveCommand, type PtyHandle } from "../pty.js";
import { ScrollbackBuffer } from "./buffer.js";
import { ScreenIdleDetector } from "./idle-detector.js";
import { patchSessionMeta, patchSessionMetaFromCurrent, readSessionMeta, writeScrollback } from "../store.js";
import { cleanupSessionSocket, listenOnSessionSocket } from "../session-socket.js";
import { initLogger, child } from "../logging/logger.js";
import { logMsg } from "../i18n/log-msg.js";
const ESC_CSI_PRIVATE_MODE_PREFIX = "\x1b[?";
const CSI_PRIVATE_MODE_CONTROL = /\x1b\[\?([0-9;]*)([hl])/g;
const INCOMPLETE_PRIVATE_MODE_SUFFIX = /\x1b\[\?[0-9;]*$/;
export const TRACKED_MOUSE_PRIVATE_MODES = ["1000", "1002", "1003", "1005", "1006", "1015"] as const;

export function trackMousePrivateModesFromOutput(
  modeState: Map<string, boolean>,
  chunk: string | Uint8Array,
  remainder = "",
  trackedModes: readonly string[] = TRACKED_MOUSE_PRIVATE_MODES
): string {
  const tracked = new Set(trackedModes);
  const chunkText = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  const input = `${remainder}${chunkText}`;
  CSI_PRIVATE_MODE_CONTROL.lastIndex = 0;
  let match: RegExpExecArray | null;
  let lastCompleteMatchEnd = 0;
  while ((match = CSI_PRIVATE_MODE_CONTROL.exec(input)) !== null) {
    const rawParams = match[1] ?? "";
    const action = match[2];
    const enabled = action === "h";
    for (const param of rawParams.split(";")) {
      if (tracked.has(param)) {
        modeState.set(param, enabled);
      }
    }
    lastCompleteMatchEnd = match.index + match[0].length;
  }
  const trailingPrefix = input.lastIndexOf(ESC_CSI_PRIVATE_MODE_PREFIX);
  if (trailingPrefix >= lastCompleteMatchEnd) {
    const trailing = input.slice(trailingPrefix);
    if (INCOMPLETE_PRIVATE_MODE_SUFFIX.test(trailing)) {
      return trailing.slice(-64);
    }
  }
  return "";
}

export function buildMousePrivateModeReplaySuffix(
  modeState: ReadonlyMap<string, boolean>,
  trackedModes: readonly string[] = TRACKED_MOUSE_PRIVATE_MODES
): Buffer {
  let suffix = "";
  for (const mode of trackedModes) {
    if (modeState.get(mode) === true) {
      suffix += `${ESC_CSI_PRIVATE_MODE_PREFIX}${mode}h`;
    }
  }
  return Buffer.from(suffix);
}

/**
 * Resolves a requested resize to the dimensions actually applied to the PTY.
 * With clamping enabled, a viewer (browser) request is capped to the host
 * terminal's size so the non-reflowing local terminal is never overgrown. Host
 * requests and the unclamped case pass through (floored at 1x1).
 */
export function clampResize(
  request: { cols: number; rows: number; source?: "host" | "viewer"; mode?: TerminalResizeMode },
  host: { cols: number; rows: number },
  clampBrowserToHost: boolean
): { cols: number; rows: number } {
  const cols = Math.max(request.cols, 1);
  const rows = Math.max(request.rows, 1);
  if (clampBrowserToHost && request.source !== "host" && request.mode !== "fill") {
    return {
      cols: Math.min(cols, Math.max(host.cols, 1)),
      rows: Math.min(rows, Math.max(host.rows, 1))
    };
  }
  return { cols, rows };
}

/**
 * Resolves the size to restore when the last browser viewer disconnects. The
 * PTY returns to the host terminal's dimensions (floored at 1x1). Returns null
 * when the applied size already matches the host, so callers can skip a no-op
 * resize and broadcast.
 */
export function revertSize(
  host: { cols: number; rows: number },
  applied: { cols: number; rows: number }
): { cols: number; rows: number } | null {
  const cols = Math.max(host.cols, 1);
  const rows = Math.max(host.rows, 1);
  if (cols === applied.cols && rows === applied.rows) {
    return null;
  }
  return { cols, rows };
}

/**
 * Extracts the dimension header from a fingerprint string. Returns undefined if
 * the fingerprint does not contain a dimension prefix (legacy format).
 */
function fingerprintDimensions(fp: string): string | undefined {
  const nl = fp.indexOf("\n");
  if (nl === -1) {
    return undefined;
  }
  const header = fp.slice(0, nl);
  return header.includes("x") ? header : undefined;
}

export function shouldApplyUserAttentionAcknowledgement(
  lastAttentionState: boolean | undefined,
  currentAttentionMatchedAt: string | undefined,
  acknowledgedAttentionMatchedAt: string | undefined,
  attentionFingerprint: string | undefined,
  currentFingerprint: string
): boolean {
  if (
    lastAttentionState !== true ||
    currentAttentionMatchedAt === undefined ||
    acknowledgedAttentionMatchedAt !== currentAttentionMatchedAt ||
    attentionFingerprint === undefined
  ) {
    return false;
  }
  // If dimensions differ the screen was reflowed by a resize — the content
  // comparison is meaningless so we allow the acknowledgement through.
  const attDims = fingerprintDimensions(attentionFingerprint);
  const curDims = fingerprintDimensions(currentFingerprint);
  if (attDims !== undefined && curDims !== undefined && attDims !== curDims) {
    return true;
  }
  return currentFingerprint === attentionFingerprint;
}

export async function runSessionDaemon(id: string): Promise<void> {
  initLogger("daemon", { sessionId: id });
  const statusLog = child("status");
  await ensureClimonHome();
  const config = await loadConfig();
  const meta = await readSessionMeta(id);
  if (!meta) {
    throw new Error(`Session metadata for '${id}' not found.`);
  }

  const scrollback = new ScrollbackBuffer();
  const mousePrivateModeState = new Map<string, boolean>();
  let mousePrivateModeRemainder = "";
  const clients = new Set<Socket>();
  const hosts = new Set<Socket>();
  // Sockets that have acted as browser viewers (sent a non-host Resize). When
  // the last one disconnects, the PTY reverts to the host terminal's size so a
  // still-attached host terminal is not left rendering into a shrunken grid.
  const viewers = new Set<Socket>();

  const clampBrowserToHost = config.terminal.clampBrowserToHost;
  let terminalMode: TerminalResizeMode = clampBrowserToHost ? "clamped" : "fill";
  const setTitle = config.terminal.setTitle;
  // The name currently reflected as the terminal title. Re-read from meta on
  // change so a dashboard rename propagates to attached terminals.
  let currentName = meta.name ?? "";
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
  let currentAttentionMatchedAt: string | undefined;
  let currentAttentionFingerprint: string | undefined;
  const warnedHosts = new Set<Socket>();
  let hostWarningActive = false;
  let exited = false;
  let exitInfo: { exitCode: number } | undefined;
  let resolveExit: (() => void) | undefined;

  // The daemon owns the PTY, so it runs static-screen attention detection
  // itself: PTY output is mirrored into a headless terminal grid whose
  // fingerprint is sampled on an interval. This works for every session,
  // including headless ones that have no interactive client attached.
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
    if (!overgrown) {
      return null;
    }
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
    if (changed) {
      broadcastTerminalMode();
    }
    if (mode === "clamped") {
      revertToHostSize();
    } else {
      updateOvergrownWarning();
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

  /**
   * Restores the PTY to the host terminal's dimensions. Called when the last
   * browser viewer disconnects. No-op after the PTY exits or when the applied
   * size already matches the host.
   */
  function revertToHostSize(): void {
    if (exited) {
      return;
    }
    const target = revertSize({ cols: hostCols, rows: hostRows }, { cols: appliedCols, rows: appliedRows });
    if (!target) {
      return;
    }
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

  /**
   * Applies an attention transition from the idle detector. The daemon is the
   * only writer of session metadata, so detection state funnels through here.
   * Transitions are de-duped against the last applied value and ignored after
   * the PTY exits so the completed/failed patch always wins.
   */
  async function applyAttention(
    payload: AttentionPayload,
    source: "detector" | "user" = "detector",
    currentFingerprint: string = fingerprint()
  ): Promise<void> {
    if (exited) {
      return;
    }
    if (!payload.needsAttention) {
      if (
        source === "user" &&
        !shouldApplyUserAttentionAcknowledgement(
          lastAttentionState,
          currentAttentionMatchedAt,
          payload.attentionMatchedAt,
          currentAttentionFingerprint,
          currentFingerprint
        )
      ) {
        return;
      }
      const prevAttentionFp = currentAttentionFingerprint;
      const fpMatch = prevAttentionFp === currentFingerprint;
      lastAttentionState = false;
      currentAttentionMatchedAt = undefined;
      currentAttentionFingerprint = undefined;
      const now = new Date().toISOString();
      logMsg(statusLog, "debug", "daemon.clearing_attention_status", { source, fingerprint: fpMatch ? "unchanged" : "changed" });
      if (!fpMatch) {
        logMsg(statusLog, "trace", "daemon.attention_fingerprint_mismatch", { attentionFp: JSON.stringify(prevAttentionFp), currentFp: JSON.stringify(currentFingerprint) });
      }
      void patchSessionMetaFromCurrent(id, (current) => ({
        status: current.status === "paused" ? "paused" : source === "user" ? "acknowledged" : "running",
        priorityReason: "running",
        attentionMatchedAt: undefined,
        attentionReason: undefined,
        lastActivityAt: now
      }));
      return;
    }
    if (lastAttentionState === payload.needsAttention) {
      return;
    }
    const now = new Date().toISOString();
    logMsg(statusLog, "debug", "daemon.needs_attention_status", { reason: payload.reason, fingerprint: JSON.stringify(currentFingerprint) });
    void patchSessionMetaFromCurrent(id, (current) => {
      if (current.status === "paused") {
        return undefined;
      }
      lastAttentionState = payload.needsAttention;
      currentAttentionMatchedAt = now;
      currentAttentionFingerprint = currentFingerprint;
      return {
        status: "needs-attention",
        priorityReason: "attention",
        attentionMatchedAt: now,
        attentionReason: payload.reason,
        lastActivityAt: now
      };
    });
  }

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
    return;
  }

  function replaySnapshot(): Buffer {
    const snapshot = scrollback.snapshot();
    const mouseModeSuffix = buildMousePrivateModeReplaySuffix(mousePrivateModeState);
    return mouseModeSuffix.length > 0 ? Buffer.concat([snapshot, mouseModeSuffix]) : snapshot;
  }

  // Attach PTY listeners synchronously, before any await, so early output and a
  // fast-exiting command are never missed while metadata is being written.
  pty.onData((data) => {
    mousePrivateModeRemainder = trackMousePrivateModesFromOutput(
      mousePrivateModeState,
      data,
      mousePrivateModeRemainder
    );
    scrollback.append(data);
    headlessTerm.write(data);
    broadcast(encodeFrame(FrameType.Output, data));
  });

  // Sample the rendered screen once a second; a fingerprint unchanged for
  // `idleSeconds` flips the session to "needs-attention" (and back when output
  // resumes). Disabled when idle detection is turned off (idleSeconds <= 0).
  let lastSampledFingerprint: string | undefined;
  const idleTimer = idleEnabled
    ? setInterval(() => {
        const currentFingerprint = fingerprint();
        const fpChanged = lastSampledFingerprint !== undefined && currentFingerprint !== lastSampledFingerprint;
        const transition = idleDetector.update(currentFingerprint, Date.now());
        if (transition) {
          const newStatus = transition.needsAttention ? "needs-attention" : "running";
          if (fpChanged) {
            logMsg(statusLog, "trace", "daemon.sampled_fingerprint_changed", { status: newStatus, prev: JSON.stringify(lastSampledFingerprint), curr: JSON.stringify(currentFingerprint) });
          } else {
            logMsg(statusLog, "debug", "daemon.sampled_fingerprint_unchanged", { status: newStatus });
          }
          void applyAttention(transition, "detector", currentFingerprint);
        }
        lastSampledFingerprint = currentFingerprint;
      }, 1000)
    : undefined;
  idleTimer?.unref?.();

  pty.onExit(async (exitCode) => {
    exited = true;
    exitInfo = { exitCode };
    if (idleTimer) {
      clearInterval(idleTimer);
    }
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
    resolveExit?.();
  });

  await patchSessionMetaFromCurrent(id, (current) =>
    current.status === "paused"
      ? { daemonPid: pty.pid, priorityReason: "running" }
      : { status: "running", priorityReason: "running", daemonPid: pty.pid }
  );

  const server: Server = createServer((socket) => {
    let initialized = false;
    const initialFramesTimer = setTimeout(writeInitialFrames, 10);

    function writeReplay(): void {
      socket.write(encodeJsonFrame(FrameType.PtySize, { cols: appliedCols, rows: appliedRows }));
      socket.write(encodeJsonFrame(FrameType.TerminalMode, { mode: terminalMode } satisfies TerminalModePayload));
      socket.write(encodeFrame(FrameType.Replay, replaySnapshot()));
    }

    function writeInitialFrames(): void {
      if (initialized) {
        return;
      }
      initialized = true;
      clearTimeout(initialFramesTimer);
      clients.add(socket);
      writeReplay();
      updateOvergrownWarning();
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
        } else if (frame.type === FrameType.Replay) {
          writeReplay();
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
        // Reset the terminal mode to its initial value so the host terminal
        // is no longer constrained by a viewer that is gone.  Without this,
        // `terminalMode` would remain "fill" after an unclamp→disconnect
        // sequence and the PTY would stay at the viewer's last viewport size
        // instead of reverting to the host terminal's dimensions.
        const initialMode: TerminalResizeMode = clampBrowserToHost ? "clamped" : "fill";
        if (terminalMode !== initialMode) {
          terminalMode = initialMode;
          broadcastTerminalMode();
        }
        revertToHostSize();
      }
    });
  });

  meta.socketPath = await listen(server, meta.socketPath);
  await patchSessionMeta(id, { socketPath: meta.socketPath });

  const metaPath = getSessionMetaPath(id);
  if (setTitle) {
    // Poll this session's meta file (robust to atomic write-then-rename, and it
    // only watches our own file — no fanout across other sessions). A rename
    // from the dashboard rebroadcasts the new title; the daemon's own frequent
    // non-name patches are filtered out by the name comparison.
    watchFile(metaPath, { interval: 1000 }, () => {
      void readSessionMeta(id)
        .then((fresh) => {
          if (!fresh) {
            return;
          }
          const newName = fresh.name ?? "";
          if (newName !== currentName) {
            currentName = newName;
            broadcast(encodeJsonFrame(FrameType.Title, { name: newName }));
          }
        })
        .catch(() => undefined);
    });
  }

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

  if (setTitle) {
    unwatchFile(metaPath);
  }
  // Force-destroy any sockets that survived the onExit handler (e.g., clients
  // that connected after exit was broadcast but before the server closed).
  for (const client of clients) {
    client.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupSocket(meta.socketPath);

  // Safety net: force-exit after a short grace period in case leaked handles
  // (e.g., Bun's ConPTY internals on Windows) keep the event loop alive.
  setTimeout(() => process.exit(0), 2000).unref();
}

async function listen(server: Server, socketPath: string): Promise<string> {
  return await listenOnSessionSocket(server, socketPath);
}

async function cleanupSocket(socketPath: string): Promise<void> {
  await cleanupSessionSocket(socketPath);
}
