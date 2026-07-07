import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { Terminal, type ITerminalAddon, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
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
import { deriveControlState, surfaceKind, type ControlState } from "../control-state.js";
import { readIsStandalone } from "../pwa/pwaContext.js";
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

interface ReplayRefreshableTerminal {
  clear: () => void;
  scrollToBottom: () => void;
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
  scrollback: TERMINAL_SCROLLBACK
} as const;

/** Fallback terminal background used before a theme prop resolves. */
const DEFAULT_TERMINAL_BACKGROUND = "#0d1117";

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

interface CapturableTerminal {
  buffer: {
    active: {
      length: number;
      getLine: (index: number) => { translateToString: (trimRight?: boolean) => string } | undefined;
    };
  };
}

/** Matches box-drawing, block-element, and geometric-shape glyphs (U+2500–U+25FF) */
const DECORATION_GLYPH_RE = /[\u2500-\u25FF]/g;

/**
 * Replace terminal "decoration" glyphs (scrollbars, borders, block/box-drawing
 * characters some CLI tools paint, e.g. ▌ █ ░ │ ┃ ●) with spaces so column
 * alignment is preserved, then trim trailing whitespace from each line.
 */
export function stripTerminalDecorations(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(DECORATION_GLYPH_RE, " ").replace(/[ \t]+$/, ""))
    .join("\n");
}

/**
 * Read the terminal's full scrollback buffer as plain text. Each row is
 * right-trimmed by xterm; trailing blank rows are dropped so the capture ends at
 * the last line with content.
 */
export function captureTerminalText(term: CapturableTerminal | null): string {
  if (!term) {
    return "";
  }
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  }
  while (lines.length > 0 && lines[lines.length - 1].length === 0) {
    lines.pop();
  }
  return lines.join("\n");
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

// A live refresh (e.g. after a clamp/fill toggle) rebuilds scrollback without a
// full term.reset(), preserving xterm private modes such as mouse tracking. The
// daemon's replay snapshot re-asserts the authoritative modes via its appended
// suffix, so the screen ends up correct without clearing mouse state.
export function refreshTerminalForReplay(term: ReplayRefreshableTerminal): void {
  term.clear();
  term.scrollToBottom();
}

export function shouldRequestReplayForAuthoritativeMode(
  previousMode: TerminalResizeMode,
  nextMode: TerminalResizeMode,
  initialReplayComplete: boolean
): boolean {
  return initialReplayComplete && previousMode !== nextMode;
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

export function configureTerminalUnicode(
  term: Pick<Terminal, "loadAddon" | "unicode">,
  unicode11: ITerminalAddon
): void {
  term.loadAddon(unicode11);
  if (installEmojiUnicodeProvider(term)) {
    term.unicode.activeVersion = EMOJI_UNICODE_VERSION;
  } else {
    // Fall back to the plain Unicode 11 widths if xterm's internals are not
    // shaped as expected — the worst case is the pre-existing partial fix.
    term.unicode.activeVersion = "11";
  }
}

const EMOJI_UNICODE_VERSION = "climon-emoji";
const EMOJI_PRESENTATION_SELECTOR = 0xfe0f;
const SKIN_TONE_MIN = 0x1f3fb;
const SKIN_TONE_MAX = 0x1f3ff;

interface UnicodeVersionProvider {
  readonly version: string;
  wcwidth(codepoint: number): 0 | 1 | 2;
  charProperties(codepoint: number, preceding: number): number;
}

type PropertyPacker = (state: number, width: number, shouldJoin: boolean) => number;
type WidthExtractor = (value: number) => number;

/**
 * Wraps xterm's Unicode 11 provider to width emoji grapheme clusters that the
 * per-codepoint wcwidth table gets wrong: an emoji-presentation selector (VS16)
 * promotes a narrow base to two cells (also covering keycaps via the trailing
 * combining mark), and a skin-tone modifier joins the preceding emoji as a single
 * two-cell cluster. Everything else delegates to the base provider.
 */
export function createEmojiUnicodeProvider(
  base: Pick<UnicodeVersionProvider, "wcwidth" | "charProperties">,
  createPropertyValue: PropertyPacker,
  extractWidth: WidthExtractor
): UnicodeVersionProvider {
  return {
    version: EMOJI_UNICODE_VERSION,
    wcwidth: (codepoint) => base.wcwidth(codepoint),
    charProperties(codepoint, preceding) {
      if (
        codepoint === EMOJI_PRESENTATION_SELECTOR &&
        preceding !== 0 &&
        extractWidth(preceding) < 2
      ) {
        return createPropertyValue(0, 2, true);
      }
      if (codepoint >= SKIN_TONE_MIN && codepoint <= SKIN_TONE_MAX && preceding !== 0) {
        return createPropertyValue(0, 2, true);
      }
      return base.charProperties(codepoint, preceding);
    }
  };
}

interface UnicodeServiceInternals {
  _providers?: Record<string, UnicodeVersionProvider | undefined>;
  register(provider: UnicodeVersionProvider): void;
  constructor: {
    createPropertyValue?: PropertyPacker;
    extractWidth?: WidthExtractor;
  };
}

function installEmojiUnicodeProvider(term: Pick<Terminal, "unicode">): boolean {
  const service = (term as { _core?: { unicodeService?: UnicodeServiceInternals } })._core
    ?.unicodeService;
  const base = service?._providers?.["11"];
  const createPropertyValue = service?.constructor?.createPropertyValue;
  const extractWidth = service?.constructor?.extractWidth;
  if (!service || !base || typeof createPropertyValue !== "function" || typeof extractWidth !== "function") {
    return false;
  }
  service.register(createEmojiUnicodeProvider(base, createPropertyValue, extractWidth));
  return true;
}

export interface TerminalHandle {
  getDimensions: () => { cols: number; rows: number } | null;
  refit: () => void;
  refresh: () => void;
  sendInput: (data: string) => void;
  takeControl: () => void;
  acknowledgeAttention: (sessionId: string, attentionMatchedAt: string) => void;
  focus: () => void;
  captureText: () => string;
}

const useStyles = makeStyles({
  wrapper: {
    position: "relative",
    display: "flex",
    flex: "1 1 auto",
    minHeight: 0
  },
  root: {
    flex: "1 1 auto",
    minHeight: 0,
    padding: "8px",
    "& .xterm-viewport": {
      scrollbarWidth: "none",
      msOverflowStyle: "none"
    },
    "& .xterm-viewport::-webkit-scrollbar": {
      display: "none"
    }
  },
  overlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.colorBackgroundOverlay,
    zIndex: 1
  },
  overlayCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "16px",
    maxWidth: "360px",
    padding: "24px",
    textAlign: "center",
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow16
  }
});

