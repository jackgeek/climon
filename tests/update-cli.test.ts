import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfiguredUpdatePassword } from "../src/update/update-cli.js";
import { writeConfigSetting } from "../src/config.js";
import { DEFAULT_MANIFEST_URL } from "../src/update/check.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "climon-cli-"));
  env = { ...process.env, CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("getConfiguredUpdatePassword", () => {
  test("returns undefined when unset", () => {
    expect(getConfiguredUpdatePassword(env)).toBeUndefined();
  });

  test("returns the configured global password", () => {
    writeConfigSetting("update.password", "shared-pw", "global", env, home);
    expect(getConfiguredUpdatePassword(env)).toBe("shared-pw");
  });
});

describe("DEFAULT_MANIFEST_URL", () => {
  test("points at the public climon-releases repo", () => {
    expect(DEFAULT_MANIFEST_URL).toContain("jackgeek/climon-releases");
    expect(DEFAULT_MANIFEST_URL.endsWith("manifest.json")).toBe(true);
  });
});
