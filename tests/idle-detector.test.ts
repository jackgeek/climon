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

  test("a rebase keeps an acknowledged screen acknowledged without reflagging", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("screen-a", 0);
    detector.update("screen-a", 10_000);
    detector.acknowledge("screen-a", 12_000);

    detector.rebase("screen-a-resized");

    expect(detector.update("screen-a-resized", 13_000)).toBeUndefined();
    expect(detector.update("screen-a-resized", 30_000)).toBeUndefined();
  });

  test("a meaningful change after a rebase still reports running from acknowledged", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("screen-a", 0);
    detector.update("screen-a", 10_000);
    detector.acknowledge("screen-a", 12_000);

    detector.rebase("screen-a-resized");

    expect(detector.update("screen-b", 14_000)).toEqual({ needsAttention: false });
  });

  test("a rebase does not clear a flagged needs-attention state", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("screen-a", 0);
    detector.update("screen-a", 10_000);

    detector.rebase("screen-a-resized");

    expect(detector.update("screen-a-resized", 11_000)).toBeUndefined();
    expect(detector.update("screen-b", 12_000)).toEqual({ needsAttention: false });
  });

  test("a rebase before the first update is a no-op", () => {
    const detector = new ScreenIdleDetector(10);
    detector.rebase("screen-a");
    expect(detector.update("screen-a", 0)).toBeUndefined();
    expect(detector.update("screen-a", 10_000)).toEqual({
      needsAttention: true,
      reason: "Screen idle for 10s"
    });
  });

  test("input settle suppresses a silently-running command's static screen", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("prompt", 0);

    // User types a command; the echoed screen is absorbed on settle.
    expect(detector.settleInput("sleep-cmd", 1_000)).toBeUndefined();

    // The command runs silently for far longer than the idle window: no flag.
    expect(detector.update("sleep-cmd", 11_000)).toBeUndefined();
    expect(detector.update("sleep-cmd", 60_000)).toBeUndefined();
  });

  test("a genuinely new screen after input settle flags once it goes idle", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("prompt", 0);
    detector.settleInput("sleep-cmd", 1_000);
    detector.update("sleep-cmd", 30_000);

    // The command finishes and a fresh prompt appears: not a flag yet.
    expect(detector.update("new-prompt", 31_000)).toBeUndefined();
    // The new screen then sits idle for the window and flags.
    expect(detector.update("new-prompt", 40_999)).toBeUndefined();
    expect(detector.update("new-prompt", 41_000)).toEqual({
      needsAttention: true,
      reason: "Screen idle for 10s"
    });
  });

  test("input settle clears a flagged needs-attention session to running", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("prompt", 0);
    detector.update("prompt", 10_000);

    expect(detector.settleInput("cmd", 11_000)).toEqual({ needsAttention: false });
    expect(detector.update("cmd", 21_000)).toBeUndefined();
  });

  test("input settle clears an acknowledged session and keeps it suppressed", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("prompt", 0);
    detector.update("prompt", 10_000);
    detector.acknowledge("prompt", 11_000);

    expect(detector.settleInput("cmd", 12_000)).toEqual({ needsAttention: false });
    expect(detector.update("cmd", 22_000)).toBeUndefined();
  });

  test("repeated input settles on a running session emit no redundant transitions", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("prompt", 0);

    expect(detector.settleInput("typing-1", 1_000)).toBeUndefined();
    expect(detector.settleInput("typing-2", 2_000)).toBeUndefined();
    expect(detector.settleInput("typing-3", 3_000)).toBeUndefined();
  });

  test("a rebase keeps an input-suppressed screen suppressed across resize", () => {
    const detector = new ScreenIdleDetector(10);
    detector.update("prompt", 0);
    detector.settleInput("cmd", 1_000);

    detector.rebase("cmd-resized");

    expect(detector.update("cmd-resized", 11_000)).toBeUndefined();
    expect(detector.update("cmd-resized", 60_000)).toBeUndefined();
  });

  test("settleInput is a no-op when idleSeconds <= 0", () => {
    const detector = new ScreenIdleDetector(0);
    expect(detector.settleInput("cmd", 0)).toBeUndefined();
    expect(detector.update("cmd", 100_000)).toBeUndefined();
  });

  test("is disabled when idleSeconds <= 0", () => {
    const detector = new ScreenIdleDetector(0);
    expect(detector.update("screen-a", 0)).toBeUndefined();
    expect(detector.update("screen-a", 100_000)).toBeUndefined();
  });
});
