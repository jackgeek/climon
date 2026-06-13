import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { makeStyles } from "@fluentui/react-components";
import { Terminal, type ITerminalAddon } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { SessionMeta } from "../../types.js";
import type { TerminalResizeMode } from "../../ipc/frame.js";
import {
  attachKey,
  attachSocketUrl,
  attentionAckMessage,
  canSendAttentionAck,
  fetchScrollback,
  isLiveStatus
} from "../api.js";
import { flushQueuedViewMode, sendViewModeOrQueue, type QueuedViewMode } from "../view-mode.js";
import { ANSI_HIGHLIGHT_CSS } from "../colors.js";
import { ACTIVE_SESSION_COLOR_ACCENT_WIDTH } from "../layout.js";
import { DEFAULT_FONT_SIZE } from "../fontSize.js";

interface FocusableTerminal {
  focus: () => void;
}

interface RefreshableTerminal {
  rows: number;
  clearTextureAtlas: () => void;
  refresh: (start: number, end: number) => void;
}

interface ResizableTerminal {
  cols: number;
  rows: number;
  resize: (cols: number, rows: number) => void;
}

interface ResettableTerminal extends ResizableTerminal {
  reset: () => void;
}

interface RefitSessionState {
  status: SessionMeta["status"];
}

interface FontResizableTerminal extends RefreshableTerminal {
  options: {
    fontSize?: number;
  };
}

interface ScrollbackConfigurableTerminal {
  options: {
    scrollback?: number;
  };
}

const TERMINAL_SCROLLBACK = 10_000;
const WHEEL_PIXEL_LINE_HEIGHT = 20;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5_000;

export const terminalOptions = {
  allowProposedApi: true,
  cursorBlink: true,
  fontFamily: "ui-monospace, monospace",
  fontSize: DEFAULT_FONT_SIZE,
  scrollback: TERMINAL_SCROLLBACK,
  theme: { background: "#0d1117" }
} as const;

export function applyTerminalScrollbackForSession(
  term: ScrollbackConfigurableTerminal,
  _session: RefitSessionState | null
): void {
  term.options.scrollback = TERMINAL_SCROLLBACK;
}

export function refreshTerminalRender(term: RefreshableTerminal | null): void {
  if (!term) {
    return;
  }
  term.clearTextureAtlas();
  term.refresh(0, Math.max(term.rows - 1, 0));
}

export function focusTerminalPane(term: FocusableTerminal | null, onFocused?: () => void): void {
  if (!term) {
    return;
  }
  term.focus();
  onFocused?.();
}

export function mapWheelToScrollLines(event: Pick<WheelEvent, "deltaY" | "deltaMode">, rows: number): number {
  if (event.deltaY === 0) {
    return 0;
  }
  const direction = Math.sign(event.deltaY);
  const magnitude =
    event.deltaMode === DOM_DELTA_PAGE
      ? Math.max(1, rows - 1)
      : event.deltaMode === DOM_DELTA_LINE
        ? Math.max(1, Math.ceil(Math.abs(event.deltaY)))
        : Math.max(1, Math.ceil(Math.abs(event.deltaY) / WHEEL_PIXEL_LINE_HEIGHT));
  return direction * magnitude;
}

export function shouldHandleWheelAsScrollback(state: {
  mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any";
  activeBufferBaseY: number;
}): boolean {
  return state.mouseTrackingMode === "none" && state.activeBufferBaseY > 0;
}

export function applyAuthoritativeTerminalSize(
  term: ResizableTerminal,
  cols: number,
  rows: number
): void {
  if (term.cols === cols && term.rows === rows) {
    return;
  }
  try {
    term.resize(cols, rows);
  } catch {
    // Ignore invalid sizes.
  }
}

export function resetTerminalForSession(term: ResettableTerminal, session: { cols: number; rows: number } | null): void {
  if (session) {
    applyAuthoritativeTerminalSize(term, session.cols, session.rows);
  }
  term.reset();
}

export function canRefitTerminalForSession(
  session: RefitSessionState | null,
  initialReplayComplete: boolean,
  visible = true
): boolean {
  if (!visible) {
    return false;
  }
  if (!session) {
    return true;
  }
  return isLiveStatus(session.status) && initialReplayComplete;
}

export function completeInitialReplay(
  replayGeneration: number,
  currentGeneration: number,
  markComplete: () => void,
  refit: () => void
): void {
  if (replayGeneration !== currentGeneration) {
    return;
  }
  markComplete();
  refit();
}

export function reconnectDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** normalizedAttempt);
}

export function shouldReconnectLiveAttachment(state: {
  session: Pick<SessionMeta, "id" | "status"> | null | undefined;
  sessionId: string;
  attachmentGeneration: number;
  currentGeneration: number;
  visible: boolean;
}): boolean {
  const session = state.session;
  return (
    state.attachmentGeneration === state.currentGeneration &&
    state.visible &&
    !!session &&
    session.id === state.sessionId &&
    isLiveStatus(session.status)
  );
}

