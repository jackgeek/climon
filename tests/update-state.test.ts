import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAvailableVersion,
  getAvailableVersion,
  isAutoUpdate,
  recordCheck,
  setAvailableVersion,
  shouldCheck,
} from "../src/update/state.js";
import { writeConfigSetting } from "../src/config.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "climon-"));
  env = { ...process.env, CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("update state", () => {
  test("shouldCheck is true with no prior check", () => {
    expect(shouldCheck(env, 60 * 60 * 1000)).toBe(true);
  });

  test("recordCheck makes shouldCheck false within the interval", () => {
    recordCheck(env);
    expect(shouldCheck(env, 60 * 60 * 1000)).toBe(false);
  });

  test("shouldCheck true again once the interval has elapsed", () => {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeConfigSetting("update.lastCheck", past, "global", env);
    expect(shouldCheck(env, 60 * 60 * 1000)).toBe(true);
  });

  test("available version round-trips and clears", () => {
    expect(getAvailableVersion(env)).toBeUndefined();
    setAvailableVersion("0.13.0", env);
    expect(getAvailableVersion(env)).toBe("0.13.0");
    clearAvailableVersion(env);
    expect(getAvailableVersion(env)).toBeUndefined();
  });

  test("isAutoUpdate reflects update.auto", () => {
    expect(isAutoUpdate(env)).toBe(false);
    writeConfigSetting("update.auto", "true", "global", env);
    expect(isAutoUpdate(env)).toBe(true);
  });
});
