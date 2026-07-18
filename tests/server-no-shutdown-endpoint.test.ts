import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServerStateFromDir } from "../src/server-state.js";
import { freePort, waitFor, waitForHealth } from "./support/server.js";

const home = join(tmpdir(), `climon-no-shutdown-endpoint-${process.pid}`);
const env = { ...process.env, CLIMON_HOME: home };

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("DELETE /api/server is removed", () => {
  test("a DELETE with the (former) shutdown token no longer shuts the dashboard down", async () => {
    const port = await freePort();
    const server = Bun.spawn([process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(port)], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe"
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      // Spawning src/server.ts transpiles on each launch; under full-suite CPU
      // contention startup can take well over the old 5s wait, so allow more time.
      await waitForHealth(server, base);
      await waitFor(async () => {
        const s = await readServerStateFromDir(home);
        return s ? s : undefined;
      }, 30000);
      await fetch(`${base}/api/server`, {
        method: "DELETE",
        headers: { "X-Climon-Shutdown-Token": "fake-token" }
      }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 400));
      // Bound this fetch so a hung connection fails fast instead of stalling to
      // the test-level timeout.
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
      expect(health.ok).toBe(true); // still serving — the route no longer demotes
    } finally {
      server.kill();
      await server.exited;
    }
  }, 120000);
});
