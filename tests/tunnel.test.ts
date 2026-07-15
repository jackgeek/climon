import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureClimonHome, getRemoteHostPath } from "../src/config.js";
import { DevtunnelError } from "../src/devtunnel/types.js";
import { deriveIngestTunnelId } from "../src/remote/ingest-tunnel-id.js";
import * as tunnel from "../src/remote/tunnel.js";

const { parseTunnelInput, useManualTunnel, deleteTunnel } = tunnel;
const TEST_TMP_ROOT = join(process.cwd(), ".test-tmp");

function makeTestHome(prefix: string): string {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TEST_TMP_ROOT, prefix));
}

function tempHome(installId: string): NodeJS.ProcessEnv {
  const home = makeTestHome("climon-tun-");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.jsonc"), JSON.stringify({ install: { id: installId } }));
  return { ...process.env, CLIMON_HOME: home };
}

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = makeTestHome("climon-tunnel-");
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
    const fakeHome = makeTestHome("climon-icu-");
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

describe("createTunnel labeling", () => {
  test("creates a stable-id tunnel with the label and non-secret description", async () => {
    const installId = "00000000-0000-4000-8000-000000000000";
    const localEnv = tempHome(installId);
    const calls: string[][] = [];
    const runner = async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "create") {
        return { status: 0, stdout: JSON.stringify({ tunnelId: `${args[1]}.eun1` }), stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const state = await tunnel.createTunnel(7070, { env: localEnv, runner });

    const expectedId = deriveIngestTunnelId(installId);
    const createArgs = calls.find((a) => a[0] === "create");
    expect(createArgs).toBeDefined();
    expect(createArgs).toContain(expectedId);
    expect(createArgs).toContain("--labels");
    expect(createArgs).toContain("climon-ingest");
    const descIdx = createArgs?.indexOf("--description") ?? -1;
    expect(descIdx).toBeGreaterThan(-1);
    const desc = JSON.parse(createArgs![descIdx + 1]);
    expect(desc.app).toBe("climon");
    expect(desc.role).toBe("ingest");
    expect(JSON.stringify(desc)).not.toContain("secret");
    expect(state.tunnelId).toBe(`${expectedId}.eun1`);
    expect(state.ingestPort).toBe(7070);
    rmSync(localEnv.CLIMON_HOME!, { recursive: true, force: true });
  });
});

describe("ensureIngestTunnel", () => {
  test("reuses an existing stable-id tunnel (show hit -> no create)", async () => {
    const installId = "00000000-0000-4000-8000-000000000000";
    const localEnv = tempHome(installId);
    const id = deriveIngestTunnelId(installId);
    const calls: string[][] = [];
    const runner = async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "show") return { status: 0, stdout: JSON.stringify({ tunnel: { tunnelId: `${id}.eun1` } }), stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const state = await tunnel.ensureIngestTunnel(7071, { env: localEnv, runner });
    expect(calls.some((a) => a[0] === "create")).toBe(false);
    expect(state.tunnelId).toBe(`${id}.eun1`);
    expect(state.ingestPort).toBe(7071);
    rmSync(localEnv.CLIMON_HOME!, { recursive: true, force: true });
  });

  test("creates when the tunnel is absent (show miss -> create)", async () => {
    const installId = "11111111-2222-4333-8444-555555555555";
    const localEnv = tempHome(installId);
    const calls: string[][] = [];
    const runner = async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "show") return { status: 1, stdout: "", stderr: "not found" };
      if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: `${args[1]}.eun1` }), stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const state = await tunnel.ensureIngestTunnel(7072, { env: localEnv, runner });
    expect(calls.some((a) => a[0] === "create")).toBe(true);
    expect(state.ingestPort).toBe(7072);
    rmSync(localEnv.CLIMON_HOME!, { recursive: true, force: true });
  });
});

