import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { patchSessionMeta, readSessionMeta, writeSessionMeta } from "../src/store.js";
import type { SessionMeta } from "../src/types.js";

const home = join(process.cwd(), `.climon-store-concurrency-${process.pid}`);
const env = { ...process.env, CLIMON_HOME: home };

function baseMeta(id: string): SessionMeta {
  const now = new Date().toISOString();
  return {
    id,
    command: ["sleep", "100"],
    displayCommand: "sleep 100",
    cwd: "/tmp",
    status: "running",
    priorityReason: "running",
    socketPath: join(home, "sockets", `${id}.sock`),
    cols: 80,
    rows: 24,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now
  };
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("patchSessionMeta concurrency", () => {
  test("concurrent patches on different fields are not lost", async () => {
    const id = "concurrent-1";
    await writeSessionMeta(baseMeta(id), env);

    // Simulate the client-connect burst: two patches on different fields fired
    // on the same tick. A non-atomic read-merge-write races and drops one of
    // the two fields.
    await Promise.all([
      patchSessionMeta(id, { daemonPid: 4242 }, env),
      patchSessionMeta(id, { status: "needs-attention", priorityReason: "attention" }, env)
    ]);

    const meta = await readSessionMeta(id, env);
    expect(meta?.daemonPid).toBe(4242);
    expect(meta?.status).toBe("needs-attention");
    expect(meta?.priorityReason).toBe("attention");
  });

  test("many interleaved patches all persist", async () => {
    const id = "concurrent-2";
    await writeSessionMeta(baseMeta(id), env);

    await Promise.all([
      patchSessionMeta(id, { daemonPid: 4242 }, env),
      patchSessionMeta(id, { exitCode: 0 }, env),
      patchSessionMeta(id, { status: "needs-attention" }, env),
      patchSessionMeta(id, { attentionReason: "Screen idle for 10s" }, env),
      patchSessionMeta(id, { cols: 120, rows: 40 }, env)
    ]);

    const meta = await readSessionMeta(id, env);
    expect(meta?.daemonPid).toBe(4242);
    expect(meta?.exitCode).toBe(0);
    expect(meta?.status).toBe("needs-attention");
    expect(meta?.attentionReason).toBe("Screen idle for 10s");
    expect(meta?.cols).toBe(120);
    expect(meta?.rows).toBe(40);
  });
});
