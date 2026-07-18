import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionMeta } from "../src/types.js";
import { freePort, waitFor, waitForHealth } from "./support/server.js";

// The dashboard server spawns sessions via the canonical Rust climon client
// (`climon __spawn`). Point CLIMON_CLIENT_BIN at the built debug binary.
const rustClient = join(process.cwd(), "rust", "target", "debug", "climon");

const home = join(process.cwd(), ".copilot-tmp", `climon-spawn-gate-${process.pid}`);
const env = { ...process.env, CLIMON_HOME: home, CLIMON_CLIENT_BIN: rustClient };

beforeAll(() => {
  if (!existsSync(rustClient)) {
    throw new Error(
      `Rust client binary not found at ${rustClient}. Build it first: (cd rust && cargo build -p climon-cli)`
    );
  }
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function startServer(port: number) {
  const server = Bun.spawn(
    [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(port)],
    { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
  );
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(server, base);
  return { server, base };
}

describe("POST /api/sessions feature gate", () => {
  test("returns 403 when sessionSpawning is disabled (default)", async () => {
    await mkdir(home, { recursive: true });
    const port = await freePort();
    const { server, base } = await startServer(port);
    try {
      const res = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: `${process.execPath} -e setTimeout(()=>{},1)` })
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Session spawning is disabled");
    } finally {
      server.kill();
      await server.exited;
    }
  }, 120000);

  test("spawns when sessionSpawning is enabled", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({ version: 1, feature: { sessionSpawning: "enabled" } })
    );
    const port = await freePort();
    const { server, base } = await startServer(port);
    let childId = "";
    try {
      const res = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: `${process.execPath} -e setTimeout(()=>{},30000)`, headless: true })
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id?: string };
      childId = body.id ?? "";
      expect(childId).toBeTruthy();
    } finally {
      const pid = childId
        ? await waitFor(async () => {
            const raw = await readFile(join(home, "sessions", `${childId}.json`), "utf8");
            return (JSON.parse(raw) as SessionMeta).daemonPid;
          }, 5000).catch(() => undefined)
        : undefined;

      // Stop the dashboard server first so the daemon's server.close() is not
      // blocked by its bridge client; daemonPid is the PTY child whose death
      // drives daemon shutdown.
      server.kill();
      await server.exited;

      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }

        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }
  }, 120000);
});
