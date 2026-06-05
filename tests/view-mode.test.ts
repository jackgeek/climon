import { describe, expect, test } from "bun:test";
import {
  clampSizeMenuLabel,
  flushQueuedViewMode,
  resolveMobileViewMode,
  sendViewModeOrQueue,
  toggleViewMode,
  type MobileViewModeState,
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

describe("mobile view mode auto-clamp", () => {
  const fresh = (saved: MobileViewModeState["saved"] = null, wasMobile = false): MobileViewModeState => ({
    wasMobile,
    saved
  });

  test("entering mobile with a known fill mode saves it and requests clamped", () => {
    const r = resolveMobileViewMode(true, "s1", "fill", fresh());
    expect(r.requestMode).toBe("clamped");
    expect(r.next).toEqual({ wasMobile: true, saved: { sessionId: "s1", mode: "fill" } });
  });

  test("entering mobile with a known clamped mode saves nothing and requests nothing", () => {
    const r = resolveMobileViewMode(true, "s1", "clamped", fresh());
    expect(r.requestMode).toBeNull();
    expect(r.next).toEqual({ wasMobile: true, saved: null });
  });

  test("entering mobile with an unknown mode is a no-op until the mode is known", () => {
    const r = resolveMobileViewMode(true, "s1", null, fresh());
    expect(r.requestMode).toBeNull();
    expect(r.next).toEqual({ wasMobile: true, saved: null });
  });

  test("staying mobile does not overwrite the already-saved mode", () => {
    const state = fresh({ sessionId: "s1", mode: "fill" }, true);
    const r = resolveMobileViewMode(true, "s1", "fill", state);
    expect(r.requestMode).toBe("clamped");
    expect(r.next.saved).toEqual({ sessionId: "s1", mode: "fill" });
  });

  test("switching to another session while mobile drops the previous saved mode", () => {
    const state = fresh({ sessionId: "s1", mode: "fill" }, true);
    const r = resolveMobileViewMode(true, "s2", "clamped", state);
    expect(r.requestMode).toBeNull();
    expect(r.next).toEqual({ wasMobile: true, saved: null });
  });

  test("leaving mobile restores the saved mode for the same session", () => {
    const state = fresh({ sessionId: "s1", mode: "fill" }, true);
    const r = resolveMobileViewMode(false, "s1", "clamped", state);
    expect(r.requestMode).toBe("fill");
    expect(r.next).toEqual({ wasMobile: false, saved: null });
  });

  test("leaving mobile requests nothing when already at the saved mode", () => {
    const state = fresh({ sessionId: "s1", mode: "fill" }, true);
    const r = resolveMobileViewMode(false, "s1", "fill", state);
    expect(r.requestMode).toBeNull();
    expect(r.next).toEqual({ wasMobile: false, saved: null });
  });

  test("leaving mobile with a different active session does not restore", () => {
    const state = fresh({ sessionId: "s1", mode: "fill" }, true);
    const r = resolveMobileViewMode(false, "s2", "clamped", state);
    expect(r.requestMode).toBeNull();
    expect(r.next).toEqual({ wasMobile: false, saved: null });
  });

  test("staying on desktop is a no-op", () => {
    const r = resolveMobileViewMode(false, "s1", "fill", fresh());
    expect(r.requestMode).toBeNull();
    expect(r.next).toEqual({ wasMobile: false, saved: null });
  });

  test("load-already-mobile then learn fill saves fill and restores it on exit", () => {
    const enter = resolveMobileViewMode(true, "s1", null, { wasMobile: true, saved: null });
    expect(enter.requestMode).toBeNull();
    const learn = resolveMobileViewMode(true, "s1", "fill", enter.next);
    expect(learn.requestMode).toBe("clamped");
    expect(learn.next.saved).toEqual({ sessionId: "s1", mode: "fill" });
    const settled = resolveMobileViewMode(true, "s1", "clamped", learn.next);
    expect(settled.requestMode).toBeNull();
    const leave = resolveMobileViewMode(false, "s1", "clamped", settled.next);
    expect(leave.requestMode).toBe("fill");
  });
});
