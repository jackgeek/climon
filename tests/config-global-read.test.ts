import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalConfigSetting, writeConfigSetting } from "../src/config.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "climon-"));
  env = { ...process.env, CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
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
    const cwd = mkdtempSync(join(tmpdir(), "climon-cwd-"));
    writeConfigSetting("telemetry.enabled", "true", "local", env, cwd);
    // Global home has nothing — global-only read must not see the local value.
    expect(readGlobalConfigSetting("telemetry.enabled", env)).toBeUndefined();
    rmSync(cwd, { recursive: true, force: true });
  });
});
