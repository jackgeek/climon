import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, type watch } from "node:fs";
import { join } from "node:path";
import { createShutdownRequestWatcher } from "../src/remote/shutdown-watch.js";
import {
  getShutdownRequestPathInDir,
  writeShutdownRequestToDir,
  type ShutdownRequest
} from "../src/remote/shutdown-request.js";

let dir: string;
const noopWatch = (() => ({ close: () => {} })) as unknown as typeof watch;
const req = (): ShutdownRequest => ({ requestedBy: "Windows", ts: Date.now() });
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  const testTmp = join(process.cwd(), ".copilot-tmp");
  mkdirSync(testTmp, { recursive: true });
  dir = mkdtempSync(join(testTmp, "climon-shutdown-watch-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createShutdownRequestWatcher (poll path)", () => {
  test("clears a pre-existing request on start", async () => {
    await writeShutdownRequestToDir(dir, req());
    const watcher = createShutdownRequestWatcher({ dir, onValid: () => {}, pollMs: 15, watchFn: noopWatch });
    expect(existsSync(getShutdownRequestPathInDir(dir))).toBe(false);
    watcher.stop();
  });

  test("fires onValid and consumes the file for a well-formed request", async () => {
    let seen: ShutdownRequest | undefined;
    const watcher = createShutdownRequestWatcher({
      dir,
      onValid: (r) => { seen = r; },
      pollMs: 15,
      watchFn: noopWatch
    });
    await writeShutdownRequestToDir(dir, req());
    await wait(70);
    expect(seen?.requestedBy).toBe("Windows");
    expect(existsSync(getShutdownRequestPathInDir(dir))).toBe(false);
    watcher.stop();
  });

  test("ignores and drops a malformed request", async () => {
    let calls = 0;
    const watcher = createShutdownRequestWatcher({
      dir,
      onValid: () => { calls += 1; },
      pollMs: 15,
      watchFn: noopWatch
    });
    writeFileSync(getShutdownRequestPathInDir(dir), "not json");
    await wait(70);
    expect(calls).toBe(0);
    expect(existsSync(getShutdownRequestPathInDir(dir))).toBe(false);
    watcher.stop();
  });

  test("acts at most once even if a second request arrives", async () => {
    let calls = 0;
    const watcher = createShutdownRequestWatcher({
      dir,
      onValid: () => { calls += 1; },
      pollMs: 15,
      watchFn: noopWatch
    });
    await writeShutdownRequestToDir(dir, req());
    await wait(45);
    await writeShutdownRequestToDir(dir, req());
    await wait(45);
    expect(calls).toBe(1);
    watcher.stop();
  });
});
