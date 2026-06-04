import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import {
  acquireSessionMetaPatchLockForTest,
  patchSessionMeta,
  patchSessionMetaWithCurrent,
  readSessionMeta,
  setPatchLockTestHooksForTest,
  writeSessionMeta
} from "../src/store.js";
import { getSessionMetaPath } from "../src/config.js";
import type { SessionMeta } from "../src/types.js";

const home = join(process.cwd(), `.climon-store-concurrency-${process.pid}`);
const env = { ...process.env, CLIMON_HOME: home };

async function lockOwner(pid: number): Promise<Record<string, unknown>> {
  let pidNamespace: string | undefined;
  if (process.platform === "linux") {
    try {
      pidNamespace = await readlink("/proc/self/ns/pid");
    } catch {
      pidNamespace = undefined;
    }
  }
  return {
    pid,
    createdAt: new Date().toISOString(),
    hostname: hostname(),
    platform: process.platform,
    ...(pidNamespace ? { pidNamespace } : {})
  };
}

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

  test("conditional patches reject against current metadata without applying metadata fields", async () => {
    const id = "conditional-current";
    await writeSessionMeta({ ...baseMeta(id), status: "completed", priorityReason: "completed", name: undefined }, env);

    await expect(
      patchSessionMetaWithCurrent(
        id,
        { status: "running", name: "renamed" },
        (current) => {
          if (current.status === "completed") {
            throw new Error("cannot resume completed session");
          }
        },
        env
      )
    ).rejects.toThrow(/cannot resume completed session/);

    const meta = await readSessionMeta(id, env);
    expect(meta?.status).toBe("completed");
    expect(meta?.name).toBeUndefined();
  });

  test("conditional patches do not overwrite terminal status from another process", async () => {
    const id = "conditional-cross-process";
    const signalPath = join(home, `${id}.signal`);
    await writeSessionMeta(baseMeta(id), env);

    const terminalWriter = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
          import { existsSync } from "node:fs";
          import { patchSessionMeta } from "./src/store.ts";
          while (!existsSync(${JSON.stringify(signalPath)})) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await patchSessionMeta(${JSON.stringify(id)}, { status: "completed", priorityReason: "completed" });
        `
      ],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );

    await patchSessionMetaWithCurrent(
      id,
      { status: "paused", priorityReason: "running" },
      () => {
        writeFileSync(signalPath, "go");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      },
      env
    );
    expect(await terminalWriter.exited).toBe(0);

    const meta = await readSessionMeta(id, env);
    expect(meta?.status).toBe("completed");
    expect(meta?.priorityReason).toBe("completed");
  });

  test("patchSessionMeta recovers a stale lock owned by a dead process", async () => {
    const id = "stale-dead-owner";
    await writeSessionMeta(baseMeta(id), env);
    const lockPath = `${getSessionMetaPath(id, env)}.lock`;
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify(await lockOwner(999999999)));

    await patchSessionMeta(id, { daemonPid: 1234 }, env);

    const meta = await readSessionMeta(id, env);
    expect(meta?.daemonPid).toBe(1234);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("fresh live locks are preserved when acquisition times out", async () => {
    const id = "fresh-live-owner";
    await writeSessionMeta(baseMeta(id), env);
    const lockPath = `${getSessionMetaPath(id, env)}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
    );

    await expect(acquireSessionMetaPatchLockForTest(id, env, { timeoutMs: 30, retryMs: 5 })).rejects.toThrow(
      /Timed out waiting for session metadata lock/
    );

    expect(existsSync(lockPath)).toBe(true);
  });

  test("fresh locks from a foreign owner are preserved until age-based staleness", async () => {
    const id = "fresh-foreign-owner";
    await writeSessionMeta(baseMeta(id), env);
    const lockPath = `${getSessionMetaPath(id, env)}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 999999999,
        createdAt: new Date().toISOString(),
        hostname: "foreign-host",
        platform: process.platform
      })
    );

    await expect(acquireSessionMetaPatchLockForTest(id, env, { timeoutMs: 30, retryMs: 5 })).rejects.toThrow(
      /Timed out waiting for session metadata lock/
    );

    expect(existsSync(lockPath)).toBe(true);
  });

  test("old same-scope locks with a reused pid identity are reclaimed", async () => {
    const id = "reused-pid-owner";
    await writeSessionMeta(baseMeta(id), env);
    const lockPath = `${getSessionMetaPath(id, env)}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        ...(await lockOwner(process.pid)),
        createdAt: "1970-01-01T00:00:00.000Z",
        processStartTime: "not-the-current-process-start-time"
      })
    );

    const release = await acquireSessionMetaPatchLockForTest(id, env, { timeoutMs: 100, retryMs: 5, staleMs: 1 });
    await release();

    expect(existsSync(lockPath)).toBe(false);
  });

  test("old same-scope locks with a live pid but no start-time identity are preserved", async () => {
    const id = "live-pid-no-start-time";
    await writeSessionMeta(baseMeta(id), env);
    const lockPath = `${getSessionMetaPath(id, env)}.lock`;
    await mkdir(lockPath);
    const { processStartTime: _processStartTime, ...ownerWithoutStartTime } = await lockOwner(process.pid);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ ...ownerWithoutStartTime, createdAt: "1970-01-01T00:00:00.000Z" })
    );

    await expect(acquireSessionMetaPatchLockForTest(id, env, { timeoutMs: 30, retryMs: 5, staleMs: 1 })).rejects.toThrow(
      /Timed out waiting for session metadata lock/
    );

    expect(existsSync(lockPath)).toBe(true);
  });

  test("new acquisitions wait while stale-lock recovery is active", async () => {
    const id = "active-recovery";
    await writeSessionMeta(baseMeta(id), env);
    const lockPath = `${getSessionMetaPath(id, env)}.lock`;
    await mkdir(`${lockPath}.reclaim`);
    await writeFile(join(`${lockPath}.reclaim`, "owner.json"), JSON.stringify(await lockOwner(process.pid)));

    await expect(acquireSessionMetaPatchLockForTest(id, env, { timeoutMs: 30, retryMs: 5 })).rejects.toThrow(
      /Timed out waiting for session metadata lock/
    );

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(true);
  });

  test("stale recovery locks are reclaimed before stale main lock recovery", async () => {
    const id = "stale-recovery-lock";
    await writeSessionMeta(baseMeta(id), env);
    const lockPath = `${getSessionMetaPath(id, env)}.lock`;
    const recoveryLockPath = `${lockPath}.reclaim`;
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify(await lockOwner(999999999)));
    await mkdir(recoveryLockPath);
    await writeFile(join(recoveryLockPath, "owner.json"), JSON.stringify(await lockOwner(999999998)));

    await patchSessionMeta(id, { daemonPid: 5678 }, env);

    const meta = await readSessionMeta(id, env);
    expect(meta?.daemonPid).toBe(5678);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(recoveryLockPath)).toBe(false);
  });

  test("release mismatch with a different owner token leaves the replacement live lock at the original path", async () => {
    const id = "release-mismatch-new-live-lock";
    await writeSessionMeta(baseMeta(id), env);
    const lockPath = `${getSessionMetaPath(id, env)}.lock`;

    const release = await acquireSessionMetaPatchLockForTest(id, env, { timeoutMs: 100, retryMs: 5 });
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        ...(await lockOwner(process.pid)),
        token: "replacement-owner"
      })
    );

    const liveStat = await stat(lockPath);
    const liveIdentity = { dev: liveStat.dev, ino: liveStat.ino };

    await release();

    const finalStat = await stat(lockPath);
    expect({ dev: finalStat.dev, ino: finalStat.ino }).toEqual(liveIdentity);
    const finalOwner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    expect(finalOwner.token).toBe("replacement-owner");
  });

  test("stale quarantine mismatch leaves a newly acquired live lock at the original path", async () => {
    const id = "stale-quarantine-mismatch-new-live-lock";
    await writeSessionMeta(baseMeta(id), env);
    const lockPath = `${getSessionMetaPath(id, env)}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 999999999,
        createdAt: "1970-01-01T00:00:00.000Z",
        hostname: "foreign-host",
        platform: process.platform
      })
    );

    let liveIdentity: { dev: number; ino: number } | undefined;
    const resetHooks = setPatchLockTestHooksForTest({
      afterQuarantineRename: async ({ quarantinePath }) => {
        await writeFile(
          join(quarantinePath, "owner.json"),
          JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString(),
            hostname: hostname(),
            platform: process.platform,
            token: "changed-after-quarantine"
          })
        );
        await mkdir(lockPath);
        const liveStat = await stat(lockPath);
        liveIdentity = { dev: liveStat.dev, ino: liveStat.ino };
      }
    });
    try {
      await expect(
        acquireSessionMetaPatchLockForTest(id, env, { timeoutMs: 30, retryMs: 5, staleMs: 1000 })
      ).rejects.toThrow(/Timed out waiting for session metadata lock/);
    } finally {
      resetHooks();
    }

    expect(liveIdentity).toBeDefined();
    if (!liveIdentity) {
      throw new Error("test hook did not create a replacement lock");
    }
    const finalStat = await stat(lockPath);
    expect({ dev: finalStat.dev, ino: finalStat.ino }).toEqual(liveIdentity);
  });

  test("release identity mismatch with the same owner token leaves the replacement live lock at the original path", async () => {
    const id = "release-owner-token-race";
    await writeSessionMeta(baseMeta(id), env);
    const lockPath = `${getSessionMetaPath(id, env)}.lock`;

    const release = await acquireSessionMetaPatchLockForTest(id, env, { timeoutMs: 100, retryMs: 5 });
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        ...(await lockOwner(process.pid)),
        token: owner.token
      })
    );
    const liveStat = await stat(lockPath);
    const liveIdentity = { dev: liveStat.dev, ino: liveStat.ino };

    await release();

    const finalStat = await stat(lockPath);
    expect({ dev: finalStat.dev, ino: finalStat.ino }).toEqual(liveIdentity);
    const finalOwner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    expect(finalOwner.token).toBe(owner.token);
  });

  test("release ownership change after rename leaves a newly acquired live lock at the original path", async () => {
    const id = "release-owner-token-post-rename-race";
    await writeSessionMeta(baseMeta(id), env);
    const lockPath = `${getSessionMetaPath(id, env)}.lock`;

    const release = await acquireSessionMetaPatchLockForTest(id, env, { timeoutMs: 100, retryMs: 5 });
    let liveIdentity: { dev: number; ino: number } | undefined;
    const resetHooks = setPatchLockTestHooksForTest({
      afterReleaseRename: async ({ releasePath }) => {
        await writeFile(
          join(releasePath, "owner.json"),
          JSON.stringify({
            ...(await lockOwner(process.pid)),
            token: "changed-after-release-rename"
          })
        );
        await mkdir(lockPath);
        await writeFile(
          join(lockPath, "owner.json"),
          JSON.stringify({
            ...(await lockOwner(process.pid)),
            token: "replacement-owner"
          })
        );
        const liveStat = await stat(lockPath);
        liveIdentity = { dev: liveStat.dev, ino: liveStat.ino };
      }
    });
    try {
      await release();
    } finally {
      resetHooks();
    }

    expect(liveIdentity).toBeDefined();
    if (!liveIdentity) {
      throw new Error("test hook did not create a replacement lock");
    }
    const finalStat = await stat(lockPath);
    expect({ dev: finalStat.dev, ino: finalStat.ino }).toEqual(liveIdentity);
    const finalOwner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    expect(finalOwner.token).toBe("replacement-owner");
  });
});
