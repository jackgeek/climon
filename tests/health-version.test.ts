import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getIngestPidPath } from "../src/remote/ingest.js";
import { VERSION } from "../src/version.js";

const home = join(process.cwd(), ".test-home", `climon-health-${process.pid}`);
const env = { ...process.env, CLIMON_HOME: home };

// A server started with remotes enabled spawns a detached ingest daemon that
// outlives the killed server process. Tests must stop it explicitly, otherwise
// the orphaned ingest accumulates across runs (and can busy-loop on a core),
// progressively slowing the whole suite under load.
async function stopIngestDaemon(targetEnv: NodeJS.ProcessEnv): Promise<void> {
  const raw = await readFile(getIngestPidPath(targetEnv), "utf8").catch(() => undefined);
  const pid = raw === undefined ? 0 : Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(pid);
  } catch {
    return;
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

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

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Bound each attempt so a hung probe (e.g. a fetch to a freshly-spawned
    // server whose event loop is still starved under load) cannot block the
    // loop past the deadline.
    const v = await Promise.race([
      Promise.resolve().then(fn).catch(() => undefined),
      new Promise<undefined>((r) => setTimeout(r, 1000, undefined))
    ]);
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

describe("GET /health", () => {
  test("reports the server version", async () => {
    const port = await freePort();
    const server = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(port)],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const base = `http://127.0.0.1:${port}`;
    try {
      const body = await waitFor(async () => {
        const res = await fetch(`${base}/health`).catch(() => undefined);
        return res?.ok ? ((await res.json()) as { ok?: boolean; version?: string }) : undefined;
      });
      expect(body.ok).toBe(true);
      expect(body.version).toBe(VERSION);
    } finally {
      server.kill();
      await server.exited;
    }
  }, 60000);

  test("reports remotes enabled from feature config", async () => {
    const port = await freePort();
    const server = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(port)],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const base = `http://127.0.0.1:${port}`;
    try {
      const body = await waitFor(async () => {
        const res = await fetch(`${base}/health`).catch(() => undefined);
        return res?.ok ? ((await res.json()) as { remotesEnabled?: boolean }) : undefined;
      });
      expect(body.remotesEnabled).toBe(false);
    } finally {
      server.kill();
      await server.exited;
    }

    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.jsonc"), JSON.stringify({ feature: { remotes: "enabled" } }));

    const enabledPort = await freePort();
    const enabledServer = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(enabledPort)],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const enabledBase = `http://127.0.0.1:${enabledPort}`;
    try {
      const body = await waitFor(async () => {
        const res = await fetch(`${enabledBase}/health`).catch(() => undefined);
        return res?.ok ? ((await res.json()) as { remotesEnabled?: boolean }) : undefined;
      });
      expect(body.remotesEnabled).toBe(true);
    } finally {
      enabledServer.kill();
      await enabledServer.exited;
      await stopIngestDaemon(env);
    }
  }, 60000);
});
