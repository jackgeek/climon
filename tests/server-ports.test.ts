import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, waitFor, waitForHealth } from "./support/server.js";

const home = join(tmpdir(), `climon-server-ports-${process.pid}`);
const env = { ...process.env, CLIMON_HOME: home };

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => {
      s.close(() => resolve(true));
    });
  });
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("server port safety", () => {
  test("health reports the bound dashboard port and writes it to the state file", async () => {
    const port = await freePort();
    const server = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(port)],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(server, base);
      const body = await waitFor(async () => {
        const res = await fetch(`${base}/health`).catch(() => undefined);
        return res?.ok
          ? ((await res.json()) as { ok?: boolean; ports?: { dashboard?: number } })
          : undefined;
      }, 30000);
      expect(body.ok).toBe(true);
      expect(body.ports?.dashboard).toBe(port);

      // The state file is written around startup; poll for it (and the
      // expected pid/port) rather than reading once to avoid a write race.
      const state = await waitFor(async () => {
        const raw = await readFile(join(home, "server.json"), "utf8").catch(() => undefined);
        if (raw === undefined) {
          return undefined;
        }
        const parsed = JSON.parse(raw) as { pid?: number; port?: number };
        return parsed.port === port && parsed.pid === server.pid ? parsed : undefined;
      }, 10000);
      expect(state.port).toBe(port);
      expect(state.pid).toBe(server.pid);
    } finally {
      server.kill();
      await server.exited;
    }
  }, 120000);

  test("releases the port and removes the state file on shutdown", async () => {
    const port = await freePort();
    const server = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(port)],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const base = `http://127.0.0.1:${port}`;
    await waitForHealth(server, base);

    // Hold an SSE connection open: a naive stop() would wait on this and leak
    // the port. Safe shutdown must force it closed.
    const sse = await fetch(`${base}/api/events`).catch(() => undefined);
    void sse?.body?.getReader().read().catch(() => undefined);

    server.kill("SIGTERM");
    await server.exited;

    const released = await waitFor(async () => {
      return (await portFree(port)) ? true : undefined;
    }, 10000);
    expect(released).toBe(true);

    // On POSIX the SIGTERM handler runs and removes the state file. Windows
    // terminates the process abruptly (no catchable SIGTERM), so the next
    // server start overwrites the stale file instead.
    if (process.platform !== "win32") {
      await expect(readFile(join(home, "server.json"), "utf8")).rejects.toThrow();
    }
  }, 120000);
});