describe("ensureIngestTunnel failures", () => {
  async function catchFailure(fn: () => Promise<unknown>): Promise<DevtunnelError | undefined> {
    try {
      await fn();
      return undefined;
    } catch (e) {
      return e as DevtunnelError;
    }
  }

  test("reports not_authenticated without writing remote-host.json", async () => {
    const localEnv = tempHome("00000000-0000-4000-8000-000000000000");
    const runner = async (_cmd: string, args: string[]) => {
      if (args[0] === "show") return { status: 1, stdout: "", stderr: "User is not logged in." };
      return { status: 0, stdout: "", stderr: "" };
    };
    const failure = await catchFailure(() => tunnel.ensureIngestTunnel(7100, { env: localEnv, runner }));
    expect(failure).toBeInstanceOf(DevtunnelError);
    expect(failure?.failure.code).toBe("not_authenticated");
    expect(existsSync(getRemoteHostPath(localEnv))).toBe(false);
    rmSync(localEnv.CLIMON_HOME!, { recursive: true, force: true });
  });

  test("reports tunnel_quota_exhausted from create without writing state", async () => {
    const localEnv = tempHome("11111111-2222-4333-8444-555555555555");
    const runner = async (_cmd: string, args: string[]) => {
      if (args[0] === "show") return { status: 1, stdout: "", stderr: "tunnel not found" };
      if (args[0] === "create") return { status: 1, stdout: "", stderr: "maximum number of tunnels reached" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const failure = await catchFailure(() => tunnel.ensureIngestTunnel(7101, { env: localEnv, runner }));
    expect(failure).toBeInstanceOf(DevtunnelError);
    expect(failure?.failure.code).toBe("tunnel_quota_exhausted");
    expect(existsSync(getRemoteHostPath(localEnv))).toBe(false);
    rmSync(localEnv.CLIMON_HOME!, { recursive: true, force: true });
  });

  test("surfaces a transient port failure in the reuse path without writing state", async () => {
    const installId = "22222222-3333-4444-8555-666666666666";
    const localEnv = tempHome(installId);
    const id = deriveIngestTunnelId(installId);
    const runner = async (_cmd: string, args: string[]) => {
      if (args[0] === "show") return { status: 0, stdout: JSON.stringify({ tunnel: { tunnelId: `${id}.eun1` } }), stderr: "" };
      if (args[0] === "port" && args[1] === "create") return { status: 1, stdout: "", stderr: "network is unreachable" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const failure = await catchFailure(() => tunnel.ensureIngestTunnel(7102, { env: localEnv, runner }));
    expect(failure).toBeInstanceOf(DevtunnelError);
    expect(failure?.failure.code).toBe("network_unavailable");
    expect(existsSync(getRemoteHostPath(localEnv))).toBe(false);
    rmSync(localEnv.CLIMON_HOME!, { recursive: true, force: true });
  });
});

describe("reconcileTunnelPort failures", () => {
  test("returns a typed failure when recreation fails and leaves the old state intact", async () => {
    const localEnv = tempHome("33333333-4444-4555-8666-777777777777");
    await tunnel.useManualTunnel(
      { tunnelId: "climon-ingest-abcdef.eun1", ingestPort: 3132 },
      { devtunnelAvailable: true, env: localEnv, runner: async () => ({ status: 0, stdout: "", stderr: "" }) }
    );
    const runner = async (_cmd: string, args: string[]) => {
      if (args[0] === "port" && args[1] === "delete") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "port" && args[1] === "create") return { status: 1, stdout: "", stderr: "network is unreachable" };
      if (args[0] === "create") return { status: 1, stdout: "", stderr: "maximum number of tunnels reached" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = await tunnel.reconcileTunnelPort(4000, { env: localEnv, runner });
    expect(result.changed).toBe(false);
    expect(result.failure).toBeDefined();
    expect(result.failure?.code).toBe("tunnel_quota_exhausted");
    const raw = JSON.parse(readFileSync(getRemoteHostPath(localEnv), "utf8"));
    expect(raw.ingestPort).toBe(3132);
    rmSync(localEnv.CLIMON_HOME!, { recursive: true, force: true });
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
