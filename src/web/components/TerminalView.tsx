import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { Terminal, type ITerminalAddon, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { SessionMeta } from "../../types.js";
import {
  attachKey,
  attachSocketUrl,
  attentionAckMessage,
  canSendAttentionAck,
  fetchScrollback,
  isLiveStatus
} from "../api.js";
import { deriveControlState, generateViewerId, surfaceKind, shouldRefitOnControlFrame, shouldReclaimOnFocus, shouldTakeControlOnAttach, shouldSendResize, type ControlState } from "../control-state.js";
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
// How long to wait before revealing the "displaced" overlay, so a fast
// take-control handoff (open/focus/button) does not flash the dialog.
const DISPLACED_OVERLAY_DELAY_MS = 350;
// Bound the take-control retry so a terminal that never (re)mounts cannot spin a
// rAF loop forever. A handful of frames comfortably covers the viewport settling
// after onopen and a quick socket swap; a longer reconnect re-arms take-control
// again from the next attachment's onopen (shouldTakeControlOnAttach).
const MAX_TAKE_CONTROL_FLUSH_ATTEMPTS = 10;

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

// A live refresh (e.g. after a control handoff resize) rebuilds scrollback
// without a full term.reset(), preserving xterm private modes such as mouse
// tracking. The daemon's replay snapshot re-asserts the authoritative modes via
// its appended suffix, so the screen ends up correct without clearing mouse state.
export function refreshTerminalForReplay(term: ReplayRefreshableTerminal): void {
  term.clear();
  term.scrollToBottom();
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

export function shouldForwardTerminalData(state: {
  displaced: boolean;
  initialReplayComplete: boolean;
  replayWriteInProgress: boolean;
}): boolean {
  return !state.displaced && state.initialReplayComplete && !state.replayWriteInProgress;
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
  armTakeControl: (sessionId: string) => void;
  acknowledgeAttention: (sessionId: string, attentionMatchedAt: string) => void;
  focus: () => void;
  captureText: () => string;
}

const useStyles = makeStyles({
  wrapper: {
    position: "relative",
    display: "flex",
    flex: "1 1 auto",
    minWidth: 0,
    minHeight: 0
  },
  root: {
    flex: "1 1 auto",
    minWidth: 0,
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
  const viewerIdRef = useRef<string>(generateViewerId());
  const kindRef = useRef(surfaceKind(readIsStandalone()));
  const controllerIdRef = useRef<string | null>(null);
  const displacedRef = useRef(false);
  // The last grid size this surface reported to the daemon, used to suppress
  // redundant resize reports (see shouldSendResize) so viewport jitter cannot
  // spam PTY resizes.
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const pendingTakeControlSessionRef = useRef<string | null>(null);
  const displacedOverlayTimerRef = useRef<number | null>(null);
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
  const replayWriteInProgressRef = useRef(false);
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
    // Only the controller drives the grid. A non-controller (displaced) surface
    // must stay silent -- reporting its size would fight the controller and
    // trigger a resize feedback loop across surfaces.
    if (displacedRef.current) {
      return;
    }
    const term = termRef.current;
    const ws = wsRef.current;
    if (term && ws && ws.readyState === WebSocket.OPEN) {
      // Report this tab's NATURAL fit dimensions (what its container can hold),
      // not term.cols/rows -- proposeDimensions() measures the container without
      // resizing xterm.
      const proposed = fitRef.current?.proposeDimensions();
      const cols = proposed?.cols ?? term.cols;
      const rows = proposed?.rows ?? term.rows;
      const requestReplay = replayAfterNextResizeRef.current;
      // Suppress redundant reports: viewport jitter (mobile URL bar/keyboard,
      // scrollbar flips) can re-fit to the same grid many times. Only report a
      // real size change -- unless a replay must ride along (take-control).
      if (!shouldSendResize({ last: lastSentSizeRef.current, next: { cols, rows }, requestReplay })) {
        return;
      }
      lastSentSizeRef.current = { cols, rows };
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

  // Cancel a pending (not-yet-shown) displaced overlay.
  function cancelDisplacedOverlay(): void {
    if (displacedOverlayTimerRef.current !== null) {
      clearTimeout(displacedOverlayTimerRef.current);
      displacedOverlayTimerRef.current = null;
    }
  }

  // Defer showing the displaced overlay briefly. When a surface takes control
  // (on open, on focus, or via the button), the daemon may first re-broadcast
  // the *current* controller before our take-control round-trips, which would
  // flash the "being viewed on another dashboard" dialog for a frame or two.
  // Showing the overlay only after a short delay -- and cancelling it the moment
  // we (re)gain control -- keeps the handoff flicker-free. The displaced gating
  // (displacedRef) still updates immediately so we never fight the controller.
  function scheduleDisplacedOverlay(): void {
    if (displacedOverlayTimerRef.current !== null) {
      return;
    }
    displacedOverlayTimerRef.current = window.setTimeout(() => {
      displacedOverlayTimerRef.current = null;
      if (displacedRef.current) {
        setDisplayState("displaced");
      }
    }, DISPLACED_OVERLAY_DELAY_MS);
  }

  function takeControl(): boolean {
    const ws = wsRef.current;
    const term = termRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !term) {
      return false;
    }
    // Report our natural size first so the daemon resizes the PTY to fit this
    // surface, then seize control. This bypasses the displaced guard on
    // sendResize() because control has not transferred to us yet.
    const proposed = fitRef.current?.proposeDimensions();
    const cols = proposed?.cols ?? term.cols;
    const rows = proposed?.rows ?? term.rows;
    lastSentSizeRef.current = { cols, rows };
    ws.send(JSON.stringify({ type: "resize", cols, rows, kind: kindRef.current, viewerId: viewerIdRef.current }));
    ws.send(JSON.stringify({ type: "takeControl" }));
    return true;
  }

  // Arm an automatic take-control for the given session so that selecting or
  // opening a session in this dashboard makes it the controller. If we are
  // already attached to that session, take control immediately; otherwise the
  // pending request is flushed when the next attachment opens.
  function armTakeControl(sessionId: string): void {
    pendingTakeControlSessionRef.current = sessionId;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && attachedSessionIdRef.current === sessionId) {
      flushPendingTakeControl(sessionId);
    }
  }

  function flushPendingTakeControl(sessionId: string, attempt = 0): void {
    if (pendingTakeControlSessionRef.current !== sessionId) {
      return;
    }
    if (takeControl()) {
      pendingTakeControlSessionRef.current = null;
      return;
    }
    // takeControl() no-oped: the socket was not OPEN or the terminal was not
    // mounted at this instant -- e.g. an in-flight reattach (a session switch or
    // a server-token reconnect) swapped wsRef between onopen and this deferred
    // flush. Keep the request armed and retry on a later frame instead of
    // silently dropping it, otherwise the surface sticks behind "This session is
    // being viewed elsewhere." with no focus event to trigger reclaimOnFocus.
    // The guard above ends the retry once the request is served or the selection
    // changes; the attempt cap bounds a terminal that never remounts.
    if (attempt >= MAX_TAKE_CONTROL_FLUSH_ATTEMPTS) {
      return;
    }
    requestAnimationFrame(() => flushPendingTakeControl(sessionId, attempt + 1));
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
    // A displaced (non-controller) surface must not fit or report its size --
    // that is what drives the grid, and only the controller may do so.
    if (displacedRef.current) {
      return;
    }
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

  // Repaint the viewport without touching geometry. Focus is not a resize, so
  // the focus path must never refit: refitting on focus lets xterm's own focus
  // churn (it re-focuses its helper textarea when the grid is refreshed/resized)
  // re-fire focusin, which would call refit() again on the next double-rAF --
  // an unbounded shrinking resize spiral once a surface takes control.
  function repaintActiveTerminal(): void {
    refreshTerminalRender(termRef.current);
  }

  // Repaint AND refit. Reserved for events that actually change (or settle) the
  // grid geometry -- e.g. the post-replay settle -- never for focus.
  function refreshActiveTerminal(): void {
    refreshTerminalRender(termRef.current);
    refit();
  }

  function focusActiveTerminal(): void {
    focusTerminalPane(termRef.current, repaintActiveTerminal);
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
    replayWriteInProgressRef.current = false;
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
      // Re-take control on every (re)attach of the session the user is actively
      // viewing. The daemon reassigns control to the local terminal the moment
      // our socket drops, and an intra-tab mouse switch fires no focus event for
      // reclaimOnFocus, so onopen is the only edge that reclaims a switch or a
      // mid-session reconnect. Arming (not flushing) here preserves a request
      // already queued by onSelect and defers measurement to the frame below.
      if (
        shouldTakeControlOnAttach({
          attachIsSelected: selectedSessionRef.current?.id === liveSession.id,
          visible: visibleRef.current,
          sessionLive: isLiveStatus(liveSession.status)
        })
      ) {
        pendingTakeControlSessionRef.current = liveSession.id;
      }
      // If the user selected/opened this session, take control once attached.
      // Defer a frame so the terminal viewport has settled before we measure it.
      if (pendingTakeControlSessionRef.current === liveSession.id) {
        requestAnimationFrame(() => flushPendingTakeControl(liveSession.id));
      }
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
            message?: string;
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
            controllerIdRef.current = controllerId;
            const state = deriveControlState({ ownViewerId: viewerIdRef.current, controllerId });
            const wasDisplaced = displacedRef.current;
            displacedRef.current = state === "displaced";
            if (state === "displaced") {
              // Update the gating ref immediately (above) so we stop reporting
              // our size, but defer the visual overlay to avoid a handoff flash.
              scheduleDisplacedOverlay();
            } else {
              // We hold control: cancel any pending overlay and show the
              // terminal right away.
              cancelDisplacedOverlay();
              applyDisplacedUi(state);
            }
            onControlStateChangeRef.current?.({ controllerId, ownViewerId: viewerIdRef.current, state });
            if (shouldRefitOnControlFrame({ state, wasDisplaced })) {
              // We JUST took control: render the grid at our size and rebuild
              // scrollback on the next resize. We deliberately do NOT refit on
              // grid changes while already the stable controller -- as the
              // controller we caused them, and re-fitting would form a
              // resize -> control -> refit -> resize feedback loop that never
              // settles when the fit is unstable (mobile PWA), corrupting the
              // screen with endless resizes and replays.
              replayAfterNextResizeRef.current = true;
              refit();
            }
          } else if (msg.type === "replay") {
            awaitingReplayRef.current = true;
          } else if (msg.type === "error") {
            const detail = typeof msg.message === "string" ? msg.message : "connection failed";
            term.write(`\r\n\x1b[31mclimon: cannot attach — ${detail}\x1b[0m\r\n`);
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
          replayWriteInProgressRef.current = true;
          term.write(data, () => {
            replayWriteInProgressRef.current = false;
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

  // Reclaim control when this dashboard/PWA window regains focus or becomes
  // visible again. Per the control-priority design a surface takes over the
  // session it is actively showing, so returning to this window (alt-tab, tab
  // switch, unlocking a phone, resuming the PWA) makes it the controller again.
  // Edge-triggered by the browser focus/visibility events -- it fires only on a
  // transition, never continuously, so it cannot fight another surface while the
  // user is away from this window.
  useEffect(() => {
    function reclaimOnFocus(): void {
      const visible = typeof document === "undefined" || document.visibilityState === "visible";
      // Use the selected session (not the attached one): while the socket is
      // dropped -- exactly when the daemon may have reassigned control away from
      // this backgrounded tab -- attachedSessionIdRef is null, but we still need
      // to arm a reclaim so the reconnect re-takes control.
      const session = selectedSessionRef.current;
      if (!session || !isLiveStatus(session.status)) {
        return;
      }
      const ws = wsRef.current;
      const connected = ws?.readyState === WebSocket.OPEN;
      if (
        !shouldReclaimOnFocus({
          visible,
          sessionLive: true,
          connected,
          controllerId: controllerIdRef.current,
          ownViewerId: viewerIdRef.current
        })
      ) {
        return;
      }
      armTakeControl(session.id);
    }
    window.addEventListener("focus", reclaimOnFocus);
    document.addEventListener("visibilitychange", reclaimOnFocus);
    return () => {
      window.removeEventListener("focus", reclaimOnFocus);
      document.removeEventListener("visibilitychange", reclaimOnFocus);
    };
  }, []);

  // Clear any pending displaced-overlay timer on unmount.
  useEffect(() => cancelDisplacedOverlay, []);

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
      // xterm emits onData not only for user input, but also for device-query
      // responses generated while parsing output. Historical queries in a replay
      // must not be answered back into the live PTY, where an unprepared shell
      // would echo the OSC palette response as visible garbage.
      const forwardAllowed = shouldForwardTerminalData({
        displaced: displacedRef.current,
        initialReplayComplete: initialReplayCompleteRef.current,
        replayWriteInProgress: replayWriteInProgressRef.current
      });
      if (!forwardAllowed) {
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
    lastSentSizeRef.current = null;
    displacedRef.current = false;
    cancelDisplacedOverlay();
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
    armTakeControl,
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
        onFocusCapture={repaintActiveTerminal}
      />
      {displayState === "displaced" && (
        <div className={styles.overlay}>
          <div className={styles.overlayCard}>
            <Text>This session is being viewed elsewhere.</Text>
            <Button appearance="primary" onClick={takeControl}>
              Take control
            </Button>
          </div>
        </div>
      )}
    </div>
  );
});
