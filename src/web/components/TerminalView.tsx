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

interface FocusableTerminal {
  focus: () => void;
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

interface FontResizableTerminal {
  options: {
    fontSize?: number;
  };
  rows: number;
  clearTextureAtlas: () => void;
  refresh: (start: number, end: number) => void;
}

interface ScrollbackConfigurableTerminal {
  options: {
    scrollback?: number;
  };
}

const TERMINAL_SCROLLBACK = 10_000;

export const terminalOptions = {
  allowProposedApi: true,
  cursorBlink: true,
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
  scrollback: TERMINAL_SCROLLBACK,
  theme: { background: "#0d1117" }
} as const;

export function applyTerminalScrollbackForSession(
  term: ScrollbackConfigurableTerminal,
  _session: RefitSessionState | null
): void {
  term.options.scrollback = TERMINAL_SCROLLBACK;
}

export function focusTerminalPane(term: FocusableTerminal | null): void {
  term?.focus();
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

export function applyTerminalFontSize(term: FontResizableTerminal, fontSize: number, refit: () => void): void {
  term.options.fontSize = fontSize;
  term.clearTextureAtlas();
  term.refresh(0, Math.max(term.rows - 1, 0));
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

export interface TouchScrollState {
  active: boolean;
  lastY: number;
}

export interface TouchScrollMove {
  state: TouchScrollState;
  deltaY: number;
}

// Arm the gesture only for single-finger drags so multi-touch (e.g. pinch-zoom)
// is left entirely to the browser.
export function startTouchScroll(touchCount: number, clientY: number): TouchScrollState {
  return { active: touchCount === 1, lastY: clientY };
}

// Translate a single-finger drag into a mouse-wheel delta. deltaY mirrors the
// wheel convention: dragging the finger up (content moves up) scrolls toward
// newer output (positive), dragging down scrolls toward older history (negative).
export function moveTouchScroll(
  prev: TouchScrollState,
  touchCount: number,
  clientY: number
): TouchScrollMove {
  if (!prev.active || touchCount !== 1) {
    return { state: { active: false, lastY: clientY }, deltaY: 0 };
  }
  return { state: { active: true, lastY: clientY }, deltaY: prev.lastY - clientY };
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
}

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  { session, accentColor, maximized, visible, viewMode, onViewModeChange },
  ref
) {
  const styles = useStyles();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const touchScrollRef = useRef<TouchScrollState>({ active: false, lastY: 0 });
  const wsRef = useRef<WebSocket | null>(null);
  const attachedSessionIdRef = useRef<string | null>(null);
  const viewModeRef = useRef<TerminalResizeMode>(viewMode);
  const onViewModeChangeRef = useRef(onViewModeChange);
  const fontSizeRef = useRef(13);
  const queuedViewModeRef = useRef<TerminalResizeMode | null>(null);
  const queuedAttentionAckRef = useRef<{ sessionId: string; attentionMatchedAt: string } | null>(null);
  const selectedSessionRef = useRef<SessionMeta | null>(session);
  const visibleRef = useRef(visible);
  const initialReplayCompleteRef = useRef(true);
  const attachmentGenerationRef = useRef(0);

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

  function closeWs(): void {
    attachmentGenerationRef.current++;
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

    // Translate one-finger touch drags into synthetic wheel events so mobile
    // viewers can scroll like a mouse wheel. xterm's own wheel handling then
    // scrolls local scrollback (normal buffer) or forwards wheel->mouse events
    // to the app (mouse reporting active). Capture-phase touchmove runs before
    // xterm's own touch listeners; we always stopPropagation (so xterm's native
    // touch-scroll never double-handles) and preventDefault only while armed
    // (suppresses the browser's pull-to-refresh over the terminal without
    // blocking multi-touch pinch-zoom). The listener is non-passive so
    // preventDefault is honored.
    const onTouchStart = (e: TouchEvent): void => {
      const touch = e.touches[0];
      if (!touch) {
        return;
      }
      touchScrollRef.current = startTouchScroll(e.touches.length, touch.clientY);
    };
    const onTouchMove = (e: TouchEvent): void => {
      const touch = e.touches[0];
      if (!touch) {
        return;
      }
      const move = moveTouchScroll(touchScrollRef.current, e.touches.length, touch.clientY);
      touchScrollRef.current = move.state;
      // We fully own terminal scrolling via synthetic wheel events, so always
      // stop xterm's own touch-scroll handler from also processing this gesture
      // (including the multi-touch case, where xterm would otherwise scroll and
      // cancel the browser's pinch-zoom).
      e.stopPropagation();
      if (!move.state.active) {
        // Disarmed (multi-touch / pinch-zoom): leave the browser default intact.
        return;
      }
      if (move.deltaY !== 0) {
        // clientX/clientY are required: in mouse-reporting mode xterm maps the
        // wheel to a terminal cell from these coordinates and drops the event if
        // they fall outside the terminal.
        term.element?.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: move.deltaY,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
            clientX: touch.clientX,
            clientY: touch.clientY,
            screenX: touch.screenX,
            screenY: touch.screenY,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
            shiftKey: e.shiftKey,
            metaKey: e.metaKey
          })
        );
      }
      // preventDefault only while armed (single-finger) suppresses pull-to-refresh
      // for terminal scrolling without blocking multi-touch browser gestures.
      e.preventDefault();
    };
    const onTouchEnd = (): void => {
      touchScrollRef.current = { active: false, lastY: 0 };
    };
    container.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    container.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true, capture: true });

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
      const next = Math.min(32, Math.max(8, fontSizeRef.current + delta));
      if (next !== fontSizeRef.current) {
        fontSizeRef.current = next;
        applyTerminalFontSize(term, next, refit);
      }
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
      container.removeEventListener("touchstart", onTouchStart, true);
      container.removeEventListener("touchmove", onTouchMove, true);
      container.removeEventListener("touchend", onTouchEnd, true);
      container.removeEventListener("touchcancel", onTouchEnd, true);
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
      const ws = new WebSocket(attachSocketUrl(session.id));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      attachedSessionIdRef.current = session.id;
      initialReplayCompleteRef.current = false;
      ws.onopen = () => {
        flushQueuedViewMode(ws, queuedViewModeRef as QueuedViewMode);
        flushAttentionAck();
      };
      ws.onmessage = (ev) => {
        if (
          wsRef.current !== ws ||
          attachedSessionIdRef.current !== session.id ||
          attachmentGeneration !== attachmentGenerationRef.current
        ) {
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
            term.write(data, () => {
              completeInitialReplay(
                attachmentGeneration,
                attachmentGenerationRef.current,
                () => {
                  initialReplayCompleteRef.current = true;
                },
                refit
              );
            });
          }
        }
      };
    } else {
      void fetchScrollback(session.id).then((buf) => {
        if (cancelled) {
          return;
        }
        if (buf) {
          term.write(buf, () => {
            completeInitialReplay(attachmentGeneration, attachmentGenerationRef.current, () => undefined, refit);
          });
        } else {
          term.write("\x1b[90m[no output captured]\x1b[0m\r\n", () => {
            completeInitialReplay(attachmentGeneration, attachmentGenerationRef.current, () => undefined, refit);
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
    focus: () => termRef.current?.focus()
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
      onClick={() => focusTerminalPane(termRef.current)}
    />
  );
});
