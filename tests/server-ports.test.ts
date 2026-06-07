import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = join(tmpdir(), `climon-server-ports-${process.pid}`);
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

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => {
      s.close(() => resolve(true));
    });
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) {
      return v;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("server port safety", () => {
  test("health reports the bound dashboard port and writes it to the state file", async () => {
    const port = await freePort();
    const server = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--port", String(port)],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const base = `http://127.0.0.1:${port}`;
    try {
      const body = await waitFor(async () => {
        const res = await fetch(`${base}/health`).catch(() => undefined);
        return res?.ok
          ? ((await res.json()) as { ok?: boolean; ports?: { dashboard?: number } })
          : undefined;
      });
      expect(body.ok).toBe(true);
      expect(body.ports?.dashboard).toBe(port);

      const state = JSON.parse(await readFile(join(home, "server.json"), "utf8")) as {
        pid?: number;
        port?: number;
      };
      expect(state.port).toBe(port);
      expect(state.pid).toBe(server.pid);
    } finally {
      server.kill();
      await server.exited;
    }
  }, 30000);

  test("releases the port and removes the state file on shutdown", async () => {
    const port = await freePort();
    const server = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--port", String(port)],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      const res = await fetch(`${base}/health`).catch(() => undefined);
      return res?.ok ? true : undefined;
    });

    // Hold an SSE connection open: a naive stop() would wait on this and leak
    // the port. Safe shutdown must force it closed.
    const sse = await fetch(`${base}/api/events`).catch(() => undefined);
    void sse?.body?.getReader().read().catch(() => undefined);

    server.kill("SIGTERM");
    await server.exited;

    const released = await waitFor(async () => {
      return (await portFree(port)) ? true : undefined;
    });
    expect(released).toBe(true);

    // On POSIX the SIGTERM handler runs and removes the state file. Windows
    // terminates the process abruptly (no catchable SIGTERM), so the next
    // server start overwrites the stale file instead.
    if (process.platform !== "win32") {
      await expect(readFile(join(home, "server.json"), "utf8")).rejects.toThrow();
    }
  }, 30000);
});
