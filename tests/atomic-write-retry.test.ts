import { afterEach, describe, expect, test } from "bun:test";
import { rename as realRename } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  setAtomicWriteTestHooksForTest,
  writeSessionMeta,
  readSessionMeta
} from "../src/store.js";
import type { SessionMeta } from "../src/types.js";

let restore: (() => void) | undefined;
let home: string | undefined;

afterEach(async () => {
  restore?.();
  restore = undefined;
  if (home) {
    await rm(home, { recursive: true, force: true });
    home = undefined;
  }
});

function baseMeta(id: string): SessionMeta {
  const now = new Date().toISOString();
  return {
    id,
    command: ["bash"],
    displayCommand: "bash",
    priority: 500,
    cwd: "/tmp",
    status: "running",
    priorityReason: "running",
    socketPath: "tcp://127.0.0.1:0",
    cols: 80,
    rows: 24,
    headless: false,
    clientVersion: "test",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now
  };
}

describe("atomicWrite rename retry", () => {
  test("retries transient EPERM rename failures and still writes the file", async () => {
    home = await mkdtemp(join(tmpdir(), "climon-atomic-"));
    const env = { ...process.env, CLIMON_HOME: home };

    let attempts = 0;
    restore = setAtomicWriteTestHooksForTest({
      rename: async (from: string, to: string) => {
        attempts++;
        if (attempts < 3) {
          const err = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        await realRename(from, to);
      }
    });

    const meta = baseMeta("retry-success");
    await writeSessionMeta(meta, env);

    expect(attempts).toBe(3);
    const written = await readSessionMeta("retry-success", env);
    expect(written?.id).toBe("retry-success");
  });

  test("propagates non-transient rename errors without retrying", async () => {
    home = await mkdtemp(join(tmpdir(), "climon-atomic-"));
    const env = { ...process.env, CLIMON_HOME: home };

    let attempts = 0;
    restore = setAtomicWriteTestHooksForTest({
      rename: async () => {
        attempts++;
        const err = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      }
    });

    await expect(writeSessionMeta(baseMeta("no-retry"), env)).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});
