import { describe, expect, test } from "bun:test";
import {
  CONFIG_SETTINGS,
  acceptedConfigKeys,
  buildDefaultConfigFromSettings,
} from "../src/config-settings.js";

function setting(path: string) {
  return CONFIG_SETTINGS.find((s) => s.path === path);
}

describe("installer/update config settings", () => {
  test("telemetry.enabled defaults off and is user-settable", () => {
    expect(setting("telemetry.enabled")?.defaultValue).toBe(false);
    expect(acceptedConfigKeys()).toContain("telemetry.enabled");
  });

  test("update.auto defaults off and is user-settable", () => {
    expect(setting("update.auto")?.defaultValue).toBe(false);
    expect(acceptedConfigKeys()).toContain("update.auto");
  });

  test("update bookkeeping + install.id are internal", () => {
    expect(setting("update.lastCheck")?.internal).toBe(true);
    expect(setting("update.availableVersion")?.internal).toBe(true);
    expect(setting("install.id")?.internal).toBe(true);
  });

  test("defaults object carries the off-by-default booleans", () => {
    const cfg = buildDefaultConfigFromSettings() as Record<string, any>;
    expect(cfg.telemetry.enabled).toBe(false);
    expect(cfg.update.auto).toBe(false);
  });
});
