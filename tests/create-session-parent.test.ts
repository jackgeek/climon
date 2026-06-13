import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSessionMeta } from "../src/store.js";
import type { SessionMeta } from "../src/types.js";

// Use a real Linux-filesystem temp dir for CLIMON_HOME: unix domain sockets do
// not work on DrvFs-mounted Windows drives (e.g. /mnt/c), which is where the
// repo lives in WSL.
const home = join(tmpdir(), `climon-create-parent-${process.pid}`);
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

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
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

    const port = await freePort();
    const server = Bun.spawn(
      [process.execPath, "src/index.ts", "server", "--port", String(port)],
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
        body: JSON.stringify({ command: longRunningCommand, parentId, cwd: childCwd })
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
  }, 30000);
});
