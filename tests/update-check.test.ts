import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackgroundCheck } from "../src/update/check.js";
import { getAvailableVersion } from "../src/update/state.js";
import type { Manifest } from "../src/update/manifest.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "climon-chk-"));
  env = { ...process.env, CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("runBackgroundCheck", () => {
  test("caches a newer version and records the check time", async () => {
    const manifest: Manifest = { version: "0.99.0", artifacts: {} };
    await runBackgroundCheck({
      env,
      currentVersion: "0.12.1",
      fetchManifest: async () => manifest,
    });
    expect(getAvailableVersion(env)).toBe("0.99.0");
  });

  test("clears the cached version when not newer", async () => {
    const manifest: Manifest = { version: "0.12.1", artifacts: {} };
    await runBackgroundCheck({
      env,
      currentVersion: "0.12.1",
      fetchManifest: async () => manifest,
    });
    expect(getAvailableVersion(env)).toBeUndefined();
  });

  test("swallows fetch errors (offline-safe)", async () => {
    await runBackgroundCheck({
      env,
      currentVersion: "0.12.1",
      fetchManifest: async () => {
        throw new Error("offline");
      },
    });
    expect(getAvailableVersion(env)).toBeUndefined();
  });
});
