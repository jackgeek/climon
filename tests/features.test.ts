import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import {
  FEATURE_FLAGS,
  resolveFlagState,
  isFeatureEnabled,
  isFeatureLocked,
  getFeatureStatus,
  resolveFeatureFlags,
  parseFeatureConfigKey,
  type FeatureFlag
} from "../src/features.js";
import type { ClimonConfig } from "../src/types.js";

const enabledDefault: FeatureFlag = {
  name: "x", default: "enabled", status: "ready", description: "test flag x"
};
const disabledDefault: FeatureFlag = {
  name: "y", default: "disabled", status: "experimental", description: "test flag y"
};
const overridden: FeatureFlag = {
  name: "z", default: "disabled", status: "ready", description: "test flag z", override: "disabled"
};

function configWith(feature: Record<string, string>): ClimonConfig {
  return { feature } as unknown as ClimonConfig;
}

describe("resolveFlagState", () => {
  test("unset value falls back to the registry default", () => {
    expect(resolveFlagState(enabledDefault, undefined)).toEqual({
      enabled: true, locked: false, status: "ready"
    });
    expect(resolveFlagState(disabledDefault, undefined)).toEqual({
      enabled: false, locked: false, status: "experimental"
    });
  });

  test("config value overrides the default", () => {
    expect(resolveFlagState(enabledDefault, "disabled").enabled).toBe(false);
    expect(resolveFlagState(disabledDefault, "enabled").enabled).toBe(true);
  });

  test("only exactly 'enabled' is enabled (lenient)", () => {
    for (const v of ["on", "", "ENABLED", "true", "yes", "garbage"]) {
      expect(resolveFlagState(disabledDefault, v).enabled).toBe(false);
    }
    expect(resolveFlagState(disabledDefault, "enabled").enabled).toBe(true);
  });

  test("application override wins over config and locks", () => {
    const state = resolveFlagState(overridden, "enabled");
    expect(state.enabled).toBe(false);
    expect(state.locked).toBe(true);
  });
});

describe("registry-level helpers", () => {
  test("sessionSpawning is registered, disabled by default, experimental", () => {
    expect(isFeatureEnabled(configWith({}), "sessionSpawning")).toBe(false);
    expect(getFeatureStatus("sessionSpawning")).toBe("experimental");
    expect(isFeatureLocked("sessionSpawning")).toBe(false);
  });

  test("config enables sessionSpawning", () => {
    expect(isFeatureEnabled(configWith({ sessionSpawning: "enabled" }), "sessionSpawning")).toBe(true);
  });

  test("resolveFeatureFlags returns one entry per registered flag", () => {
    const map = resolveFeatureFlags(configWith({}));
    expect(Object.keys(map).sort()).toEqual(FEATURE_FLAGS.map((f) => f.name).sort());
    for (const flag of FEATURE_FLAGS) {
      expect(map[flag.name]).toEqual({
        enabled: flag.override === "enabled" || (flag.override === undefined && flag.default === "enabled"),
        locked: flag.override !== undefined,
        status: flag.status
      });
    }
  });
});

describe("parseFeatureConfigKey", () => {
  test("returns the flag name for a known feature key", () => {
    expect(parseFeatureConfigKey("feature.sessionSpawning")).toBe("sessionSpawning");
  });
  test("returns undefined for non-feature or unknown keys", () => {
    expect(parseFeatureConfigKey("server.port")).toBeUndefined();
    expect(parseFeatureConfigKey("feature.nope")).toBeUndefined();
  });
});

describe("loadConfig feature section", () => {
  test("merges a feature section over registry defaults", async () => {
    const base = join(process.cwd(), ".copilot-tmp");
    await mkdir(base, { recursive: true });
    const home = await mkdtemp(join(base, "climon-feature-"));
    try {
      await writeFile(
        join(home, "config.jsonc"),
        JSON.stringify({ version: 1, feature: { sessionSpawning: "enabled" } })
      );
      const config = await loadConfig({ CLIMON_HOME: home } as NodeJS.ProcessEnv);
      expect(config.feature?.sessionSpawning).toBe("enabled");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("defaults the feature section when config omits it", async () => {
    const base = join(process.cwd(), ".copilot-tmp");
    await mkdir(base, { recursive: true });
    const home = await mkdtemp(join(base, "climon-feature-"));
    try {
      await writeFile(join(home, "config.jsonc"), JSON.stringify({ version: 1 }));
      const config = await loadConfig({ CLIMON_HOME: home } as NodeJS.ProcessEnv);
      expect(config.feature?.sessionSpawning).toBe("disabled");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("remoteSpawn flag defaults disabled and reads config", () => {
    const flag = FEATURE_FLAGS.find((f) => f.name === "remoteSpawn");
    expect(flag).toBeDefined();
    expect(flag?.default).toBe("disabled");
    expect(flag?.status).toBe("experimental");
    expect(isFeatureEnabled({} as ClimonConfig, "remoteSpawn")).toBe(false);
    expect(
      isFeatureEnabled({ feature: { remoteSpawn: "enabled" } } as unknown as ClimonConfig, "remoteSpawn")
    ).toBe(true);
  });
});
