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
      "hotKeys.focusTopSession",
      "dashboard.theme",
      "dashboard.keyBarPinned",
      "attention.idleSeconds",
      "remote.enabled",
      "remote.host",
      "remote.ingestHost",
      "remote.tunnelId",
      "remote.dashboardTunnelId",
      "remote.dashboardTunnelCluster",
      "remote.dashboardTunnelEnabled",
      "remote.port",
      "remote.ingestPortRetryAttempts",
      "remote.clientId",
      "remote.spawnSecret",
      "remote.keepAlive",
      "remote.peerHome",
      "remote.peerHost",
      "remote.autoLink",
      "session.color",
      "session.priority",
      "session.terminalProgram",
      "tunnelLink.keepAlive",
      "logging.level",
      "logging.appInsights.connectionString",
      "feature.sessionSpawning",
      "feature.remoteSpawn",
      "eula.accepted",
      "eula.version",
      "eula.acceptedAt",
      "telemetry.enabled",
      "update.auto",
      "update.password",
      "update.lastCheck",
      "update.availableVersion",
      "install.id"
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

  test("session.terminalProgram is a client-scoped string with no default", () => {
    const setting = findConfigSetting("session.terminalProgram");
    expect(setting).toBeDefined();
    expect(setting?.type).toBe("string");
    expect(setting?.scope).toEqual(["client"]);
    expect(setting?.defaultValue).toBeUndefined();
    expect(setting?.acceptInput).toBe(true);
    expect(setting?.internal).not.toBe(true);
  });

  test("remote.spawnSecret is a sensitive client+server string", () => {
    const s = CONFIG_SETTINGS.find((c) => c.path === "remote.spawnSecret");
    expect(s).toBeDefined();
    expect(s?.type).toBe("string");
    expect(s?.sensitive).toBe(true);
    expect(s?.acceptInput).toBe(true);
    expect(s?.scope).toContain("client");
    expect(s?.scope).toContain("server");
  });

  test("builds the default config from registry defaults", () => {
    expect(buildDefaultConfigFromSettings()).toEqual({
      version: 1,
      server: { host: "127.0.0.1", port: 3131 },
      terminal: {
        clampBrowserToHost: false,
        detachPrefix: 0x1c,
        setTitle: true
      },
      hotKeys: { focusTopSession: "Alt+J" },
      dashboard: { theme: "Default", keyBarPinned: false },
      attention: { idleSeconds: 10 },
      remote: { ingestPortRetryAttempts: 100, keepAlive: 60, autoLink: true },
      session: { color: "auto", priority: 500 },
      tunnelLink: { keepAlive: 60 },
      logging: { level: "trace" },
      feature: { sessionSpawning: "disabled", remoteSpawn: "disabled" },
      eula: { accepted: false },
      telemetry: { enabled: false },
      update: { auto: false }
    });
  });

  test("marks internal settings", () => {
    expect(findConfigSetting("version")?.internal).toBe(true);
  });

  test("remote.clientId is user-configurable", () => {
    const clientId = findConfigSetting("remote.clientId");

    expect(clientId?.internal).not.toBe(true);
    expect(clientId?.acceptInput).toBe(true);
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
      "hotKeys.focusTopSession",
      "dashboard.theme",
      "dashboard.keyBarPinned",
      "remote.enabled",
      "remote.host",
      "remote.ingestHost",
      "remote.tunnelId",
      "remote.port",
      "remote.clientId",
      "remote.spawnSecret",
      "remote.keepAlive",
      "remote.peerHome",
      "remote.peerHost",
      "remote.autoLink",
      "session.color",
      "session.priority",
      "session.terminalProgram",
      "tunnelLink.keepAlive",
      "logging.level",
      "logging.appInsights.connectionString",
      "feature.sessionSpawning",
      "feature.remoteSpawn",
      "telemetry.enabled",
      "update.auto",
      "update.password"
    ]);
  });

  test("allConfigKeys returns all config paths including internal keys", () => {
    expect(allConfigKeys()).toEqual(CONFIG_SETTINGS.map((setting) => setting.path));
    expect(allConfigKeys().length).toBe(42);
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

  test("remote.ingestPortRetryAttempts defaults to 100 and is server-scoped", () => {
    const setting = findConfigSetting("remote.ingestPortRetryAttempts");
    expect(setting).toBeDefined();
    expect(setting?.type).toBe("number");
    expect(setting?.defaultValue).toBe(100);
    expect(setting?.scope).toEqual(["server"]);
  });

  test("remote.ingestPortRetryAttempts rejects non-integers and values below 1", () => {
    expect(() => coerceConfigValueFromSettings("remote.ingestPortRetryAttempts", "0")).toThrow();
    expect(() => coerceConfigValueFromSettings("remote.ingestPortRetryAttempts", "-5")).toThrow();
    expect(() => coerceConfigValueFromSettings("remote.ingestPortRetryAttempts", "1.5")).toThrow();
    expect(coerceConfigValueFromSettings("remote.ingestPortRetryAttempts", "100")).toBe(100);
  });
});

