import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killAllSessions, killSession } from "../src/launcher.js";
import { readSessionMeta, writeSessionMeta } from "../src/store.js";
import type { SessionMeta } from "../src/types.js";

let home: string;
let prevHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "climon-kill-"));
  prevHome = process.env.CLIMON_HOME;
  process.env.CLIMON_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) {
    delete process.env.CLIMON_HOME;
  } else {
    process.env.CLIMON_HOME = prevHome;
  }
  await rm(home, { recursive: true, force: true });
});

async function seedSession(id: string, daemonPid?: number): Promise<string> {
  const meta: SessionMeta = {
    id,
    command: ["bash"],
    displayCommand: "bash",
    cwd: home,
    status: "running",
    priorityReason: "running",
    daemonPid,
    socketPath: join(home, "sock", `${id}.sock`),
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString()
  };
  await writeSessionMeta(meta);
  return id;
}

describe("killSession force escalation", () => {
  test("escalates to a forced kill when the graceful kill fails but the process is still alive", async () => {
    const id = await seedSession("kss-test", 4321);
    const calls: Array<[number, boolean]> = [];
    let alive = true;
    // Simulates a windowless Windows console process: graceful taskkill (no /F)
    // cannot terminate it, but a forced kill (/F) does.
    const kill = (pid: number, force: boolean) => {
      calls.push([pid, force]);
      if (force) {
        alive = false;
        return true;
      }
      return false;
    };
    const isAlive = () => alive;

    const code = await killSession(id, kill, isAlive);

    expect(code).toBe(0);
    expect(calls).toEqual([
      [4321, false],
      [4321, true]
    ]);
    expect(await readSessionMeta(id)).toBeUndefined();
  });

  test("reports failure and preserves the session when even a forced kill cannot terminate it", async () => {
    const id = await seedSession("kss-test", 4321);
    const kill = () => false;
    const isAlive = () => true;

    const code = await killSession(id, kill, isAlive);

    expect(code).toBe(1);
    expect(await readSessionMeta(id)).toBeDefined();
  });

  test("does not escalate when the graceful kill succeeds (POSIX SIGTERM path)", async () => {
    const id = await seedSession("kss-test", 4321);
    const calls: Array<[number, boolean]> = [];
    // POSIX: process.kill(pid, SIGTERM) returns success even though the process
    // exits asynchronously a moment later, so killSession must not re-check
    // liveness or escalate here.
    const kill = (pid: number, force: boolean) => {
      calls.push([pid, force]);
      return true;
    };
    const isAlive = () => true;

    const code = await killSession(id, kill, isAlive);

    expect(code).toBe(0);
    expect(calls).toEqual([[4321, false]]);
    expect(await readSessionMeta(id)).toBeUndefined();
  });
});

describe("killAllSessions", () => {
  test("returns success when there are no local sessions", async () => {
    await seedSession("remote-only");

    const calls: Array<[number, boolean]> = [];
    const code = await killAllSessions(
      (pid, force) => {
        calls.push([pid, force]);
        return true;
      },
      () => false
    );

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(await readSessionMeta("remote-only")).toBeDefined();
  });

  test("kills and removes every local session", async () => {
    await seedSession("one", 1111);
    await seedSession("two", 2222);
    await seedSession("remote-only");
    const calls: Array<[number, boolean]> = [];

    const code = await killAllSessions(
      (pid, force) => {
        calls.push([pid, force]);
        return true;
      },
      () => true
    );

    expect(code).toBe(0);
    expect(calls).toEqual([
      [1111, false],
      [2222, false]
    ]);
    expect(await readSessionMeta("one")).toBeUndefined();
    expect(await readSessionMeta("two")).toBeUndefined();
    expect(await readSessionMeta("remote-only")).toBeDefined();
  });

  test("preserves failed local sessions and returns non-zero", async () => {
    await seedSession("stuck", 3333);
    await seedSession("ok", 4444);
    const calls: Array<[number, boolean]> = [];

    const code = await killAllSessions(
      (pid, force) => {
        calls.push([pid, force]);
        return pid === 4444;
      },
      (pid) => pid === 3333
    );

    expect(code).toBe(1);
    expect(calls).toEqual([
      [3333, false],
      [3333, true],
      [4444, false]
    ]);
    expect(await readSessionMeta("stuck")).toBeDefined();
    expect(await readSessionMeta("ok")).toBeUndefined();
  });
});
