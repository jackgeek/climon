import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_IDLE_TIMEOUT_SECONDS,
  buildRunArgs,
  resolveParentSpawnColor,
  resolveParentSpawnCwd
} from "../src/server/server.js";
import type { SpawnMetaOptions } from "../src/server/server.js";

const unresolvedSpawnMeta: SpawnMetaOptions = { color: "auto" };
void unresolvedSpawnMeta;

describe("buildRunArgs", () => {
  test("adds no metadata flags when none provided", () => {
    expect(buildRunArgs(["npm", "run", "dev"], {})).toEqual([
      "run", "--headless", "npm", "run", "dev"
    ]);
  });

  describe("dashboard server timeout", () => {
    test("uses a long idle timeout for dashboard SSE and WebSocket connections", () => {
      expect(DASHBOARD_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(10);
    });
  });

  test("prepends priority, color, and name flags before the command", () => {
    expect(buildRunArgs(["bash"], { priority: 800, color: "red", name: "shell" })).toEqual([
      "run", "--headless", "--priority", "800", "--color", "red", "--name", "shell", "bash"
    ]);
  });

  test("emits --color none to clear an inherited color", () => {
    expect(buildRunArgs(["bash"], { color: null })).toEqual([
      "run", "--headless", "--color", "none", "bash"
    ]);
  });

  test("emits --color auto for auto color mode", () => {
    expect(buildRunArgs(["bash"], { color: "auto" })).toEqual([
      "run", "--headless", "--color", "auto", "bash"
    ]);
  });

  test("resolves absent parent color inheritance to none", async () => {
    await expect(resolveParentSpawnColor(undefined, undefined, process.cwd())).resolves.toBeNull();
  });

  test("uses an explicit cwd over the selected parent session cwd", () => {
    expect(resolveParentSpawnCwd(" /tmp/child ", "/tmp/parent")).toBe("/tmp/child");
  });
});
