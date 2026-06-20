import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSpawnSecret, getSpawnSecret } from "../src/remote/spawn-secret.js";
import { writeConfigSetting } from "../src/config.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "climon-spawnsecret-"));
  env = { ...process.env, CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("does not create a secret while the feature is disabled", async () => {
  const secret = await ensureSpawnSecret(env);
  expect(secret).toBeUndefined();
  expect(await getSpawnSecret(env)).toBeUndefined();
});

test("creates a persistent secret once the feature is enabled", async () => {
  writeConfigSetting("feature.remoteSpawn", "enabled", "global", env);
  const first = await ensureSpawnSecret(env);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  // Idempotent: a second call returns the same persisted secret.
  const second = await ensureSpawnSecret(env);
  expect(second).toBe(first);
  expect(await getSpawnSecret(env)).toBe(first);
});
