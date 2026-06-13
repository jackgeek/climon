import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServerStateFromDir } from "../src/server-state.js";

const home = join(tmpdir(), `climon-no-shutdown-endpoint-${process.pid}`);
const env = { ...process.env, CLIMON_HOME: home };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 20000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Bound each attempt so a hung probe (e.g. a fetch to a freshly-spawned
    // server whose event loop is still starved under load) cannot block the
    // loop past the deadline.
    const v = await Promise.race([
      Promise.resolve().then(fn).catch(() => undefined),
      new Promise<undefined>((r) => setTimeout(r, 1000, undefined))
    ]);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("DELETE /api/server is removed", () => {
  test("a DELETE with the (former) shutdown token no longer shuts the dashboard down", async () => {
    const port = await freePort();
    const server = Bun.spawn([process.execPath, "src/server.ts", "server", "--port", String(port)], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe"
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      // Spawning src/server.ts transpiles on each launch; under full-suite CPU
      // contention startup can take well over the old 5s wait, so allow more time.
      await waitFor(async () => {
        const res = await fetch(`${base}/health`).catch(() => undefined);
        return res?.ok ? true : undefined;
      }, 30000);
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
  }, 60000);
});
