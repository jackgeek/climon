import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnboarding } from "../src/setup/onboarding.js";
import { readGlobalConfigSetting } from "../src/config.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "climon-"));
  env = { ...process.env, CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("runOnboarding", () => {
  test("non-interactive applies telemetry=on, auto-update=on, and completes", async () => {
    const result = await runOnboarding({
      env,
      options: { apply: true, telemetry: true, autoUpdate: true },
      print: () => {},
      prompt: async () => "",
    });
    expect(result.accepted).toBe(true);
    expect(readGlobalConfigSetting("telemetry.enabled", env)).toBe(true);
    expect(readGlobalConfigSetting("update.auto", env)).toBe(true);
    expect(typeof readGlobalConfigSetting("install.id", env)).toBe("string");
  });

  test("non-interactive without opt-in flags still completes and assigns install id", async () => {
    const result = await runOnboarding({
      env,
      options: { apply: true },
      print: () => {},
      prompt: async () => "",
    });
    expect(result.accepted).toBe(true);
    // No telemetry/update writes when non-interactive flags are omitted.
    expect(readGlobalConfigSetting("telemetry.enabled", env)).toBeUndefined();
    expect(readGlobalConfigSetting("update.auto", env)).toBeUndefined();
    expect(typeof readGlobalConfigSetting("install.id", env)).toBe("string");
  });

  test("non-interactive re-run without flags preserves a prior opt-in", async () => {
    const { writeConfigSetting } = await import("../src/config.js");
    writeConfigSetting("telemetry.enabled", "true", "global", env);
    writeConfigSetting("update.auto", "true", "global", env);
    const result = await runOnboarding({
      env,
      options: { apply: true },
      print: () => {},
      prompt: async () => "",
    });
    expect(result.accepted).toBe(true);
    expect(readGlobalConfigSetting("telemetry.enabled", env)).toBe(true);
    expect(readGlobalConfigSetting("update.auto", env)).toBe(true);
  });

  test("interactive: y/y enables both opt-ins", async () => {
    const answers = ["y", "y"];
    let i = 0;
    const result = await runOnboarding({
      env,
      options: { apply: false },
      print: () => {},
      prompt: async () => answers[i++] ?? "",
    });
    expect(result.accepted).toBe(true);
    expect(readGlobalConfigSetting("telemetry.enabled", env)).toBe(true);
    expect(readGlobalConfigSetting("update.auto", env)).toBe(true);
  });

  test("interactive: blank answers leave opt-ins OFF (default no)", async () => {
    const answers = ["", ""];
    let i = 0;
    await runOnboarding({
      env,
      options: { apply: false },
      print: () => {},
      prompt: async () => answers[i++] ?? "",
    });
    expect(readGlobalConfigSetting("telemetry.enabled", env)).toBe(false);
    expect(readGlobalConfigSetting("update.auto", env)).toBe(false);
  });
});