describe("update.password setting", () => {
  test("is registered, sensitive, and user-settable", () => {
    const s = findConfigSetting("update.password");
    expect(s).toBeDefined();
    expect(s?.type).toBe("string");
    expect(s?.sensitive).toBe(true);
    expect(s?.scope).toContain("client");
    expect(acceptedConfigKeys()).toContain("update.password");
  });

  test("coerces a string value unchanged", () => {
    expect(coerceConfigValueFromSettings("update.password", "hunter2")).toBe(
      "hunter2"
    );
  });
});

describe("hotKeys.focusTopSession setting", () => {
  test("is registered with the Alt+J default and browser scope", () => {
    const setting = CONFIG_SETTINGS.find((s) => s.path === "hotKeys.focusTopSession");
    expect(setting).toBeDefined();
    expect(setting?.defaultValue).toBe("Alt+J");
    expect(setting?.scope).toContain("browser");
    expect(setting?.scope).toContain("server");
  });

  test("appears in the default config", () => {
    const config = buildDefaultConfigFromSettings();
    expect((config as { hotKeys?: { focusTopSession?: string } }).hotKeys?.focusTopSession).toBe("Alt+J");
  });

  test("validation rejects an unparseable non-empty value but accepts empty", () => {
    const setting = CONFIG_SETTINGS.find((s) => s.path === "hotKeys.focusTopSession");
    expect(() => setting?.validate?.("")).not.toThrow();
    expect(() => setting?.validate?.("Alt+T")).not.toThrow();
    expect(() => setting?.validate?.("Hyper Nonsense")).toThrow();
  });
});

describe("dashboard-writable settings", () => {
  test("dashboard.theme and dashboard.keyBarPinned are registered and writable", () => {
    const theme = findConfigSetting("dashboard.theme");
    const pin = findConfigSetting("dashboard.keyBarPinned");
    expect(theme?.dashboardWritable).toBe(true);
    expect(pin?.dashboardWritable).toBe(true);
  });

  test("every dashboardWritable setting is browser-scoped, validated, and not sensitive/internal", () => {
    for (const setting of CONFIG_SETTINGS.filter((s) => s.dashboardWritable)) {
      expect(setting.scope).toContain("browser");
      expect(typeof setting.validate).toBe("function");
      expect(setting.internal ?? false).toBe(false);
      expect(setting.sensitive ?? false).toBe(false);
    }
  });

  test("dashboard.theme validate accepts a known name and rejects an unknown one", () => {
    const theme = findConfigSetting("dashboard.theme");
    expect(() => theme?.validate?.("Dracula")).not.toThrow();
    expect(() => theme?.validate?.("nope")).toThrow();
  });

  test("dashboard.keyBarPinned validate rejects a non-boolean", () => {
    const pin = findConfigSetting("dashboard.keyBarPinned");
    expect(() => pin?.validate?.(true)).not.toThrow();
    expect(() => pin?.validate?.("yes")).toThrow();
  });
});
