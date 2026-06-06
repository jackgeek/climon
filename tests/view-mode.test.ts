import { describe, expect, test } from "bun:test";
import {
  clampSizeMenuLabel,
  flushQueuedViewMode,
  sendViewModeOrQueue,
  toggleViewMode,
  type QueuedViewMode
} from "../src/web/view-mode.js";

describe("view mode menu", () => {
  test("Clamp terminal size toggles from clamped to fill", () => {
    expect(toggleViewMode("clamped")).toBe("fill");
  });

  test("Clamp terminal size toggles from fill to clamped", () => {
    expect(toggleViewMode("fill")).toBe("clamped");
  });

  test("uses one menu label for both modes", () => {
    expect(clampSizeMenuLabel).toBe("Clamp terminal size");
  });

  test("queues a mode request when the WebSocket is not open, then flushes it on open", () => {
    const sent: string[] = [];
    const queue: QueuedViewMode = { current: null };
    const socket = {
      readyState: 0,
      send: (message: string) => sent.push(message)
    };

    expect(sendViewModeOrQueue(socket, "clamped", queue)).toBe(false);
    expect(queue.current).toBe("clamped");
    expect(sent).toEqual([]);

    socket.readyState = 1;
    expect(flushQueuedViewMode(socket, queue)).toBe("clamped");
    expect(queue.current).toBeNull();
    expect(sent).toEqual([JSON.stringify({ type: "mode", mode: "clamped" })]);
  });
});
