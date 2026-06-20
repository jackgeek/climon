import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSessionMeta } from "../src/store.js";
import type { SessionMeta } from "../src/types.js";

// The dashboard server spawns sessions by invoking the canonical Rust climon
// client (`climon __spawn`). Point CLIMON_CLIENT_BIN at the built debug binary so
// these tests exercise the real spawn path without depending on a sibling binary.
const rustClient = join(process.cwd(), "rust", "target", "debug", "climon");

// Use a real Linux-filesystem temp dir for CLIMON_HOME: unix domain sockets do
// not work on DrvFs-mounted Windows drives (e.g. /mnt/c), which is where the
// repo lives in WSL.
const home = join(tmpdir(), `climon-create-parent-${process.pid}`);
const env = { ...process.env, CLIMON_HOME: home, CLIMON_CLIENT_BIN: rustClient };

beforeAll(() => {
  if (!existsSync(rustClient)) {
    throw new Error(
      `Rust client binary not found at ${rustClient}. Build it first: (cd rust && cargo build -p climon-cli)`
    );
  }
});

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

function parentMeta(id: string): SessionMeta {
  const now = new Date().toISOString();
  return {
    id,
    command: ["sleep", "100"],
    displayCommand: "sleep 100",
    cwd: "/tmp",
    status: "running",
    priorityReason: "running",
    socketPath: join(home, "sockets", `${id}.sock`),
    cols: 100,
    rows: 40,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now
  };
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("POST /api/sessions with a parentId", () => {
  test("spawns a child of any live session inheriting its cwd; 404 for unknown parent", async () => {
    const parentId = "parent-1";
    const longRunningCommand = `${process.execPath} -e setTimeout(()=>{},30000)`;
    await writeSessionMeta(parentMeta(parentId), env);
    // Session spawning is gated behind the sessionSpawning feature flag (disabled
    // by default); enable it so the spawn endpoint is reachable for this test.
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({ version: 1, feature: { sessionSpawning: "enabled" } })
    );

    const port = await freePort();
    const server = Bun.spawn(
      [process.execPath, "src/index.ts", "server", "--no-takeover", "--port", String(port)],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );

    const base = `http://127.0.0.1:${port}`;
    let childId = "";
    try {
      await waitFor(async () => {
        const res = await fetch(`${base}/health`).catch(() => undefined);
        return res?.ok ? true : undefined;
      });

      const childCwd = await mkdtemp(join(tmpdir(), "climon-child-cwd-"));
      const ok = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: longRunningCommand, parentId, cwd: childCwd, headless: true })
      });
      expect(ok.status).toBe(201);
      const body = (await ok.json()) as { id?: string };
      expect(body.id).toBeTruthy();
      childId = body.id ?? "";

      const childMeta = JSON.parse(
        await readFile(join(home, "sessions", `${childId}.json`), "utf8")
      ) as SessionMeta;
      expect(childMeta.cwd).toBe(childCwd);

      const missing = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: longRunningCommand, parentId: "does-not-exist" })
      });
      expect(missing.status).toBe(404);
    } finally {
      // Stop the child session's daemon so nothing lingers.
      if (childId) {
        const pid = await waitFor(async () => {
          const raw = await readFile(join(home, "sessions", `${childId}.json`), "utf8");
          return (JSON.parse(raw) as SessionMeta).daemonPid;
        }, 5000).catch(() => undefined);
        if (pid) {
          try {
            process.kill(pid);
          } catch {
            // already gone
          }
        }
      }
      server.kill();
      await server.exited;
    }
  }, 60000);
});
