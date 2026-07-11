import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
