import { describe, expect, test } from "bun:test";
import { buildDefaultConfigFromSettings } from "../src/config-settings.js";
import {
  collectDashboardPreferences,
  applyDashboardPreference,
  persistDashboardPreference
} from "../src/server/dashboard-preferences.js";

function freshConfig() {
  return buildDefaultConfigFromSettings();
}

describe("collectDashboardPreferences", () => {
  test("returns defaults when nothing is set", () => {
    const prefs = collectDashboardPreferences(freshConfig());
    expect(prefs["dashboard.theme"]).toBe("default");
    expect(prefs["dashboard.keyBarPinned"]).toBe(false);
  });

  test("reflects values set on the config", () => {
    const config = freshConfig();
    config.dashboard = { theme: "dracula", keyBarPinned: true };
    const prefs = collectDashboardPreferences(config);
    expect(prefs["dashboard.theme"]).toBe("dracula");
    expect(prefs["dashboard.keyBarPinned"]).toBe(true);
  });
});

describe("applyDashboardPreference", () => {
  test("writes a valid theme and reports ok", () => {
    const config = freshConfig();
    const result = applyDashboardPreference(config, "dashboard.theme", "dracula");
    expect(result.ok).toBe(true);
    expect(config.dashboard?.theme).toBe("dracula");
  });

  test("writes a valid boolean preference", () => {
    const config = freshConfig();
    const result = applyDashboardPreference(config, "dashboard.keyBarPinned", true);
    expect(result.ok).toBe(true);
    expect(config.dashboard?.keyBarPinned).toBe(true);
  });

  test("rejects an unknown key with status 400", () => {
    const config = freshConfig();
    const result = applyDashboardPreference(config, "dashboard.nope", "x");
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  test("rejects a non-allowlisted config path (e.g. server.port)", () => {
    const config = freshConfig();
    const result = applyDashboardPreference(config, "server.port", 9999);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(config.server.port).not.toBe(9999);
  });

  test("rejects a wrong-typed value with status 400", () => {
    const config = freshConfig();
    const result = applyDashboardPreference(config, "dashboard.keyBarPinned", "yes");
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  test("rejects a value that fails the setting validator", () => {
    const config = freshConfig();
    const result = applyDashboardPreference(config, "dashboard.theme", "not-a-theme");
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});

describe("persistDashboardPreference", () => {
  test("serializes concurrent writes without losing updates", async () => {
    let stored = freshConfig();
    // load returns a deep copy so callers cannot mutate the stored config directly,
    // and save introduces an await tick that would expose any read-modify-write race.
    const load = async () => JSON.parse(JSON.stringify(stored)) as typeof stored;
    const save = async (config: typeof stored) => {
      await Promise.resolve();
      stored = config;
    };

    await Promise.all([
      persistDashboardPreference("dashboard.theme", "dracula", load, save),
      persistDashboardPreference("dashboard.keyBarPinned", true, load, save)
    ]);

    // Both updates survive because the writes were serialized.
    expect(stored.dashboard?.theme).toBe("dracula");
    expect(stored.dashboard?.keyBarPinned).toBe(true);
  });

  test("returns the saved config on success and null on rejection", async () => {
    let stored = freshConfig();
    const load = async () => stored;
    const save = async (config: typeof stored) => {
      stored = config;
    };

    const ok = await persistDashboardPreference("dashboard.theme", "monokai", load, save);
    expect(ok.result.ok).toBe(true);
    expect(ok.config?.dashboard?.theme).toBe("monokai");

    const bad = await persistDashboardPreference("server.port", 9999, load, save);
    expect(bad.result).toMatchObject({ ok: false, status: 400 });
    expect(bad.config).toBeNull();
    expect(stored.server.port).not.toBe(9999);
  });
});
