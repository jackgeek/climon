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

  test("is disabled when idleSeconds <= 0", () => {
    const detector = new ScreenIdleDetector(0);
    expect(detector.update("screen-a", 0)).toBeUndefined();
    expect(detector.update("screen-a", 100_000)).toBeUndefined();
  });
});
