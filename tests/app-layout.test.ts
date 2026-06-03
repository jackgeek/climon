import { describe, expect, test } from "bun:test";
import { scheduleTerminalRefit } from "../src/web/App.js";

describe("scheduleTerminalRefit", () => {
  test("refits the terminal on the next animation frame", () => {
    let calls = 0;
    const scheduled: Array<(time: number) => void> = [];

    scheduleTerminalRefit(
      { refit: () => calls++ },
      (callback) => {
        scheduled.push((time) => callback(time));
        return 1;
      }
    );

    expect(calls).toBe(0);
    expect(scheduled).toHaveLength(1);

    const callback = scheduled[0];
    if (!callback) {
      throw new Error("Expected terminal refit to be scheduled.");
    }
    callback(0);

    expect(calls).toBe(1);
  });

  test("does nothing when there is no terminal handle", () => {
    let scheduled = false;

    scheduleTerminalRefit(null, (callback) => {
      scheduled = true;
      callback(0);
      return 1;
    });

    expect(scheduled).toBe(false);
  });
});
