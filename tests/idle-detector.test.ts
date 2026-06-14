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

  test("a change while not flagged does not emit a transition", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("screen-a", 0);
    expect(detector.update("screen-b", 5_000)).toBeUndefined();
  });

  test("is disabled when idleSeconds <= 0", () => {
    const detector = new ScreenIdleDetector(0);
    expect(detector.update("screen-a", 0)).toBeUndefined();
    expect(detector.update("screen-a", 100_000)).toBeUndefined();
  });

  test("absorbing a resize re-baselines without clearing the flagged state", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("80x24\nidle screen", 0);
    expect(detector.update("80x24\nidle screen", 10_000)).toEqual({
      needsAttention: true,
      reason: "Screen idle for 10s"
    });

    // A browser viewer attaches and resizes: the screen reflows to new
    // dimensions. This is not program activity, so it must not clear attention.
    detector.absorbResize("120x30\nidle screen reflowed");
    expect(detector.update("120x30\nidle screen reflowed", 11_000)).toBeUndefined();

    // Genuine new program output after the resize still reverts to running.
    expect(detector.update("120x30\nNEW OUTPUT", 12_000)).toEqual({ needsAttention: false });
  });

  test("absorbing a resize before flagging preserves the idle countdown", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("80x24\nidle screen", 0);
    // Resize at 5s should not reset the idle timer started at 0.
    detector.absorbResize("120x30\nidle screen reflowed");
    expect(detector.update("120x30\nidle screen reflowed", 10_000)).toEqual({
      needsAttention: true,
      reason: "Screen idle for 10s"
    });
  });
});
