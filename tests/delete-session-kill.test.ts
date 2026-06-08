import { afterEach, describe, expect, test } from "bun:test";
import { applySessionKill, parseKillMode } from "../src/server/server.js";

const spawned: number[] = [];

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

/** Spawns a process that dies normally on SIGTERM (the default disposition). */
async function spawnTerminable(): Promise<number> {
  const child = Bun.spawn(
    [process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"],
    { stdout: "pipe", stderr: "ignore" }
  );
  spawned.push(child.pid);
  await waitForReady(child.stdout);
  return child.pid;
}

/** Spawns a process that installs a SIGTERM handler and ignores it. */
async function spawnStubborn(): Promise<number> {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"
    ],
    { stdout: "pipe", stderr: "ignore" }
  );
  spawned.push(child.pid);
  await waitForReady(child.stdout);
  return child.pid;
}

/** Waits until the child prints its first line (its handler is now installed). */
async function waitForReady(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  await reader.read();
  reader.releaseLock();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return !isAlive(pid);
}

describe("parseKillMode", () => {
  test("treats an absent or 'none' value as cleanup-only", () => {
    expect(parseKillMode(null)).toBe("none");
    expect(parseKillMode("")).toBe("none");
    expect(parseKillMode("none")).toBe("none");
  });

  test("accepts graceful and force", () => {
    expect(parseKillMode("graceful")).toBe("graceful");
    expect(parseKillMode("force")).toBe("force");
  });

  test("rejects unknown values", () => {
    expect(parseKillMode("bogus")).toBeNull();
    expect(parseKillMode("SIGKILL")).toBeNull();
  });
});

describe("applySessionKill", () => {
  test("none mode signals nothing and reports not running", async () => {
    const pid = await spawnTerminable();
    const result = await applySessionKill(pid, "none", 50);
    expect(result.stillRunning).toBe(false);
    expect(isAlive(pid)).toBe(true);
  });

  test("graceful mode reaps a process that exits on SIGTERM", async () => {
    if (process.platform === "win32") return; // Windows taskkill has no graceful SIGTERM equivalent
    const pid = await spawnTerminable();
    const result = await applySessionKill(pid, "graceful", 300);
    expect(result.stillRunning).toBe(false);
    expect(isAlive(pid)).toBe(false);
  });

  test("graceful mode reports stillRunning when the process ignores SIGTERM", async () => {
    if (process.platform === "win32") return; // Windows taskkill always terminates regardless of signal handlers
    const pid = await spawnStubborn();
    const result = await applySessionKill(pid, "graceful", 300);
    expect(result.stillRunning).toBe(true);
    expect(isAlive(pid)).toBe(true);
  });

  test("force mode kills a process that ignores SIGTERM", async () => {
    const pid = await spawnStubborn();
    const result = await applySessionKill(pid, "force", 300);
    expect(result.stillRunning).toBe(false);
    expect(await waitDead(pid)).toBe(true);
  });

  test("treats a missing daemon pid as already gone", async () => {
    const graceful = await applySessionKill(undefined, "graceful", 300);
    expect(graceful.stillRunning).toBe(false);
    const force = await applySessionKill(undefined, "force", 300);
    expect(force.stillRunning).toBe(false);
  });

  test("treats an already-dead process as success", async () => {
    const pid = await spawnTerminable();
    process.kill(pid, "SIGKILL");
    await waitDead(pid);
    const result = await applySessionKill(pid, "graceful", 300);
    expect(result.stillRunning).toBe(false);
  });
});
