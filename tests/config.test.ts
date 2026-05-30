import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  defaultConfig,
  generateToken,
  getScrollbackPath,
  getSessionMetaPath,
  getSessionsDir
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
});

describe("config defaults", () => {
  test("generates a non-empty token", () => {
    expect(generateToken().length).toBeGreaterThan(10);
  });

  test("default config binds to localhost", () => {
    const config = defaultConfig("tok");
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.lan).toBe(false);
    expect(config.server.token).toBe("tok");
  });

  test("clamps browser to host terminal size by default", () => {
    expect(defaultConfig("tok").terminal.clampBrowserToHost).toBe(true);
  });

  test("defaults attention idle window to 10 seconds", () => {
    expect(defaultConfig("tok").attention.idleSeconds).toBe(10);
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
