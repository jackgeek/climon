import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig, saveConfig, writeConfigSetting } from "../src/config.js";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { deriveIngestTunnelId } from "../src/remote/ingest-tunnel-id.js";
import {
  buildDefaultConfigFromSettings,
  coerceConfigValueFromSettings,
  findConfigSetting
} from "../src/config-settings.js";
import {
  defaultConfig,
  getConfigPath,
  getScrollbackPath,
  getSessionMetaPath,
  getSessionsDir,
  getSocketPath
} from "../src/config.js";

const CLIMON_TEST_HOME = join(process.cwd(), ".copilot-tmp", "climon-test");
const env = { CLIMON_HOME: CLIMON_TEST_HOME } as NodeJS.ProcessEnv;

async function makeTestHome(prefix: string): Promise<string> {
  const base = join(process.cwd(), ".copilot-tmp");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, prefix));
}

describe("config paths", () => {
  test("sessions dir is under climon home", () => {
    expect(getSessionsDir(env)).toBe(join(CLIMON_TEST_HOME, "sessions"));
  });

  test("session meta path uses id", () => {
    expect(getSessionMetaPath("abc", env)).toBe(join(CLIMON_TEST_HOME, "sessions", "abc.json"));
  });

  test("scrollback path uses id", () => {
    expect(getScrollbackPath("abc", env)).toBe(join(CLIMON_TEST_HOME, "sessions", "abc.scrollback"));
  });

  test("socket path is a unix socket on posix", () => {
    expect(getSocketPath("abc", env, "linux")).toBe(join(CLIMON_TEST_HOME, "sock", "abc.sock"));
  });

  test("socket path is a named pipe on win32", () => {
    expect(getSocketPath("abc", env, "win32")).toBe("\\\\.\\pipe\\climon-abc");
  });
});

describe("config defaults", () => {
  test("default config binds to localhost", () => {
    const config = defaultConfig();
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.port).toBe(3131);
  });

  test("default config has no lan or token fields", () => {
    const config = defaultConfig() as unknown as Record<string, unknown> & { server: Record<string, unknown> };
    expect("lan" in config.server).toBe(false);
    expect("token" in config.server).toBe(false);
  });

  test("default config sets session color to auto", () => {
    expect(defaultConfig().session?.color).toBe("auto");
  });
});

describe("config migration", () => {
  test("backfills a missing attention section", async () => {
    const home = await makeTestHome("climon-cfg-");
    const migrationEnv = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131, lan: false, token: "tok" },
        terminal: { clampBrowserToHost: true }
      })
    );
    const config = await loadConfig(migrationEnv);
    expect(config.attention.idleSeconds).toBe(10);
    await rm(home, { recursive: true, force: true });
  });

  test("loadConfig backfills missing session.color to auto", async () => {
    const home = await makeTestHome("climon-color-auto-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        terminal: { clampBrowserToHost: true },
        attention: { idleSeconds: 10 }
      })
    );
    const config = await loadConfig(env);
    expect(config.session?.color).toBe("auto");
    await rm(home, { recursive: true, force: true });
  });

  test("loadConfig backfills missing hotKeys.focusTopSession to Alt+J", async () => {
    const home = await makeTestHome("climon-hotkeys-default-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        terminal: { clampBrowserToHost: true },
        attention: { idleSeconds: 10 }
      })
    );
    const config = await loadConfig(env);
    expect(config.hotKeys.focusTopSession).toBe("Alt+J");
    await rm(home, { recursive: true, force: true });
  });

  test("loadConfig preserves a custom hotKeys.focusTopSession value", async () => {
    const home = await makeTestHome("climon-hotkeys-custom-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        terminal: { clampBrowserToHost: true },
        attention: { idleSeconds: 10 },
        hotKeys: { focusTopSession: "Ctrl+Shift+J" }
      })
    );
    const config = await loadConfig(env);
    expect(config.hotKeys.focusTopSession).toBe("Ctrl+Shift+J");
    await rm(home, { recursive: true, force: true });
  });

  test("loadConfig backfills invalid session.color to auto", async () => {
    const home = await makeTestHome("climon-color-invalid-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        terminal: { clampBrowserToHost: true },
        attention: { idleSeconds: 10 },
        session: { color: "orange" }
      })
    );
    const config = await loadConfig(env);
    expect(config.session?.color).toBe("auto");
    await rm(home, { recursive: true, force: true });
  });

  test("loadConfig preserves numeric session.priority values", async () => {
    const home = await makeTestHome("climon-priority-invalid-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        session: { priority: 1001 }
      })
    );

    const config = await loadConfig(env);

    expect(config.session?.priority).toBe(1001);
    await rm(home, { recursive: true, force: true });
  });

  test("loadConfig accepts a sparse global config written by climon config", async () => {
    const home = await makeTestHome("climon-sparse-global-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        remote: {
          enabled: true,
          tunnelId: "abc123",
          port: 3132
        }
      })
    );

    const config = await loadConfig(env);

    expect(config.version).toBe(1);
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.remote?.enabled).toBe(true);
    await rm(home, { recursive: true, force: true });
  });
});

