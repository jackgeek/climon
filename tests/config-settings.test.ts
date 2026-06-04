import { describe, expect, test } from "bun:test";
import {
  CONFIG_SETTINGS,
  acceptedConfigKeys,
  buildDefaultConfigFromSettings,
  coerceConfigValueFromSettings,
  findConfigSetting,
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
      "remote.tunnelToken",
      "remote.port",
      "remote.clientId",
      "session.color",
      "session.priority"
    ]);

    for (const setting of CONFIG_SETTINGS) {
      expect(setting.purpose.length).toBeGreaterThan(20);
      expect(setting.scope.length).toBeGreaterThan(0);
    }
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
      session: { color: "auto" }
    });
  });

  test("marks sensitive and internal settings", () => {
    expect(findConfigSetting("remote.tunnelToken")?.sensitive).toBe(true);
    expect(findConfigSetting("remote.clientId")?.internal).toBe(true);
    expect(findConfigSetting("version")?.internal).toBe(true);
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

  test("coerces values through registry validators", () => {
    expect(coerceConfigValueFromSettings("remote.enabled", "true")).toBe(true);
    expect(coerceConfigValueFromSettings("remote.port", "3132")).toBe(3132);
    expect(coerceConfigValueFromSettings("session.color", "green")).toBe("green");
    expect(() => coerceConfigValueFromSettings("session.priority", "1001")).toThrow(/between 0 and 1000/);
    expect(() => coerceConfigValueFromSettings("remote.port", "0")).toThrow(/positive integer/);
  });

  test("renders settings table with default, scope, and markers", () => {
    const table = renderConfigSettingsTable();

    expect(table).toContain("| `session.color` | string | `auto` | client, daemon, server | Specifies the default accent color");
    expect(table).toContain("| `remote.tunnelToken` | string | unset | client | Stores the dev tunnel connect token");
    expect(table).toContain("sensitive");
    expect(table).toContain("internal");
  });
});
