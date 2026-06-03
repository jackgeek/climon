import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  defaultConfig,
  getScrollbackPath,
  getSessionMetaPath,
  getSessionsDir,
  getSocketPath
} from "../src/config.js";

const env = { CLIMON_HOME: "/tmp/climon-test" } as NodeJS.ProcessEnv;

describe("config paths", () => {
  test("sessions dir is under climon home", () => {
    expect(getSessionsDir(env)).toBe(join("/tmp/climon-test", "sessions"));
  });

  test("session meta path uses id", () => {
    expect(getSessionMetaPath("abc", env)).toBe(join("/tmp/climon-test", "sessions", "abc.json"));
  });

  test("scrollback path uses id", () => {
    expect(getScrollbackPath("abc", env)).toBe(join("/tmp/climon-test", "sessions", "abc.scrollback"));
  });

  test("socket path is a unix socket on posix", () => {
    expect(getSocketPath("abc", env, "linux")).toBe(join("/tmp/climon-test", "sock", "abc.sock"));
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
});

describe("config migration", () => {
  test("backfills a missing attention section", async () => {
    const home = await mkdtemp(join(tmpdir(), "climon-cfg-"));
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
});