describe("detach prefix config", () => {
  test("default config sets detachPrefix to 0x1c (Ctrl-\\)", () => {
    expect(defaultConfig().terminal.detachPrefix).toBe(0x1c);
  });

  test("loadConfig backfills detachPrefix for configs written before it existed", async () => {
    const home = await makeTestHome("climon-detach-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await mkdir(join(home), { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        terminal: { clampBrowserToHost: true },
        attention: { idleSeconds: 10 }
      })
    );
    const config = await loadConfig(env);
    expect(config.terminal.detachPrefix).toBe(0x1c);
    await rm(home, { recursive: true, force: true });
  });

  test("loadConfig clamps an out-of-range detachPrefix back to the default", async () => {
    const home = await makeTestHome("climon-detach2-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        terminal: { clampBrowserToHost: true, detachPrefix: 999 },
        attention: { idleSeconds: 10 }
      })
    );
    const config = await loadConfig(env);
    expect(config.terminal.detachPrefix).toBe(0x1c);
    await rm(home, { recursive: true, force: true });
  });
});

describe("config jsonc paths and migration", () => {
  test("getConfigPath points at config.jsonc", () => {
    const env = { CLIMON_HOME: "/tmp/test-home" } as NodeJS.ProcessEnv;
    expect(getConfigPath(env)).toBe(join("/tmp/test-home", "config.jsonc"));
  });

  test("loadConfig creates config.jsonc with generated comments", async () => {
    const home = await makeTestHome("climon-jsonc-create-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    const config = await loadConfig(env);
    
    // Check config structure includes registry defaults
    expect(config.session?.color).toBe("auto");
    expect(config.session?.priority).toBe(500);
    
    // Check that config.jsonc exists with comments
    const configPath = join(home, "config.jsonc");
    expect(existsSync(configPath)).toBe(true);
    
    const raw = await readFile(configPath, "utf8");
    expect(raw).toContain("// Schema version for the persisted config file format");
    expect(raw).toContain('"version": 1');
    expect(raw).toContain('"color": "auto"');
    
    await rm(home, { recursive: true, force: true });
  });

  test("loadConfig reads config.jsonc with comments", async () => {
    const home = await makeTestHome("climon-jsonc-read-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.jsonc"),
      `{
  // Custom server port
  "server": {
    "host": "127.0.0.1",
    "port": 9999
  },
  /* Session preferences */
  "session": {
    "color": "blue"
  }
}`
    );
    const config = await loadConfig(env);
    expect(config.server.port).toBe(9999);
    expect(config.session?.color).toBe("blue");
    await rm(home, { recursive: true, force: true });
  });

  test("loadConfig preserves registered and unknown sections", async () => {
    const home = await makeTestHome("climon-jsonc-lossless-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        version: 1,
        server: {
          host: "127.0.0.1",
          port: 3131,
          futureServerKey: "keep-nested"
        },
        dashboard: { theme: "Dracula", keyBarPinned: false },
        tunnelLink: { keepAlive: 45 },
        logging: { level: "debug" },
        telemetry: { enabled: true },
        update: {
          auto: true,
          lastCheck: "2026-07-11T12:00:00.000Z",
          availableVersion: "9.9.9"
        },
        install: { id: "install-123" },
        futureSection: { enabled: true, value: "keep-top-level" }
      })
    );

    const config = await loadConfig(env);
    config.server.host = "0.0.0.0";
    await saveConfig(config, env);
    const reloaded = await loadConfig(env);
    const losslessConfig = reloaded as typeof reloaded & {
      server: typeof reloaded.server & { futureServerKey: string };
      futureSection: { enabled: boolean; value: string };
    };

    expect(losslessConfig.dashboard).toEqual({ theme: "Dracula", keyBarPinned: false });
    expect(losslessConfig.tunnelLink).toEqual({ keepAlive: 45 });
    expect(losslessConfig.logging).toEqual({ level: "debug" });
    expect(losslessConfig.telemetry).toEqual({ enabled: true });
    expect(losslessConfig.update).toEqual({
      auto: true,
      lastCheck: "2026-07-11T12:00:00.000Z",
      availableVersion: "9.9.9"
    });
    expect(losslessConfig.install).toEqual({ id: "install-123" });
    expect(losslessConfig.futureSection).toEqual({ enabled: true, value: "keep-top-level" });
    expect(losslessConfig.server.futureServerKey).toBe("keep-nested");
    expect(losslessConfig.server.host).toBe("0.0.0.0");

    await rm(home, { recursive: true, force: true });
  });

  test("saveConfig preserves unknown property names requiring JSON escaping", async () => {
    const home = await makeTestHome("climon-jsonc-escaped-key-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    const unknownKey = 'future"\\key';
    const unknownValue = { enabled: true, label: "keep-me" };

    try {
      await writeFile(
        join(home, "config.jsonc"),
        JSON.stringify({
          version: 1,
          server: { host: "127.0.0.1", port: 3131 },
          [unknownKey]: unknownValue
        })
      );

      const config = await loadConfig(env);
      config.server.host = "0.0.0.0";
      await saveConfig(config, env);

      const reloaded = await loadConfig(env) as typeof config & Record<string, unknown>;
      expect(reloaded[unknownKey]).toEqual(unknownValue);
      expect(reloaded.server.host).toBe("0.0.0.0");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("loadConfig reads legacy config.json when config.jsonc is absent", async () => {
    const home = await makeTestHome("climon-jsonc-fallback-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 7777 },
        terminal: { clampBrowserToHost: true, detachPrefix: 0x1c },
        attention: { idleSeconds: 10 },
        session: { color: "green" }
      })
    );
    const config = await loadConfig(env);
    expect(config.server.port).toBe(7777);
    expect(config.session?.color).toBe("green");
    
    // Should still be reading from config.json, not creating config.jsonc
    expect(existsSync(join(home, "config.json"))).toBe(true);
    
    await rm(home, { recursive: true, force: true });
  });

  test("saveConfig preserves round-trip stability with legacy config", async () => {
    const home = await makeTestHome("climon-roundtrip-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await mkdir(home, { recursive: true });
    
    // Write legacy config.json with no remote section
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        terminal: { clampBrowserToHost: true, detachPrefix: 0x1c },
        attention: { idleSeconds: 10 },
        session: { color: "auto" }
      })
    );
    
    // Load config (may produce remote: undefined)
    const config = await loadConfig(env);
    
    // Save it back
    const { saveConfig } = await import("../src/config.js");
    await saveConfig(config, env);
    
    // Read config.jsonc and verify it doesn't contain "undefined"
    const configJsoncPath = join(home, "config.jsonc");
    expect(existsSync(configJsoncPath)).toBe(true);
    const raw = await readFile(configJsoncPath, "utf8");
    expect(raw).not.toContain("undefined");
    
    // Verify it can be parsed and loaded again
    const reloaded = await loadConfig(env);
    expect(reloaded.version).toBe(1);
    expect(reloaded.server.host).toBe("127.0.0.1");
    
    await rm(home, { recursive: true, force: true });
  });

  test("saveConfig migrates legacy config.json to backup", async () => {
    const home = await makeTestHome("climon-migrate-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await mkdir(home, { recursive: true });
    
    // Create legacy config.json
    const legacyPath = join(home, "config.json");
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        terminal: { clampBrowserToHost: true, detachPrefix: 0x1c },
        attention: { idleSeconds: 10 },
        session: { color: "auto" }
      })
    );
    
    // Call saveConfig with default config
    const { saveConfig } = await import("../src/config.js");
    await saveConfig(defaultConfig(), env);
    
    // Assert config.jsonc exists
    const canonicalPath = join(home, "config.jsonc");
    expect(existsSync(canonicalPath)).toBe(true);
    
    // Assert config.json.bak exists
    const backupPath = join(home, "config.json.bak");
    expect(existsSync(backupPath)).toBe(true);
    
    // Assert config.json no longer exists
    expect(existsSync(legacyPath)).toBe(false);
    
    await rm(home, { recursive: true, force: true });
  });
});

