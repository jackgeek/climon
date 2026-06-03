import { describe, expect, test } from "bun:test";
import { ScreenIdleDetector } from "../src/daemon/idle-detector.js";

describe("ScreenIdleDetector", () => {
  test("seeds on first update and does not flag immediately", () => {
    const detector = new ScreenIdleDetector(10);
    expect(detector.update("screen-a", 0)).toBeUndefined();
  });

  test("flags after the idle window with an unchanged fingerprint", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("screen-a", 0);
    expect(detector.update("screen-a", 5_000)).toBeUndefined();
    expect(detector.update("screen-a", 10_000)).toEqual({
      needsAttention: true,
      reason: "Screen idle for 10s"
    });
  });

  test("does not fire twice while still idle", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("screen-a", 0);
    detector.update("screen-a", 10_000);
    expect(detector.update("screen-a", 11_000)).toBeUndefined();
  });

  test("reverts to running when the fingerprint changes after flagging", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("screen-a", 0);
    detector.update("screen-a", 10_000);
    expect(detector.update("screen-b", 10_500)).toEqual({ needsAttention: false });
  });

  test("a change before the window resets the idle timer", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("screen-a", 0);
    expect(detector.update("screen-b", 9_000)).toBeUndefined();
    expect(detector.update("screen-b", 18_000)).toBeUndefined();
    expect(detector.update("screen-b", 19_000)).toEqual({
      needsAttention: true,
      reason: "Screen idle for 10s"
    });
  });

  test("acknowledgement clears a flagged unchanged fingerprint without immediately reflagging", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("screen-a", 0);
    detector.update("screen-a", 10_000);

    detector.acknowledge("screen-a", 12_000);

    expect(detector.update("screen-a", 12_000)).toBeUndefined();
    expect(detector.update("screen-a", 21_999)).toBeUndefined();
    expect(detector.update("screen-a", 22_000)).toBeUndefined();
  });

  test("acknowledgement reports running when a later changed fingerprint starts a fresh idle window", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("screen-a", 0);
    detector.update("screen-a", 10_000);

    detector.acknowledge("screen-a", 12_000);

    expect(detector.update("screen-b", 13_000)).toEqual({ needsAttention: false });
    expect(detector.update("screen-b", 22_999)).toBeUndefined();
    expect(detector.update("screen-b", 23_000)).toEqual({
      needsAttention: true,
      reason: "Screen idle for 10s"
    });
  });

  test("is disabled when idleSeconds <= 0", () => {
    const detector = new ScreenIdleDetector(0);
    expect(detector.update("screen-a", 0)).toBeUndefined();
    expect(detector.update("screen-a", 100_000)).toBeUndefined();
  });
});
