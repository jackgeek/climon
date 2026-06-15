import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readGlobalConfigSetting, writeConfigSetting } from "../src/config.js";

let home: string;
let env: NodeJS.ProcessEnv;
let counter = 0;
const testRoot = join(process.cwd(), ".test-data");

function makeTestDir(prefix: string): string {
  const dir = join(testRoot, `${prefix}-${process.pid}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  home = makeTestDir("climon-home");
  env = { ...process.env, CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("readGlobalConfigSetting", () => {
  test("returns undefined when unset", () => {
    expect(readGlobalConfigSetting("telemetry.enabled", env)).toBeUndefined();
  });

  test("reads back a value written to the global scope", () => {
    writeConfigSetting("telemetry.enabled", "true", "global", env);
    expect(readGlobalConfigSetting("telemetry.enabled", env)).toBe(true);
  });

  test("ignores a value set only in a local cwd config", () => {
    const cwd = makeTestDir("climon-cwd");
    try {
      writeConfigSetting("telemetry.enabled", "true", "local", env, cwd);
      // Global home has nothing — global-only read must not see the local value.
      expect(readGlobalConfigSetting("telemetry.enabled", env)).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