describe("config three-way saves", () => {
  test("server-style saves preserve install id", async () => {
    const home = await makeTestHome("climon-three-way-server-style-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    const installId = "00000000-0000-4000-8000-000000000000";
    const derivedTunnelId = deriveIngestTunnelId(installId);

    try {
      await writeFile(
        join(home, "config.jsonc"),
        JSON.stringify({
          version: 1,
          server: { host: "0.0.0.0", port: 3131 },
          install: { id: installId }
        })
      );

      const config = await loadConfig(env);
      config.server.host = "127.0.0.1";
      await saveConfig(config, env);

      const reloaded = await loadConfig(env);
      expect(reloaded.install?.id).toBe(installId);
      expect(deriveIngestTunnelId(reloaded.install?.id ?? "")).toBe(derivedTunnelId);
      expect(reloaded.server.host).toBe("127.0.0.1");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("preserves disjoint top-level changes and install id from stale loaded configs", async () => {
    const home = await makeTestHome("climon-three-way-top-level-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        terminal: { clampBrowserToHost: false, detachPrefix: 0x1c },
        install: { id: "install-three-way" }
      })
    );

    const first = await loadConfig(env);
    const second = await loadConfig(env);
    first.server.port = 4001;
    second.terminal.detachPrefix = 0x1d;

    await saveConfig(first, env);
    await saveConfig(second, env);

    const reloaded = await loadConfig(env);
    expect(reloaded.server.port).toBe(4001);
    expect(reloaded.terminal.detachPrefix).toBe(0x1d);
    expect(reloaded.install?.id).toBe("install-three-way");
    await rm(home, { recursive: true, force: true });
  });

  test("merges nested changes and deletion while preserving unrelated latest keys", async () => {
    const home = await makeTestHome("climon-three-way-nested-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    const initial = {
      version: 1,
      server: {
        host: "127.0.0.1",
        port: 3131,
        obsolete: "remove-me"
      },
      terminal: { clampBrowserToHost: false, detachPrefix: 0x1c }
    };
    await writeFile(join(home, "config.jsonc"), JSON.stringify(initial));

    const first = await loadConfig(env);
    const second = await loadConfig(env);
    first.server.host = "0.0.0.0";
    delete (second.server as typeof second.server & { obsolete?: string }).obsolete;

    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        ...initial,
        server: { ...initial.server, latestNested: "keep-nested" },
        latestTopLevel: { keep: true }
      })
    );

    await saveConfig(first, env);
    await saveConfig(second, env);

    const reloaded = await loadConfig(env);
    const record = reloaded as typeof reloaded & {
      server: typeof reloaded.server & {
        obsolete?: string;
        latestNested: string;
      };
      latestTopLevel: { keep: boolean };
    };
    expect(record.server.host).toBe("0.0.0.0");
    expect(record.server.obsolete).toBeUndefined();
    expect(record.server.latestNested).toBe("keep-nested");
    expect(record.latestTopLevel).toEqual({ keep: true });
    await rm(home, { recursive: true, force: true });
  });

  test("uses the later save when stale configs change the same setting", async () => {
    const home = await makeTestHome("climon-three-way-last-writer-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 }
      })
    );

    const first = await loadConfig(env);
    const second = await loadConfig(env);
    first.server.port = 4001;
    second.server.port = 4002;

    await saveConfig(first, env);
    await saveConfig(second, env);

    expect((await loadConfig(env)).server.port).toBe(4002);
    await rm(home, { recursive: true, force: true });
  });

  test("advances repeated-save golden state from the caller and preserves later external writes", async () => {
    const home = await makeTestHome("climon-three-way-repeated-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 }
      })
    );

    const config = await loadConfig(env);
    config.server.port = 4001;
    writeConfigSetting("update.lastCheck", "2026-07-11T12:00:00.000Z", "global", env);
    await saveConfig(config, env);
    expect(config.update).toBeUndefined();

    writeConfigSetting("update.lastCheck", "2026-07-11T13:00:00.000Z", "global", env);
    config.server.host = "0.0.0.0";
    await saveConfig(config, env);

    const reloaded = await loadConfig(env);
    expect(reloaded.server.port).toBe(4001);
    expect(reloaded.server.host).toBe("0.0.0.0");
    expect(reloaded.update?.lastCheck).toBe("2026-07-11T13:00:00.000Z");
    await rm(home, { recursive: true, force: true });
  });

  test("persists caller mutations made while an earlier save is pending", async () => {
    const home = await makeTestHome("climon-three-way-pending-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 }
      })
    );

    const config = await loadConfig(env);
    config.server.port = 4001;
    const pending = saveConfig(config, env);
    config.server.host = "0.0.0.0";
    await pending;
    await saveConfig(config, env);

    const reloaded = await loadConfig(env);
    expect(reloaded.server.port).toBe(4001);
    expect(reloaded.server.host).toBe("0.0.0.0");
    await rm(home, { recursive: true, force: true });
  });

  test("fully replaces config objects that were not returned by loadConfig", async () => {
    const home = await makeTestHome("climon-three-way-untracked-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        install: { id: "replace-me" },
        futureSection: { remove: true }
      })
    );

    const replacement = defaultConfig();
    replacement.server.port = 4999;
    await saveConfig(replacement, env);

    const reloaded = await loadConfig(env);
    const record = reloaded as typeof reloaded & {
      futureSection?: { remove: boolean };
    };
    expect(reloaded.server.port).toBe(4999);
    expect(reloaded.install).toBeUndefined();
    expect(record.futureSection).toBeUndefined();
    await rm(home, { recursive: true, force: true });
  });
});

describe("logging config settings", () => {
  test("logging.level defaults to trace", () => {
    const config = buildDefaultConfigFromSettings() as unknown as {
      logging: { level: string };
    };
    expect(config.logging.level).toBe("trace");
  });

  test("logging.level accepts a valid pino level", () => {
    expect(coerceConfigValueFromSettings("logging.level", "debug")).toBe("debug");
    expect(coerceConfigValueFromSettings("logging.level", "silent")).toBe("silent");
  });

  test("logging.level rejects an invalid level", () => {
    expect(() => coerceConfigValueFromSettings("logging.level", "loud")).toThrow();
  });

  test("logging.appInsights.connectionString is not a configurable setting", () => {
    // The App Insights connection string is a secret and must not live in
    // climon config; it is supplied via the APPLICATIONINSIGHTS_CONNECTION_STRING
    // environment variable or the build-time embedded constant instead.
    expect(findConfigSetting("logging.appInsights.connectionString")).toBeUndefined();
  });
});