interface Props {
  session: SessionMeta | null;
  accentColor?: SessionMeta["color"];
  maximized: boolean;
  visible: boolean;
  onControlStateChange?: (info: { controllerId: string | null; ownViewerId: string; state: ControlState }) => void;
  fontSize: number;
  xtermTheme: ITheme;
  onFontSizeChange: (delta: number) => void;
  serverConnected: boolean;
  serverReconnectToken: number;
  onLiveInteraction?: () => void;
}

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  {
    session,
    accentColor,
    maximized,
    visible,
    onControlStateChange,
    fontSize,
    xtermTheme,
    onFontSizeChange,
    serverConnected,
    serverReconnectToken,
    onLiveInteraction
  },
  ref
) {
  const styles = useStyles();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const attachedSessionIdRef = useRef<string | null>(null);
  const viewerIdRef = useRef<string>(crypto.randomUUID());
  const kindRef = useRef(surfaceKind(readIsStandalone()));
  const controllerIdRef = useRef<string | null>(null);
  const ctrlColsRef = useRef(0);
  const ctrlRowsRef = useRef(0);
  const displacedRef = useRef(false);
  const onControlStateChangeRef = useRef(onControlStateChange);
  const fontSizeRef = useRef(fontSize);
  const xtermThemeRef = useRef(xtermTheme);
  const onFontSizeChangeRef = useRef(onFontSizeChange);
  const [displayState, setDisplayState] = useState<ControlState>("controlling");
  const queuedAttentionAckRef = useRef<{ sessionId: string; attentionMatchedAt: string } | null>(null);
  const selectedSessionRef = useRef<SessionMeta | null>(session);
  const visibleRef = useRef(visible);
  const serverConnectedRef = useRef(serverConnected);
  const initialReplayCompleteRef = useRef(true);
  const attachmentGenerationRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const awaitingReplayRef = useRef(false);
  const replayAfterNextResizeRef = useRef(false);
  const lastServerReconnectTokenRef = useRef(serverReconnectToken);
  const onLiveInteractionRef = useRef(onLiveInteraction);

  useEffect(() => {
    selectedSessionRef.current = session;
    visibleRef.current = visible;
    serverConnectedRef.current = serverConnected;
    onLiveInteractionRef.current = onLiveInteraction;
  }, [session, visible, serverConnected, onLiveInteraction]);

  useEffect(() => {
    onControlStateChangeRef.current = onControlStateChange;
  }, [onControlStateChange]);

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
    applyTerminalFontSize(term, fontSize, refitThenRefresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize]);

  // Apply theme changes live: update the running terminal's palette and repaint.
  useEffect(() => {
    xtermThemeRef.current = xtermTheme;
    const term = termRef.current;
    if (term) {
      term.options.theme = xtermTheme;
      refreshTerminalRender(term);
    }
  }, [xtermTheme]);

  function sendResize(): void {
    const term = termRef.current;
    const ws = wsRef.current;
    if (term && ws && ws.readyState === WebSocket.OPEN) {
      // Report this tab's NATURAL fit dimensions (what its container can hold),
      // not term.cols/rows -- when following, xterm is forced to the controller's
      // grid, so its own size would be wrong. proposeDimensions() measures the
      // container without resizing xterm.
      const proposed = fitRef.current?.proposeDimensions();
      const cols = proposed?.cols ?? term.cols;
      const rows = proposed?.rows ?? term.rows;
      const requestReplay = replayAfterNextResizeRef.current;
      ws.send(JSON.stringify({ type: "resize", cols, rows, kind: kindRef.current, viewerId: viewerIdRef.current }));
      if (requestReplay) {
        replayAfterNextResizeRef.current = false;
        ws.send(JSON.stringify({ type: "replay" }));
      }
    }
  }

  // Blank the terminal behind a "take control" overlay when displaced; restore it
  // otherwise. Driven by the authoritative controller state from Control frames.
  function applyDisplacedUi(state: ControlState): void {
    setDisplayState(state);
  }

  function takeControl(): void {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "takeControl" }));
    }
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

  // A font-size change reflows the grid to a new cell size. xterm only repaints
  // the region touched by the reflow, so the resized viewport can keep stale
  // glyphs (the corruption that previously only cleared on the next focus
  // repaint). Repaint the whole viewport once the fit has settled.
  function refitThenRefresh(): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitNow();
        refreshTerminalRender(termRef.current);
      });
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
    awaitingReplayRef.current = false;
    replayAfterNextResizeRef.current = false;
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
    // While the dashboard server is known to be down (reported over SSE), pause
    // websocket reconnect attempts. The reconnect overlay blocks interaction, and
    // a deterministic fresh attach is driven by serverReconnectToken once the
    // server returns -- so backoff churn here would be wasted.
    if (!serverConnectedRef.current) {
      return;
    }
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
            controllerId?: string;
          };
          if (msg.type === "exit") {
            terminalExitReceived = true;
            term.write(`\r\n\x1b[90m[session exited with code ${msg.exitCode}]\x1b[0m\r\n`);
          } else if (msg.type === "size" && msg.cols && msg.rows) {
            // Authoritative PTY size from the daemon: match it so both the host
            // terminal and this viewer render the same grid -- unless displaced,
            // where the grid is too large for this tab so we keep it blank.
            if (!displacedRef.current) {
              applyAuthoritativeTerminalSize(term, msg.cols, msg.rows);
            }
          } else if (msg.type === "control") {
            const controllerId = typeof msg.controllerId === "string" ? msg.controllerId : null;
            const ctrlCols = msg.cols ?? 0;
            const ctrlRows = msg.rows ?? 0;
            const gridChanged = ctrlCols !== ctrlColsRef.current || ctrlRows !== ctrlRowsRef.current;
            controllerIdRef.current = controllerId;
            ctrlColsRef.current = ctrlCols;
            ctrlRowsRef.current = ctrlRows;
            const proposed = fitRef.current?.proposeDimensions();
            const ownCols = proposed?.cols ?? term.cols;
            const ownRows = proposed?.rows ?? term.rows;
            const state = deriveControlState({
              ownViewerId: viewerIdRef.current,
              controllerId,
              ownCols,
              ownRows,
              ctrlCols,
              ctrlRows
            });
            const wasDisplaced = displacedRef.current;
            displacedRef.current = state === "displaced";
            applyDisplacedUi(state);
            onControlStateChangeRef.current?.({ controllerId, ownViewerId: viewerIdRef.current, state });
            if (!displacedRef.current && (gridChanged || wasDisplaced)) {
              // Grid changed (or we just stopped being displaced): rebuild
              // scrollback for the new controller grid on the next resize.
              replayAfterNextResizeRef.current = true;
              refit();
            }
          } else if (msg.type === "replay") {
            awaitingReplayRef.current = true;
          }
        } catch {
          // Ignore malformed control messages.
        }
      } else {
        const data = new Uint8Array(ev.data as ArrayBuffer);
        const replayRequested = awaitingReplayRef.current;
        awaitingReplayRef.current = false;
        if (initialReplayCompleteRef.current && !replayRequested) {
          term.write(data);
        } else {
          if (firstBinaryFrame) {
            firstBinaryFrame = false;
            if (resetBeforeReplay) {
              term.reset();
            }
          } else if (replayRequested) {
            // A mid-session replay (e.g. after a clamp/fill toggle) rebuilds
            // scrollback without a full reset so mouse-tracking modes survive.
            refreshTerminalForReplay(term);
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
      theme: xtermThemeRef.current,
      fontSize: fontSizeRef.current
    });
    const fit = new FitAddon();
    const webLinks = new WebLinksAddon();
    loadTerminalAddons(term, fit, webLinks);
    configureTerminalUnicode(term, new Unicode11Addon());
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
      // While displaced the terminal is blanked and non-interactive; the only
      // control is the overlay's Take control button, so swallow all keystrokes.
      if (displacedRef.current) {
        return;
      }
      const liveSession = selectedSessionRef.current;
      if (liveSession && isLiveStatus(liveSession.status)) {
        // Signal interaction even if the socket is closed: the user is actively
        // trying to use a live session, which should surface the reconnect
        // overlay immediately while the server is unreachable.
        onLiveInteractionRef.current?.();
      }
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
    // Reset control state so a previous session's displaced overlay never lingers
    // over a freshly attached session; the daemon re-announces control on attach.
    controllerIdRef.current = null;
    ctrlColsRef.current = 0;
    ctrlRowsRef.current = 0;
    displacedRef.current = false;
    setDisplayState("controlling");
    applyTerminalScrollbackForSession(term, session);
    resetTerminalForSession(term, session);
    // A dashboard server reconnect re-runs this effect with a bumped token; track
    // it so a bumped token drives a fresh attach.
    lastServerReconnectTokenRef.current = serverReconnectToken;
    const attachmentGeneration = attachmentGenerationRef.current;

    if (!session) {
      return;
    }

    let cancelled = false;

    if (isLiveStatus(session.status)) {
      // Only hold the PTY (via the WebSocket) while the terminal is actually
      // displayed and the dashboard server is reachable. When the server is down
      // the reconnect overlay blocks interaction; we resume once it returns.
      if (!visible || !serverConnected) {
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
    // Re-attach when the session, its live/terminated state, visibility, server
    // availability, or a server reconnect changes -- never on live-status
    // idle/acknowledgement transitions, which would reset the terminal and cause
    // a periodic resize flicker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachKey(session, visible), serverConnected, serverReconnectToken]);

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
  }, [attachKey(session, visible), accentColor, maximized, visible]);

  useImperativeHandle(ref, () => ({
    getDimensions: () => {
      const term = termRef.current;
      return term ? { cols: term.cols, rows: term.rows } : null;
    },
    refit,
    refresh: () => refreshTerminalRender(termRef.current),
    sendInput: (data: string) => {
      if (displacedRef.current) {
        return;
      }
      const liveSession = selectedSessionRef.current;
      if (liveSession && isLiveStatus(liveSession.status)) {
        onLiveInteractionRef.current?.();
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    },
    takeControl,
    acknowledgeAttention: sendAttentionAck,
    focus: focusActiveTerminal,
    captureText: () => captureTerminalText(termRef.current)
  }));

  return (
    <div className={styles.wrapper}>
      <div
        ref={containerRef}
        className={styles.root}
        style={{
          backgroundColor: xtermTheme.background ?? DEFAULT_TERMINAL_BACKGROUND,
          visibility: displayState === "displaced" ? "hidden" : "visible",
          ...(accentColor
            ? { border: `${ACTIVE_SESSION_COLOR_ACCENT_WIDTH} solid ${ANSI_HIGHLIGHT_CSS[accentColor]}` }
            : {})
        }}
        onClick={focusActiveTerminal}
        onFocusCapture={refreshActiveTerminal}
      />
      {displayState === "displaced" && (
        <div className={styles.overlay}>
          <div className={styles.overlayCard}>
            <Text>This session is being viewed at a larger size elsewhere.</Text>
            <Button appearance="primary" onClick={takeControl}>
              Take control
            </Button>
          </div>
        </div>
      )}
    </div>
  );
});
