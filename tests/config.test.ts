import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import {
  defaultConfig,
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

  test("clamps browser to host terminal size by default", () => {
    expect(defaultConfig().terminal.clampBrowserToHost).toBe(true);
  });

  test("sets the terminal title by default", () => {
    expect(defaultConfig().terminal.setTitle).toBe(true);
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

  test("backfills a missing terminal.setTitle", async () => {
    const home = await makeTestHome("climon-cfg-");
    const migrationEnv = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
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
    const config = await loadConfig(migrationEnv);
    expect(config.terminal.setTitle).toBe(true);
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
        terminal: { clampBrowserToHost: true, setTitle: true },
        attention: { idleSeconds: 10 }
      })
    );
    const config = await loadConfig(env);
    expect(config.session?.color).toBe("auto");
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
        terminal: { clampBrowserToHost: true, setTitle: true },
        attention: { idleSeconds: 10 },
        session: { color: "orange" }
      })
    );
    const config = await loadConfig(env);
    expect(config.session?.color).toBe("auto");
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
