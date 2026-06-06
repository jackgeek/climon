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
