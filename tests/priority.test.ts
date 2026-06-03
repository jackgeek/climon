import { describe, expect, test } from "bun:test";
import { sortSessionsByPriority } from "../src/priority.js";
import type { SessionMeta } from "../src/types.js";

function meta(partial: Partial<SessionMeta> & Pick<SessionMeta, "id" | "status">): SessionMeta {
  const now = new Date().toISOString();
  return {
    command: ["cmd"],
    displayCommand: "cmd",
    cwd: "/",
    priorityReason: "running",
    socketPath: "/tmp/sock",
    cols: 80,
    rows: 24,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    ...partial
  };
}

describe("sortSessionsByPriority", () => {
  test("needs-attention sorts before others", () => {
    const sessions = [
      meta({ id: "a", status: "running" }),
      meta({ id: "b", status: "needs-attention" }),
      meta({ id: "c", status: "completed" })
    ];
    const sorted = sortSessionsByPriority(sessions);
    expect(sorted[0].id).toBe("b");
  });

  test("running sorts before completed and failed", () => {
    const sessions = [
      meta({ id: "done", status: "completed" }),
      meta({ id: "run", status: "running" })
    ];
    expect(sortSessionsByPriority(sessions)[0].id).toBe("run");
  });

  test("orders needs-attention, then running, then completed", () => {
    const sessions = [
      meta({ id: "c", status: "completed" }),
      meta({ id: "r", status: "running" }),
      meta({ id: "a", status: "needs-attention" })
    ];
    const sorted = sortSessionsByPriority(sessions).map((s) => s.id);
    expect(sorted).toEqual(["a", "r", "c"]);
  });

  test("available sorts between needs-attention and running", () => {
    const sessions = [
      meta({ id: "r", status: "running" }),
      meta({ id: "v", status: "available" }),
      meta({ id: "a", status: "needs-attention" })
    ];
    const sorted = sortSessionsByPriority(sessions).map((s) => s.id);
    expect(sorted).toEqual(["a", "v", "r"]);
  });

  test("ties broken by most recent update", () => {
    const sessions = [
      meta({ id: "old", status: "running", updatedAt: "2020-01-01T00:00:00.000Z" }),
      meta({ id: "new", status: "running", updatedAt: "2024-01-01T00:00:00.000Z" })
    ];
    expect(sortSessionsByPriority(sessions)[0].id).toBe("new");
  });

  test("status sorts before priority so needs-attention stays first", () => {
    const sessions = [
      meta({ id: "highprio-done", status: "completed", priority: 100 }),
      meta({ id: "lowprio-attn", status: "needs-attention", priority: 900 })
    ];
    expect(sortSessionsByPriority(sessions)[0].id).toBe("lowprio-attn");
  });

  test("absent priority is treated as 500", () => {
    const sessions = [
      meta({ id: "explicit-400", status: "running", priority: 400 }),
      meta({ id: "default", status: "running" }),
      meta({ id: "explicit-600", status: "running", priority: 600 })
    ];
    const sorted = sortSessionsByPriority(sessions).map((s) => s.id);
    expect(sorted).toEqual(["explicit-400", "default", "explicit-600"]);
  });

  test("within equal priority, full status order applies", () => {
    const sessions = [
      meta({ id: "disc", status: "disconnected", priority: 500 }),
      meta({ id: "fail", status: "failed", priority: 500 }),
      meta({ id: "done", status: "completed", priority: 500 }),
      meta({ id: "run", status: "running", priority: 500 }),
      meta({ id: "avail", status: "available", priority: 500 }),
      meta({ id: "attn", status: "needs-attention", priority: 500 })
    ];
    const sorted = sortSessionsByPriority(sessions).map((s) => s.id);
    expect(sorted).toEqual(["attn", "avail", "run", "done", "fail", "disc"]);
  });
});
