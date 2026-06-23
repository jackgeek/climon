import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { isAllowedDashboardHost } from "../src/server/server.js";
import { readSessionMeta, writeScrollback, writeSessionMeta } from "../src/store.js";
import type { SessionMeta } from "../src/types.js";

const testRoot = join(process.cwd(), ".copilot-tmp", "dashboard-host-guard", String(process.pid));

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

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await Promise.race([
      Promise.resolve().then(fn).catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(resolve, 1000, undefined))
    ]);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

async function waitForExit(server: Bun.Subprocess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(false);
    }, ms);
    void server.exited.finally(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function sessionMeta(home: string, id: string): SessionMeta {
  const now = new Date().toISOString();
  return {
    id,
    command: ["bash"],
    displayCommand: "bash",
    cwd: process.cwd(),
    status: "completed",
    priorityReason: "completed",
    socketPath: join(home, "sock", `${id}.sock`),
    cols: 80,
    rows: 24,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now
  };
}

describe("isAllowedDashboardHost (rebinding guard)", () => {
  it("permits loopback and tunnel", () => {
    expect(isAllowedDashboardHost("127.0.0.1:3131")).toBe(true);
    expect(isAllowedDashboardHost("x-3131.uks1.devtunnels.ms")).toBe(true);
  });
  it("rejects a rebinding or missing host", () => {
    expect(isAllowedDashboardHost("evil.com:3131")).toBe(false);
    expect(isAllowedDashboardHost(null)).toBe(false);
  });
});

describe("dashboard read and destructive routes", () => {
  const home = join(testRoot, "home");
  const env = { ...process.env, CLIMON_HOME: home };
  let server: Bun.Subprocess;
  let base = "";

  beforeAll(async () => {
    await rm(testRoot, { recursive: true, force: true });
    await mkdir(home, { recursive: true });
    await writeSessionMeta(sessionMeta(home, "guarded"), env);
    await writeScrollback("guarded", Buffer.from("secret scrollback"), env);

    const port = await freePort();
    server = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(port)],
      { cwd: process.cwd(), env, stdout: "ignore", stderr: "ignore" }
    );
    base = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      const res = await fetch(`${base}/health`).catch(() => undefined);
      return res?.ok ? true : undefined;
    }, 30_000);
  }, 60_000);

  afterAll(async () => {
    server.kill();
    if (!(await waitForExit(server, 2000))) {
      const pid = server.pid;
      if (pid && Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
      await server.exited.catch(() => undefined);
    }
    await rm(testRoot, { recursive: true, force: true });
  });

  it("rejects DNS-rebinding Host headers before exposing sessions, scrollback, events, or DELETE", async () => {
    const headers = { host: "evil.com:3131" };
    const list = await fetch(`${base}/api/sessions`, { headers });
    expect(list.status).toBe(403);

    const scrollback = await fetch(`${base}/api/sessions/guarded/scrollback`, { headers });
    expect(scrollback.status).toBe(403);

    const events = await fetch(`${base}/api/events`, { headers });
    expect(events.status).toBe(403);
    await events.body?.cancel();

    const del = await fetch(`${base}/api/sessions/guarded`, { method: "DELETE", headers });
    expect(del.status).toBe(403);
    expect(await readSessionMeta("guarded", env)).toBeDefined();
  });

  it("still permits loopback and dev-tunnel Host headers", async () => {
    const loopback = await fetch(`${base}/api/sessions`, { headers: { host: "127.0.0.1:3131" } });
    expect(loopback.status).toBe(200);

    const tunnel = await fetch(`${base}/api/sessions`, { headers: { host: "x-3131.uks1.devtunnels.ms" } });
    expect(tunnel.status).toBe(200);
  });
});