export function applyTerminalFontSize(term: FontResizableTerminal, fontSize: number, refit: () => void): void {
  term.options.fontSize = fontSize;
  refreshTerminalRender(term);
  refit();
}

export function loadTerminalAddons(
  term: Pick<Terminal, "loadAddon">,
  fit: ITerminalAddon,
  webLinks: ITerminalAddon
): void {
  term.loadAddon(fit);
  term.loadAddon(webLinks);
}

export interface TerminalHandle {
  getDimensions: () => { cols: number; rows: number } | null;
  refit: () => void;
  sendInput: (data: string) => void;
  setViewMode: (mode: TerminalResizeMode) => void;
  acknowledgeAttention: (sessionId: string, attentionMatchedAt: string) => void;
  focus: () => void;
}

const useStyles = makeStyles({
  root: {
    flex: "1 1 auto",
    minHeight: 0,
    padding: "8px",
    backgroundColor: "#0d1117",
    "& .xterm-viewport": {
      scrollbarWidth: "none",
      msOverflowStyle: "none"
    },
    "& .xterm-viewport::-webkit-scrollbar": {
      display: "none"
    }
  }
});

interface Props {
  session: SessionMeta | null;
  accentColor?: SessionMeta["color"];
  maximized: boolean;
  visible: boolean;
  viewMode: TerminalResizeMode;
  onViewModeChange: (mode: TerminalResizeMode) => void;
  fontSize: number;
  onFontSizeChange: (delta: number) => void;
}

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  { session, accentColor, maximized, visible, viewMode, onViewModeChange, fontSize, onFontSizeChange },
  ref
) {
  const styles = useStyles();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const attachedSessionIdRef = useRef<string | null>(null);
  const viewModeRef = useRef<TerminalResizeMode>(viewMode);
  const onViewModeChangeRef = useRef(onViewModeChange);
  const fontSizeRef = useRef(fontSize);
  const onFontSizeChangeRef = useRef(onFontSizeChange);
  const queuedViewModeRef = useRef<TerminalResizeMode | null>(null);
  const queuedAttentionAckRef = useRef<{ sessionId: string; attentionMatchedAt: string } | null>(null);
  const selectedSessionRef = useRef<SessionMeta | null>(session);
  const visibleRef = useRef(visible);
  const initialReplayCompleteRef = useRef(true);
  const attachmentGenerationRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);

  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  useEffect(() => {
    selectedSessionRef.current = session;
    visibleRef.current = visible;
  }, [session, visible]);

  useEffect(() => {
    onViewModeChangeRef.current = onViewModeChange;
  }, [onViewModeChange]);

  useEffect(() => {
    onFontSizeChangeRef.current = onFontSizeChange;
  }, [onFontSizeChange]);

  // Apply font-size changes driven from App state (panel buttons or the
  // Ctrl +/- shortcut, which both flow through App as the single source of
  // truth). Refit so the grid reflows to the new cell size.
  useEffect(() => {
    const term = termRef.current;
    if (!term || fontSizeRef.current === fontSize) {
      return;
    }
    fontSizeRef.current = fontSize;
    applyTerminalFontSize(term, fontSize, refit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize]);

  // A queued view-mode request belongs to the session that was attached when it
  // was queued. Drop it when the session changes so it can never flush to a
  // different session's socket.
  useEffect(() => {
    queuedViewModeRef.current = null;
  }, [session?.id]);

  function sendResize(): void {
    const term = termRef.current;
    const ws = wsRef.current;
    if (term && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  }

  function sendMode(mode: TerminalResizeMode): void {
    sendViewModeOrQueue(wsRef.current, mode, queuedViewModeRef as QueuedViewMode);
  }

  function sendAttentionAck(sessionId: string, attentionMatchedAt: string): void {
    const ws = wsRef.current;
    if (ws && canSendAttentionAck(attachedSessionIdRef.current, sessionId, ws.readyState === WebSocket.OPEN)) {
      ws.send(attentionAckMessage(attentionMatchedAt));
    } else {
      queuedAttentionAckRef.current = { sessionId, attentionMatchedAt };
    }
  }

  function flushAttentionAck(): void {
    const ws = wsRef.current;
    const pending = queuedAttentionAckRef.current;
    if (
      !ws ||
      !pending ||
      !canSendAttentionAck(attachedSessionIdRef.current, pending.sessionId, ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }
    queuedAttentionAckRef.current = null;
    ws.send(attentionAckMessage(pending.attentionMatchedAt));
  }

  function fitNow(): void {
    if (
      !canRefitTerminalForSession(
        selectedSessionRef.current,
        initialReplayCompleteRef.current,
        visibleRef.current
      )
    ) {
      return;
    }
    try {
      fitRef.current?.fit();
      sendResize();
    } catch {
      // Fit can throw while the container has zero size (e.g. mid-layout).
    }
  }

  function refit(): void {
    // Refit after layout has settled so xterm measures the final pane size.
    requestAnimationFrame(() => {
      requestAnimationFrame(fitNow);
    });
  }

  function refreshActiveTerminal(): void {
    refreshTerminalRender(termRef.current);
    refit();
  }

  function focusActiveTerminal(): void {
    focusTerminalPane(termRef.current, refreshActiveTerminal);
  }

  function clearReconnectTimer(): void {
    if (reconnectTimerRef.current === null) {
      return;
    }
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }

  function closeWs(): void {
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;
    attachmentGenerationRef.current++;
    initialReplayCompleteRef.current = true;
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // Ignore: socket may already be closing.
      }
      wsRef.current = null;
      attachedSessionIdRef.current = null;
    }
  }

  function isCurrentAttachment(ws: WebSocket, sessionId: string, attachmentGeneration: number): boolean {
    return (
      wsRef.current === ws &&
      attachedSessionIdRef.current === sessionId &&
      attachmentGeneration === attachmentGenerationRef.current
    );
  }

  function scheduleReconnect(sessionId: string, attachmentGeneration: number): void {
    clearReconnectTimer();
    if (
      !shouldReconnectLiveAttachment({
        session: selectedSessionRef.current,
        sessionId,
        attachmentGeneration,
        currentGeneration: attachmentGenerationRef.current,
        visible: visibleRef.current
      })
    ) {
      return;
    }
    const delay = reconnectDelayMs(reconnectAttemptRef.current);
    reconnectAttemptRef.current += 1;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      const currentSession = selectedSessionRef.current;
      if (
        !currentSession ||
        !shouldReconnectLiveAttachment({
          session: currentSession,
          sessionId,
          attachmentGeneration,
          currentGeneration: attachmentGenerationRef.current,
          visible: visibleRef.current
        })
      ) {
        return;
      }
      attachLiveSession(currentSession, true);
    }, delay);
  }

  function attachLiveSession(liveSession: SessionMeta, resetBeforeReplay: boolean): void {
    clearReconnectTimer();
    attachmentGenerationRef.current++;
    const attachmentGeneration = attachmentGenerationRef.current;
    const ws = new WebSocket(attachSocketUrl(liveSession.id));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    attachedSessionIdRef.current = liveSession.id;
    initialReplayCompleteRef.current = false;

    let firstBinaryFrame = true;
    let disconnected = false;
    let terminalExitReceived = false;

    function handleDisconnect(): void {
      if (disconnected) {
        return;
      }
      disconnected = true;
      if (attachmentGeneration !== attachmentGenerationRef.current) {
        return;
      }
      if (wsRef.current === ws) {
        wsRef.current = null;
        attachedSessionIdRef.current = null;
      }
      initialReplayCompleteRef.current = true;
      if (!terminalExitReceived) {
        scheduleReconnect(liveSession.id, attachmentGeneration);
      }
    }

    ws.onopen = () => {
      if (!isCurrentAttachment(ws, liveSession.id, attachmentGeneration)) {
        return;
      }
      flushQueuedViewMode(ws, queuedViewModeRef as QueuedViewMode);
      flushAttentionAck();
    };
    ws.onmessage = (ev) => {
      if (!isCurrentAttachment(ws, liveSession.id, attachmentGeneration)) {
        return;
      }
      const term = termRef.current;
      if (!term) {
        return;
      }
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data) as {
            type: string;
            exitCode?: number;
            cols?: number;
            rows?: number;
            mode?: TerminalResizeMode;
          };
          if (msg.type === "exit") {
            terminalExitReceived = true;
            term.write(`\r\n\x1b[90m[session exited with code ${msg.exitCode}]\x1b[0m\r\n`);
          } else if (msg.type === "size" && msg.cols && msg.rows) {
            // Authoritative PTY size from the daemon: match it so both the host
            // terminal and this viewer render the same grid.
            applyAuthoritativeTerminalSize(term, msg.cols, msg.rows);
          } else if (msg.type === "mode" && (msg.mode === "clamped" || msg.mode === "fill")) {
            onViewModeChangeRef.current(msg.mode);
          }
        } catch {
          // Ignore malformed control messages.
        }
      } else {
        const data = new Uint8Array(ev.data as ArrayBuffer);
        if (initialReplayCompleteRef.current) {
          term.write(data);
        } else {
          if (firstBinaryFrame) {
            firstBinaryFrame = false;
            if (resetBeforeReplay) {
              term.reset();
            }
          }
          term.write(data, () => {
            completeInitialReplay(
              attachmentGeneration,
              attachmentGenerationRef.current,
              () => {
                initialReplayCompleteRef.current = true;
                reconnectAttemptRef.current = 0;
              },
              refreshActiveTerminal
            );
          });
        }
      }
    };
    ws.onerror = () => {
      handleDisconnect();
      try {
        ws.close();
      } catch {
        // Ignore: socket may already be closing.
      }
    };
    ws.onclose = handleDisconnect;
  }

  // Create the terminal once and wire input + resize handling.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const term = new Terminal({
      ...terminalOptions,
      fontSize: fontSizeRef.current
    });
    const fit = new FitAddon();
    const webLinks = new WebLinksAddon();
    loadTerminalAddons(term, fit, webLinks);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
    fitNow();

    const onWindowResize = (): void => fitNow();
    window.addEventListener("resize", onWindowResize);

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.ctrlKey) {
        return true;
      }
      const delta =
        event.key === "+" || event.key === "=" || event.code === "NumpadAdd"
          ? 1
          : event.key === "-" || event.code === "NumpadSubtract"
            ? -1
            : 0;
      if (delta === 0) {
        return true;
      }
      event.preventDefault();
      event.stopPropagation();
      onFontSizeChangeRef.current(delta);
      return false;
    });

    term.attachCustomWheelEventHandler((event) => {
      if (
        !shouldHandleWheelAsScrollback({
          mouseTrackingMode: term.modes.mouseTrackingMode,
          activeBufferBaseY: term.buffer.active.baseY
        })
      ) {
        return true;
      }
      const lines = mapWheelToScrollLines(event, term.rows);
      if (lines === 0) {
        return true;
      }
      event.preventDefault();
      term.scrollLines(lines);
      return false;
    });

    // Register input handling once and route to the current socket. Registering
    // this per-connection would duplicate every keystroke.
    const dataDisposable = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    return () => {
      window.removeEventListener("resize", onWindowResize);
      dataDisposable.dispose();
      closeWs();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // React to the selected session: live sessions attach over WebSocket;
  // terminated ones load their captured scrollback over HTTP.
  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    closeWs();
    initialReplayCompleteRef.current = true;
    applyTerminalScrollbackForSession(term, session);
    resetTerminalForSession(term, session);
    const attachmentGeneration = attachmentGenerationRef.current;

    if (!session) {
      return;
    }

    let cancelled = false;

    if (isLiveStatus(session.status)) {
      // Only hold the PTY (via the WebSocket) while the terminal is actually
      // displayed. When hidden, the daemon reverts the PTY to the host size.
      if (!visible) {
        return;
      }
      attachLiveSession(session, false);
    } else {
      void fetchScrollback(session.id).then((buf) => {
        if (cancelled) {
          return;
        }
        if (buf) {
          term.write(buf, () => {
            completeInitialReplay(attachmentGeneration, attachmentGenerationRef.current, () => undefined, refreshActiveTerminal);
          });
        } else {
          term.write("\x1b[90m[no output captured]\x1b[0m\r\n", () => {
            completeInitialReplay(attachmentGeneration, attachmentGenerationRef.current, () => undefined, refreshActiveTerminal);
          });
        }
      });
    }

    return () => {
      cancelled = true;
    };
    // Re-attach only when the session, its live/terminated state, or visibility
    // changes -- never on live-status idle/acknowledgement transitions, which
    // would reset the terminal and cause a periodic resize flicker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachKey(session, visible)]);

  // Refit when the selected session or layout-affecting terminal chrome changes
  // so xterm re-measures before sending geometry back to the daemon.
  useEffect(() => {
    const term = termRef.current;
    if (visible) {
      refreshTerminalRender(term);
    }
    if (canRefitTerminalForSession(session, initialReplayCompleteRef.current, visible)) {
      refit();
    }
  }, [attachKey(session, visible), accentColor, maximized, visible, viewMode]);

  useImperativeHandle(ref, () => ({
    getDimensions: () => {
      const term = termRef.current;
      return term ? { cols: term.cols, rows: term.rows } : null;
    },
    refit,
    sendInput: (data: string) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    },
    setViewMode: (mode: TerminalResizeMode) => {
      sendMode(mode);
      refit();
    },
    acknowledgeAttention: sendAttentionAck,
    focus: focusActiveTerminal
  }));

  return (
    <div
      ref={containerRef}
      className={styles.root}
      style={
        accentColor
          ? { border: `${ACTIVE_SESSION_COLOR_ACCENT_WIDTH} solid ${ANSI_HIGHLIGHT_CSS[accentColor]}` }
          : undefined
      }
      onClick={focusActiveTerminal}
      onFocusCapture={refreshActiveTerminal}
    />
  );
});
