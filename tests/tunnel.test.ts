import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureClimonHome, getRemoteHostPath } from "../src/config.js";
import { parseTunnelInput, useManualTunnel, deleteTunnel } from "../src/remote/tunnel.js";

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
  test("rejects junk", () => {
    expect(parseTunnelInput("")).toBeUndefined();
    expect(parseTunnelInput("has spaces")).toBeUndefined();
  });
});

describe("useManualTunnel", () => {
  test("persists remote-host.json with canHost from availability", async () => {
    await useManualTunnel(
      { tunnelId: "abc123", connectToken: "tok", ingestPort: 3132 },
      { devtunnelAvailable: false, env }
    );
    const raw = JSON.parse(readFileSync(getRemoteHostPath(env), "utf8"));
    expect(raw.tunnelId).toBe("abc123");
    expect(raw.ingestPort).toBe(3132);
    expect(raw.canHost).toBe(false);
  });

  test("deleteTunnel removes remote-host.json", async () => {
    await useManualTunnel(
      { tunnelId: "abc123", connectToken: "tok", ingestPort: 3132 },
      { devtunnelAvailable: true, env, runner: async () => ({ status: 0, stdout: "", stderr: "" }) }
    );
    await deleteTunnel({ env, runner: async () => ({ status: 0, stdout: "", stderr: "" }) });
    expect(() => readFileSync(getRemoteHostPath(env), "utf8")).toThrow();
  });
});
