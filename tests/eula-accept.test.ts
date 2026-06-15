import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isEulaAccepted,
  recordEulaAcceptance,
} from "../src/eula/accept.js";
import { readGlobalConfigSetting } from "../src/config.js";
import { EULA_VERSION } from "../src/eula/text.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "climon-"));
  env = { ...process.env, CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("eula acceptance", () => {
  test("not accepted on a fresh install", () => {
    expect(isEulaAccepted(env)).toBe(false);
  });

  test("recording acceptance persists accepted, version, and timestamp", () => {
    recordEulaAcceptance(env);
    expect(isEulaAccepted(env)).toBe(true);
    expect(readGlobalConfigSetting("eula.version", env)).toBe(EULA_VERSION);
    expect(
      typeof readGlobalConfigSetting("eula.acceptedAt", env)
    ).toBe("string");
  });

  test("a version mismatch is treated as not accepted", async () => {
    recordEulaAcceptance(env);
    // Simulate an older acceptance by overwriting the recorded version.
    const { writeConfigSetting } = await import("../src/config.js");
    writeConfigSetting("eula.version", "0", "global", env);
    expect(isEulaAccepted(env)).toBe(false);
  });
});
