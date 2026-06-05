import { describe, expect, test } from "bun:test";
import {
  CONFIG_SETTINGS,
  acceptedConfigKeys,
  allConfigKeys,
  buildDefaultConfigFromSettings,
  coerceConfigValueFromSettings,
  findConfigSetting,
  renderConfigSettingsHelp,
  renderConfigSettingsTable
} from "../src/config-settings.js";

describe("config settings registry", () => {
  test("declares every persisted config path with purpose and scope", () => {
    const paths = CONFIG_SETTINGS.map((setting) => setting.path);

    expect(paths).toEqual([
      "version",
      "server.host",
      "server.port",
      "terminal.clampBrowserToHost",
      "terminal.detachPrefix",
      "terminal.setTitle",
      "attention.idleSeconds",
      "remote.enabled",
      "remote.host",
      "remote.ingestHost",
      "remote.tunnelId",
      "remote.dashboardTunnelId",
      "remote.dashboardTunnelCluster",
      "remote.tunnelToken",
      "remote.port",
      "remote.clientId",
      "session.color",
      "session.priority"
    ]);

    for (const setting of CONFIG_SETTINGS) {
      expect(setting.purpose.length).toBeGreaterThan(20);
      expect(Array.isArray(setting.scope)).toBe(true);
      expect(setting.scope.length).toBeGreaterThan(0);
    }
  });

  test("session.color scope is an array with correct process scopes", () => {
    expect(findConfigSetting("session.color")?.scope).toEqual(["client", "daemon", "server"]);
  });

  test("builds the default config from registry defaults", () => {
    expect(buildDefaultConfigFromSettings()).toEqual({
      version: 1,
      server: { host: "127.0.0.1", port: 3131 },
      terminal: {
        clampBrowserToHost: true,
        detachPrefix: 0x1c,
        setTitle: true
      },
      attention: { idleSeconds: 10 },
      session: { color: "auto", priority: 500 }
    });
  });

  test("marks sensitive and internal settings", () => {
    expect(findConfigSetting("remote.tunnelToken")?.sensitive).toBe(true);
    expect(findConfigSetting("remote.clientId")?.internal).toBe(true);
    expect(findConfigSetting("version")?.internal).toBe(true);
  });

  test("config registry includes internal dashboard tunnel persistence fields", () => {
    const tunnelId = findConfigSetting("remote.dashboardTunnelId");
    const tunnelCluster = findConfigSetting("remote.dashboardTunnelCluster");

    expect(tunnelId).toBeDefined();
    expect(tunnelId?.type).toBe("string");
    expect(tunnelId?.internal).toBe(true);
    expect(tunnelId?.acceptInput).not.toBe(true);

    expect(tunnelCluster).toBeDefined();
    expect(tunnelCluster?.type).toBe("string");
    expect(tunnelCluster?.internal).toBe(true);
    expect(tunnelCluster?.acceptInput).not.toBe(true);
  });

  test("accepted config keys exclude internal and default-only keys", () => {
    expect(acceptedConfigKeys()).toEqual([
      "remote.enabled",
      "remote.host",
      "remote.ingestHost",
      "remote.tunnelId",
      "remote.tunnelToken",
      "remote.port",
      "session.color",
      "session.priority"
    ]);
  });

  test("allConfigKeys returns all config paths including internal keys", () => {
    expect(allConfigKeys()).toEqual(CONFIG_SETTINGS.map((setting) => setting.path));
    expect(allConfigKeys().length).toBe(18);
  });

  test("coerces values through registry validators", () => {
    expect(coerceConfigValueFromSettings("remote.enabled", "true")).toBe(true);
    expect(coerceConfigValueFromSettings("remote.enabled", "false")).toBe(false);
    expect(coerceConfigValueFromSettings("remote.port", "3132")).toBe(3132);
    expect(coerceConfigValueFromSettings("session.color", "green")).toBe("green");
    expect(() => coerceConfigValueFromSettings("session.priority", "1001")).toThrow(/between 0 and 1000/);
    expect(() => coerceConfigValueFromSettings("remote.port", "0")).toThrow(/positive integer/);
  });

  test("boolean coercion rejects values other than 'true' or 'false'", () => {
    expect(() => coerceConfigValueFromSettings("remote.enabled", "1")).toThrow(/must be 'true' or 'false'/);
    expect(() => coerceConfigValueFromSettings("remote.enabled", "0")).toThrow(/must be 'true' or 'false'/);
    expect(() => coerceConfigValueFromSettings("remote.enabled", "yes")).toThrow(/must be 'true' or 'false'/);
  });

  test("validates terminal.detachPrefix range", () => {
    expect(coerceConfigValueFromSettings("terminal.detachPrefix", "28")).toBe(28);
    expect(() => coerceConfigValueFromSettings("terminal.detachPrefix", "256")).toThrow(/between 0 and 255/);
    expect(() => coerceConfigValueFromSettings("terminal.detachPrefix", "-1")).toThrow(/between 0 and 255/);
  });

  test("rejects unknown config keys", () => {
    expect(() => coerceConfigValueFromSettings("unknown.key", "value")).toThrow(/Unknown config key/);
  });

  test("renders settings table with default, scope, and markers", () => {
    const table = renderConfigSettingsTable();

    expect(table).toContain("| `session.color` | string | `auto` | client, daemon, server | Specifies the default accent color");
    expect(table).toContain("| `remote.tunnelToken` | string | unset | client | Stores the dev tunnel connect token");
    expect(table).toContain("sensitive");
    expect(table).toContain("internal");
  });

  test("wraps long purpose tokens in terminal help", () => {
    CONFIG_SETTINGS.push({
      path: "test.longToken",
      type: "string",
      purpose: `Prefix ${"x".repeat(120)} suffix`,
      scope: ["client"]
    });
    try {
      const help = renderConfigSettingsHelp();
      const overwideLines = help
        .split("\n")
        .filter((line) => line.trim().startsWith("x"))
        .filter((line) => line.length > 88);

      expect(overwideLines).toEqual([]);
    } finally {
      CONFIG_SETTINGS.pop();
    }
  });
});
