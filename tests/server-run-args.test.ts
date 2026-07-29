import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_IDLE_TIMEOUT_SECONDS,
  SSE_KEEP_ALIVE_INTERVAL_MS,
  buildRunArgs,
  buildSpawnArgs,
  resolveParentSpawnColor,
  resolveParentSpawnCwd,
  startSseKeepAlive
} from "../src/server/server.js";
import type { SpawnMetaOptions } from "../src/server/server.js";

const unresolvedSpawnMeta: SpawnMetaOptions = { color: "auto" };
void unresolvedSpawnMeta;

describe("buildSpawnArgs", () => {
  test("headless with metadata flags", () => {
    expect(buildSpawnArgs(["npm", "test"], {
      headless: true, cwd: "/work", cols: 100, rows: 30,
      meta: { name: "ci", priority: 800, color: "red" }
    })).toEqual([
      "__spawn", "--headless", "--cwd", "/work", "--cols", "100", "--rows", "30",
      "--priority", "800", "--color", "red", "--name", "ci", "npm", "test"
    ]);
  });

  test("visible omits --headless", () => {
    expect(buildSpawnArgs(["bash"], {
      headless: false, cwd: "/w", cols: 80, rows: 24, meta: {}
    })).toEqual(["__spawn", "--cwd", "/w", "--cols", "80", "--rows", "24", "bash"]);
  });

  test("emits --color none to clear an inherited color", () => {
    expect(buildSpawnArgs(["bash"], {
      headless: true, cwd: "/w", cols: 80, rows: 24, meta: { color: null }
    })).toEqual([
      "__spawn", "--headless", "--cwd", "/w", "--cols", "80", "--rows", "24", "--color", "none", "bash"
    ]);
  });

  test("emits --theme when set", () => {
    const args = buildSpawnArgs(["bash"], {
      headless: true, cwd: "/w", cols: 80, rows: 24, meta: { theme: "Monokai Soda" }
    });
    expect(args).toContain("--theme");
    expect(args).toContain("Monokai Soda");
  });

  test("omits --theme when empty or unset", () => {
    expect(buildSpawnArgs(["bash"], {
      headless: true, cwd: "/w", cols: 80, rows: 24, meta: { theme: "" }
    })).not.toContain("--theme");
    expect(buildSpawnArgs(["bash"], {
      headless: true, cwd: "/w", cols: 80, rows: 24, meta: {}
    })).not.toContain("--theme");
  });
});

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

    test("keeps idle SSE connections alive through tunnel proxy timeouts", () => {
      const messages: string[] = [];
      const clients = new Set([
        {
          enqueue(chunk: Uint8Array) {
            messages.push(new TextDecoder().decode(chunk));
          }
        }
      ]);
      let tick: (() => void) | undefined;
      let scheduledMs = 0;
      let clearedHandle: unknown;

      const stop = startSseKeepAlive(clients, {
        setInterval(callback, ms) {
          tick = callback;
          scheduledMs = ms;
          return "heartbeat";
        },
        clearInterval(handle) {
          clearedHandle = handle;
        }
      });

      expect(scheduledMs).toBe(SSE_KEEP_ALIVE_INTERVAL_MS);
      expect(scheduledMs).toBeLessThan(30_000);
      tick?.();
      expect(messages).toEqual([": keepalive\n\n"]);

      stop();
      expect(clearedHandle).toBe("heartbeat");
    });
  });

  test("prepends priority, color, and name flags before the command", () => {
    expect(buildRunArgs(["bash"], { priority: 800, color: "red", name: "shell" })).toEqual([
      "run", "--headless", "--priority", "800", "--color", "red", "--name", "shell", "bash"
    ]);
  });

  test("emits --theme when set", () => {
    const args = buildRunArgs(["bash"], { theme: "Dracula" });
    expect(args).toContain("--theme");
    expect(args).toContain("Dracula");
  });

  test("omits --theme when empty or unset", () => {
    expect(buildRunArgs(["bash"], { theme: "" })).not.toContain("--theme");
    expect(buildRunArgs(["bash"], {})).not.toContain("--theme");
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
