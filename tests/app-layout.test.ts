import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionMeta } from "../src/types.js";
import { scheduleTerminalRefit } from "../src/web/App.js";
import { MainHeader } from "../src/web/App.js";

function makeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    command: ["bun", "run", "server"],
    displayCommand: "bun run server",
    cwd: "/repo",
    status: "running",
    priorityReason: "running",
    cols: 80,
    rows: 24,
    socketPath: "tcp://127.0.0.1:1234",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    lastActivityAt: "2026-06-03T00:00:00.000Z",
    ...overrides
  };
}

describe("scheduleTerminalRefit", () => {
  test("refits the terminal after layout settles across two animation frames", () => {
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

    const firstFrame = scheduled[0];
    if (!firstFrame) {
      throw new Error("Expected first terminal refit frame to be scheduled.");
    }
    firstFrame(0);

    expect(calls).toBe(0);
    expect(scheduled).toHaveLength(2);

    const secondFrame = scheduled[1];
    if (!secondFrame) {
      throw new Error("Expected second terminal refit frame to be scheduled.");
    }
    secondFrame(16);

    expect(calls).toBe(1);
  });

  describe("MainHeader", () => {
    test("renders the active session status pill after the session name", () => {
      const markup = renderToStaticMarkup(
        createElement(MainHeader, {
          activeSession: makeSession({ name: "API server", status: "needs-attention" }),
          hidden: false
        })
      );

      const nameIndex = markup.indexOf("API server");
      const statusIndex = markup.indexOf("needs attention");
      const idIndex = markup.indexOf(">s1<");

      expect(nameIndex).toBeGreaterThan(-1);
      expect(statusIndex).toBeGreaterThan(nameIndex);
      expect(idIndex).toBeGreaterThan(statusIndex);
    });
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
