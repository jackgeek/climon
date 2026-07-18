import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIngestPidPath } from "../src/remote/ingest.js";
import { parseBrowserStatusPatch, validateBrowserStatusTransition } from "../src/server/server.js";
import { readSessionMeta, writeSessionMeta } from "../src/store.js";
import type { PriorityReason, SessionMeta, SessionStatus } from "../src/types.js";
import { freePort, waitFor, waitForExit, waitForHealth } from "./support/server.js";

const testRoot = join(tmpdir(), "climon-server-status-patch");

function priorityReasonFor(status: SessionStatus): PriorityReason {
  switch (status) {
    case "needs-attention":
      return "attention";
    case "acknowledged":
    case "paused":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "disconnected":
      return "disconnected";
  }
}

function sessionMeta(home: string, id: string, status: SessionStatus): SessionMeta {
  const now = new Date().toISOString();
  return {
    id,
    command: ["bash"],
    displayCommand: "bash",
    cwd: process.cwd(),
    status,
    priorityReason: priorityReasonFor(status),
    socketPath: join(home, "sock", `${id}.sock`),
    cols: 80,
    rows: 24,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now
  };
}

async function stopIngestDaemon(env: NodeJS.ProcessEnv): Promise<void> {
  const raw = await readFile(getIngestPidPath(env), "utf8").catch(() => undefined);
  const pid = raw === undefined ? 0 : Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(pid);
  } catch {
    return;
  }
  await waitFor(async () => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch {
      return true;
    }
  }, 2000).catch(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  });
}

