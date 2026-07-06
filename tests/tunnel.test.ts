import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureClimonHome, getRemoteHostPath } from "../src/config.js";
import * as tunnel from "../src/remote/tunnel.js";

const { parseTunnelInput, useManualTunnel, deleteTunnel } = tunnel;

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "climon-tunnel-"));
  env = { CLIMON_HOME: home };
  await ensureClimonHome(env);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("parseTunnelInput", () => {
  test("extracts id from a devtunnels.ms URL", () => {
    expect(parseTunnelInput("https://abc123-6666.usw2.devtunnels.ms/")).toBe("abc123");
  });
  test("passes a bare id through", () => {
    expect(parseTunnelInput("abc123")).toBe("abc123");
  });
  test("matches the devtunnel service tunnel id rules", () => {
    expect(parseTunnelInput("climon-tunnel")).toBe("climon-tunnel");
    expect(parseTunnelInput("https://climon-tunnel-8080.usw2.devtunnels.ms/")).toBe("climon-tunnel");
    expect(parseTunnelInput("CLIMON_TUNNEL")).toBeUndefined();
    expect(parseTunnelInput("UpperCase")).toBeUndefined();
    expect(parseTunnelInput("-starts-with-hyphen")).toBeUndefined();
    expect(parseTunnelInput("ends-with-hyphen-")).toBeUndefined();
  });
  test("rejects junk", () => {
    expect(parseTunnelInput("")).toBeUndefined();
    expect(parseTunnelInput("has spaces")).toBeUndefined();
  });
});

describe("useManualTunnel", () => {
  test("persists remote-host.json with canHost from availability", async () => {
    await useManualTunnel(
      { tunnelId: "abc123", ingestPort: 3132 },
      { devtunnelAvailable: false, env }
    );
    const raw = JSON.parse(readFileSync(getRemoteHostPath(env), "utf8"));
    expect(raw.tunnelId).toBe("abc123");
    expect(raw.ingestPort).toBe(3132);
    expect(raw.canHost).toBe(false);
  });

  test("deleteTunnel removes remote-host.json", async () => {
    await useManualTunnel(
      { tunnelId: "abc123", ingestPort: 3132 },
      { devtunnelAvailable: true, env, runner: async () => ({ status: 0, stdout: "", stderr: "" }) }
    );
    await deleteTunnel({ env, runner: async () => ({ status: 0, stdout: "", stderr: "" }) });
    expect(() => readFileSync(getRemoteHostPath(env), "utf8")).toThrow();
  });
});

describe("devtunnelEnv", () => {
  test("adds the user-local ICU library path when LD_LIBRARY_PATH is missing", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "climon-icu-"));
    try {
      const icuLib = join(fakeHome, ".local", "icu", "usr", "lib", "x86_64-linux-gnu");
      mkdirSync(icuLib, { recursive: true });

      expect(typeof tunnel.devtunnelEnv).toBe("function");
      expect(tunnel.devtunnelEnv({ HOME: fakeHome })).toMatchObject({
        HOME: fakeHome,
        LD_LIBRARY_PATH: icuLib
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("CLIMON_DISABLE_DEVTUNNEL guard", () => {
  test("CLIMON_DISABLE_DEVTUNNEL isDevtunnelDisabled reads the env flag", () => {
    expect(tunnel.isDevtunnelDisabled({ CLIMON_DISABLE_DEVTUNNEL: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(tunnel.isDevtunnelDisabled({ CLIMON_DISABLE_DEVTUNNEL: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(tunnel.isDevtunnelDisabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test("CLIMON_DISABLE_DEVTUNNEL detectDevtunnel reports unavailable when disabled (no spawn)", async () => {
    const prev = process.env.CLIMON_DISABLE_DEVTUNNEL;
    process.env.CLIMON_DISABLE_DEVTUNNEL = "1";
    try {
      const res = await tunnel.detectDevtunnel();
      expect(res.available).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLIMON_DISABLE_DEVTUNNEL;
      else process.env.CLIMON_DISABLE_DEVTUNNEL = prev;
    }
  });
});
