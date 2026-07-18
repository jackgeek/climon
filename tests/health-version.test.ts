import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getIngestPidPath } from "../src/remote/ingest.js";
import { readServerStateFromDir } from "../src/server-state.js";
import { VERSION } from "../src/version.js";
import { freePort, waitFor, waitForHealth } from "./support/server.js";

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
    let base = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(server, base);
      const body = await waitFor(async () => {
        const res = await fetch(`${base}/health`).catch(() => undefined);
        if (res?.ok) return (await res.json()) as { ok?: boolean; version?: string };
        const state = await readServerStateFromDir(home);
        if (state?.port) base = `http://127.0.0.1:${state.port}`;
        return undefined;
      });
      expect(body.ok).toBe(true);
      expect(body.version).toBe(VERSION);
    } finally {
      server.kill();
      await server.exited;
    }
  }, 120000);

  test("reports remotes enabled from feature config", async () => {
    const port = await freePort();
    const server = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(port)],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    let base = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(server, base);
      const body = await waitFor(async () => {
        const res = await fetch(`${base}/health`).catch(() => undefined);
        if (res?.ok) return (await res.json()) as { remotesEnabled?: boolean };
        const state = await readServerStateFromDir(home);
        if (state?.port) base = `http://127.0.0.1:${state.port}`;
        return undefined;
      });
      expect(body.remotesEnabled).toBe(false);
    } finally {
      server.kill();
      await server.exited;
    }

    const ingestPort = await freePort();
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        feature: { remotes: "enabled" },
        remote: { ingestHost: "127.0.0.1", port: ingestPort, ingestPortRetryAttempts: 5 }
      })
    );

    const enabledPort = await freePort();
    const enabledServer = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(enabledPort)],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    let enabledBase = `http://127.0.0.1:${enabledPort}`;
    try {
      await waitForHealth(enabledServer, enabledBase);
      const body = await waitFor(async () => {
        const res = await fetch(`${enabledBase}/health`).catch(() => undefined);
        if (res?.ok) return (await res.json()) as { remotesEnabled?: boolean };
        const state = await readServerStateFromDir(home);
        if (state?.port) enabledBase = `http://127.0.0.1:${state.port}`;
        return undefined;
      });
      expect(body.remotesEnabled).toBe(true);
    } finally {
      enabledServer.kill();
      await enabledServer.exited;
      await stopIngestDaemon(env);
    }
  }, 120000);
});
