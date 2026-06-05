import type { TerminalResizeMode } from "../ipc/frame.js";

export const clampSizeMenuLabel = "Clamp terminal size";
export const websocketOpenState = 1;

export interface QueuedViewMode {
  current: TerminalResizeMode | null;
}

interface ModeSocket {
  readyState: number;
  send: (message: string) => void;
}

export function toggleViewMode(mode: TerminalResizeMode): TerminalResizeMode {
  return mode === "clamped" ? "fill" : "clamped";
}

function modeMessage(mode: TerminalResizeMode): string {
  return JSON.stringify({ type: "mode", mode });
}

export function sendViewModeOrQueue(
  socket: ModeSocket | null | undefined,
  mode: TerminalResizeMode,
  queue: QueuedViewMode
): boolean {
  queue.current = mode;
  if (socket?.readyState !== websocketOpenState) {
    return false;
  }
  socket.send(modeMessage(mode));
  queue.current = null;
  return true;
}

export function flushQueuedViewMode(socket: ModeSocket, queue: QueuedViewMode): TerminalResizeMode | null {
  const mode = queue.current;
  if (!mode || socket.readyState !== websocketOpenState) {
    return null;
  }
  socket.send(modeMessage(mode));
  queue.current = null;
  return mode;
}

export interface MobileViewModeState {
  wasMobile: boolean;
  saved: { sessionId: string; mode: TerminalResizeMode } | null;
}

export interface MobileViewModeTransition {
  requestMode: TerminalResizeMode | null;
  next: MobileViewModeState;
}

export function resolveMobileViewMode(
  isMobile: boolean,
  activeSessionId: string | null,
  authoritativeMode: TerminalResizeMode | null,
  state: MobileViewModeState
): MobileViewModeTransition {
  const saved = state.saved && state.saved.sessionId === activeSessionId ? state.saved : null;
  if (isMobile) {
    if (activeSessionId && authoritativeMode && authoritativeMode !== "clamped") {
      return {
        requestMode: "clamped",
        next: { wasMobile: true, saved: saved ?? { sessionId: activeSessionId, mode: authoritativeMode } }
      };
    }
    return { requestMode: null, next: { wasMobile: true, saved } };
  }
  if (state.wasMobile && saved) {
    return {
      requestMode: authoritativeMode === saved.mode ? null : saved.mode,
      next: { wasMobile: false, saved: null }
    };
  }
  return { requestMode: null, next: { wasMobile: false, saved } };
}