async function patchStatus(base: string, id: string, status: string): Promise<Response> {
  return fetch(`${base}/api/sessions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status })
  });
}

describe("parseBrowserStatusPatch", () => {
  test("accepts the browser pause status", () => {
    expect(parseBrowserStatusPatch("paused")).toBe("paused");
  });

  test("accepts the browser resume status", () => {
    expect(parseBrowserStatusPatch("running")).toBe("running");
  });

  test("rejects terminal and automation-owned statuses", () => {
    expect(() => parseBrowserStatusPatch("completed")).toThrow(/Invalid status/);
    expect(() => parseBrowserStatusPatch("failed")).toThrow(/Invalid status/);
    expect(() => parseBrowserStatusPatch("disconnected")).toThrow(/Invalid status/);
    expect(() => parseBrowserStatusPatch("acknowledged")).toThrow(/Invalid status/);
    expect(() => parseBrowserStatusPatch("needs-attention")).toThrow(/Invalid status/);
  });

  test("rejects non-string status values", () => {
    expect(() => parseBrowserStatusPatch(123)).toThrow(/Invalid status/);
    expect(() => parseBrowserStatusPatch(null)).toThrow(/Invalid status/);
  });
});

describe("PATCH /api/sessions/:id status", () => {
  // Share a single dashboard server across these cases. Each test uses a unique
  // session id, so they don't interfere, and we avoid spawning (and cold-
  // transpiling) a fresh server subprocess per test — the main source of
  // timing flakiness when the suite runs under load.
  const home = join(testRoot, `home-${process.pid}`);
  const env = { ...process.env, CLIMON_HOME: home };
  let server: Bun.Subprocess;
  let base = "";

  beforeAll(async () => {
    await mkdir(home, { recursive: true });
    const port = await freePort();
    server = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(port)],
      { cwd: process.cwd(), env, stdout: "ignore", stderr: "ignore" }
    );
    base = `http://127.0.0.1:${port}`;
    await waitForHealth(server, base);
  }, 120_000);

  afterAll(async () => {
    server.kill();
    const exited = await waitForExit(server, 2000);
    if (!exited) {
      const pid = server.pid;
      if (pid && Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
      await waitForExit(server, 1000);
    }
    await stopIngestDaemon(env);
    await rm(testRoot, { recursive: true, force: true });
  });

  test("pauses a running session and records the running priority reason", async () => {
    await writeSessionMeta(sessionMeta(home, "sess-running", "running"), env);

    const res = await patchStatus(base, "sess-running", "paused");

    expect(res.status).toBe(200);
    const persisted = await readSessionMeta("sess-running", env);
    expect(persisted?.status).toBe("paused");
    expect(persisted?.priorityReason).toBe("running");
    expect(persisted?.userPaused).toBe(true);
  });

  test("pauses an acknowledged session", async () => {
    await writeSessionMeta(sessionMeta(home, "sess-acknowledged", "acknowledged"), env);

    const res = await patchStatus(base, "sess-acknowledged", "paused");

    expect(res.status).toBe(200);
    const persisted = await readSessionMeta("sess-acknowledged", env);
    expect(persisted?.status).toBe("paused");
  });

  test("pauses a needs-attention session", async () => {
    await writeSessionMeta(sessionMeta(home, "sess-attention", "needs-attention"), env);

    const res = await patchStatus(base, "sess-attention", "paused");

    expect(res.status).toBe(200);
    const persisted = await readSessionMeta("sess-attention", env);
    expect(persisted?.status).toBe("paused");
  });

  test("keeps a paused session paused when pausing again", () => {
    expect(() => validateBrowserStatusTransition("paused", "paused")).not.toThrow();
  });

  test("resumes a paused session", async () => {
    await writeSessionMeta(sessionMeta(home, "sess-paused", "paused"), env);

    const res = await patchStatus(base, "sess-paused", "running");

    expect(res.status).toBe(200);
    const persisted = await readSessionMeta("sess-paused", env);
    expect(persisted?.status).toBe("running");
    expect(persisted?.userPaused).toBe(false);
  });

  test("rejects pausing a failed session and leaves it failed", async () => {
    await writeSessionMeta(sessionMeta(home, "sess-failed", "failed"), env);

    const res = await patchStatus(base, "sess-failed", "paused");

    expect(res.status).toBe(400);
    const persisted = await readSessionMeta("sess-failed", env);
    expect(persisted?.status).toBe("failed");
  });

  test("rejects resuming a disconnected session and leaves it disconnected", async () => {
    await writeSessionMeta(sessionMeta(home, "sess-disconnected", "disconnected"), env);

    const res = await patchStatus(base, "sess-disconnected", "running");

    expect(res.status).toBe(400);
    const persisted = await readSessionMeta("sess-disconnected", env);
    expect(persisted?.status).toBe("disconnected");
  });

  test("rejects resuming a completed session and leaves it completed", async () => {
    await writeSessionMeta(sessionMeta(home, "sess-completed", "completed"), env);

    const res = await patchStatus(base, "sess-completed", "running");

    expect(res.status).toBe(400);
    const persisted = await readSessionMeta("sess-completed", env);
    expect(persisted?.status).toBe("completed");
  });

  test("rejects browser attempts to set terminal statuses", async () => {
    await writeSessionMeta(sessionMeta(home, "sess-invalid", "running"), env);

    const res = await patchStatus(base, "sess-invalid", "completed");

    expect(res.status).toBe(400);
    const persisted = await readSessionMeta("sess-invalid", env);
    expect(persisted?.status).toBe("running");
  });

  test("returns 404 when status is patched on a missing session", async () => {
    const res = await patchStatus(base, "missing", "paused");

    expect(res.status).toBe(404);
  });

  test("still applies metadata-only patches without requiring an existing status transition", async () => {
    await writeSessionMeta(sessionMeta(home, "sess-priority", "completed"), env);

    const res = await fetch(`${base}/api/sessions/sess-priority`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: 100 })
    });

    expect(res.status).toBe(200);
    const persisted = await readSessionMeta("sess-priority", env);
    expect(persisted?.status).toBe("completed");
    expect(persisted?.priority).toBe(100);
  });

  test("does not patch metadata when a requested status transition is invalid", async () => {
    await writeSessionMeta(sessionMeta(home, "sess-mixed", "completed"), env);

    const res = await fetch(`${base}/api/sessions/sess-mixed`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed", status: "running" })
    });

    expect(res.status).toBe(400);
    const persisted = await readSessionMeta("sess-mixed", env);
    expect(persisted?.status).toBe("completed");
    expect(persisted?.name).toBeUndefined();
  });
});
