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

  test("ties broken by most recent update", () => {
    const sessions = [
      meta({ id: "old", status: "running", updatedAt: "2020-01-01T00:00:00.000Z" }),
      meta({ id: "new", status: "running", updatedAt: "2024-01-01T00:00:00.000Z" })
    ];
    expect(sortSessionsByPriority(sessions)[0].id).toBe("new");
  });
});
