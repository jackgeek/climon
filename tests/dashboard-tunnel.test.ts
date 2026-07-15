import { describe, expect, test } from "bun:test";
import {
  buildDashboardTunnelUrl,
  createDashboardTunnelManager,
  dashboardTunnelAuthMessage,
  parseDashboardTunnelUrl,
  parseTunnelCreate,
  parseTunnelExpiry,
  splitTunnelId,
  type DashboardTunnelRunner
} from "../src/server/dashboard-tunnel.js";
import { createDevtunnelGateway } from "../src/devtunnel/gateway.js";
import type { DevtunnelProcessHandlers, RawDevtunnelProcessSpawner } from "../src/devtunnel/process.js";
import { DevtunnelError, type DevtunnelErrorCode } from "../src/devtunnel/types.js";

type ManagerOptions = Parameters<typeof createDashboardTunnelManager>[0];

/** Legacy host-process handler shape used by the test spawners below. */
interface TestHostHandlers {
  onStdout: (text: string) => void;
  onStderr: (text: string) => void;
  onExit: (code: number | null) => void;
}
type TestHostSpawner = (
  cmd: string,
  args: string[],
  handlers: TestHostHandlers
) => { stop: () => void; isAlive: () => boolean };

interface TestManagerOptions {
  port: number;
  runner?: DashboardTunnelRunner;
  hostSpawner?: TestHostSpawner;
  verifyTunnel?: (url: string) => Promise<boolean>;
  watchdogMs?: number;
  hostUrlTimeoutMs?: number;
  keepAliveMs?: number;
  pingTunnel?: (url: string) => Promise<void>;
  persisted?: { tunnelId?: string; cluster?: string };
  onPersistTunnel?: (value: { tunnelId: string; cluster?: string }) => void | Promise<void>;
  onClearPersistedTunnel?: () => void | Promise<void>;
}

/** Adapts the legacy host-spawner shape to the gateway's raw process spawner. */
function adaptRawSpawner(hostSpawner: TestHostSpawner): RawDevtunnelProcessSpawner {
  return (cmd, args, handlers) =>
    hostSpawner(cmd, args, {
      onStdout: handlers.onStdout,
      onStderr: handlers.onStderr,
      onExit: (code) => handlers.onExit({ status: code })
    });
}

/**
 * Builds a manager backed by a fake {@link DevtunnelGateway} constructed from the
 * test's runner + host spawner. Tunnel verification is stubbed to succeed unless
 * overridden. The same runner also serves the raw verbose-expiry probe.
 */
function createManager(options: TestManagerOptions) {
  const { runner, hostSpawner, ...rest } = options;
  const managerOptions: ManagerOptions = { verifyTunnel: async () => true, ...rest };
  if (runner || hostSpawner) {
    managerOptions.gateway = (handlers: DevtunnelProcessHandlers) =>
      createDevtunnelGateway({
        runner: runner ?? (async () => ({ status: 0, stdout: "", stderr: "" })),
        rawProcessSpawner: hostSpawner ? adaptRawSpawner(hostSpawner) : undefined,
        processHandlers: handlers
      });
    if (runner) managerOptions.rawRunner = runner;
  }
  return createDashboardTunnelManager(managerOptions);
}

/** Awaits a rejected promise and asserts it rejects with a {@link DevtunnelError}. */
async function expectDevtunnelError(
  promise: Promise<unknown>,
  code?: DevtunnelErrorCode
): Promise<DevtunnelError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DevtunnelError);
  const error = caught as DevtunnelError;
  if (code) expect(error.failure.code).toBe(code);
  return error;
}

describe("parseDashboardTunnelUrl", () => {
  test("extracts the dashboard URL from devtunnel host output", () => {
    expect(
      parseDashboardTunnelUrl("Hosting port 3131 at https://climon-test-3131.eun1.devtunnels.ms/")
    ).toBe("https://climon-test-3131.eun1.devtunnels.ms/");
  });

  test("returns only the URL matching the expected port when one is given", () => {
    const output =
      "Hosting port 39999 at https://climon-test-39999.eun1.devtunnels.ms/\n" +
      "Hosting port 39997 at https://climon-test-39997.eun1.devtunnels.ms/\n";
    expect(parseDashboardTunnelUrl(output, 39997)).toBe("https://climon-test-39997.eun1.devtunnels.ms/");
  });

  test("ignores URLs for other ports when an expected port is given", () => {
    expect(
      parseDashboardTunnelUrl("https://climon-test-39999.eun1.devtunnels.ms/", 39997)
    ).toBeUndefined();
  });
});

describe("splitTunnelId", () => {
  test("splits a cluster-suffixed tunnel id into base and cluster", () => {
    expect(splitTunnelId("peaceful-dog-g5pzmr1.eun1")).toEqual({
      base: "peaceful-dog-g5pzmr1",
      cluster: "eun1"
    });
  });

  test("returns the id as base when no cluster suffix is present", () => {
    expect(splitTunnelId("climon-test")).toEqual({ base: "climon-test", cluster: undefined });
  });
});

describe("parseTunnelCreate", () => {
  test("derives the cluster from the tunnel id suffix when no explicit cluster field exists", () => {
    expect(
      parseTunnelCreate(JSON.stringify({ tunnel: { tunnelId: "peaceful-dog-g5pzmr1.eun1" } }))
    ).toEqual({ tunnelId: "peaceful-dog-g5pzmr1.eun1", cluster: "eun1" });
  });

  test("ignores a leading welcome banner before the JSON payload", () => {
    const stdout =
      "Welcome to dev tunnels!\nCLI version: 1.0.0\n\n" +
      JSON.stringify({ tunnel: { tunnelId: "brave-fox-abc123.use1" } });
    expect(parseTunnelCreate(stdout)).toEqual({ tunnelId: "brave-fox-abc123.use1", cluster: "use1" });
  });

  test("prefers an explicit cluster field over the suffix", () => {
    expect(parseTunnelCreate(JSON.stringify({ tunnelId: "fresh-tunnel", clusterId: "use1" }))).toEqual({
      tunnelId: "fresh-tunnel",
      cluster: "use1"
    });
  });
});

describe("buildDashboardTunnelUrl", () => {
  test("builds the browser URL from tunnel id, port, and cluster", () => {
    expect(buildDashboardTunnelUrl("climon-test", 3131, "eun1")).toBe(
      "https://climon-test-3131.eun1.devtunnels.ms/"
    );
  });

  test("strips a cluster suffix from the tunnel id when building the URL", () => {
    expect(buildDashboardTunnelUrl("peaceful-dog-g5pzmr1.eun1", 3131, "eun1")).toBe(
      "https://peaceful-dog-g5pzmr1-3131.eun1.devtunnels.ms/"
    );
  });
});

describe("createDashboardTunnelManager", () => {
  test("reports unavailable when the devtunnel CLI cannot run", async () => {
    const manager = createManager({
      port: 3131,
      runner: async () => ({ status: 127, stdout: "", stderr: "missing" })
    });

    await expect(manager.status()).resolves.toMatchObject({
      devtunnelAvailable: false,
      authenticated: false,
      running: false
    });
  });

  test("rejects with a structured not_authenticated failure before hosting", async () => {
    const manager = createManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 1, stdout: "", stderr: "not logged in" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    });

    const error = await expectDevtunnelError(manager.ensure(), "not_authenticated");
    expect(error.failure.retryClass).toBe("actionable");
  });

  test("treats devtunnel user show Not logged in JSON as unauthenticated", async () => {
    const manager = createManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Not logged in" }), stderr: "" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    });

    await expect(manager.status()).resolves.toMatchObject({
      devtunnelAvailable: true,
      authenticated: false
    });
    await expectDevtunnelError(manager.ensure(), "not_authenticated");
  });

  test("surfaces a structured quota-exhausted failure with remediation", async () => {
    const manager = createManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") return { status: 1, stdout: "", stderr: "You already have too many tunnels" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    });

    const error = await expectDevtunnelError(manager.ensure(), "tunnel_quota_exhausted");
    expect(error.failure.summary).toContain("too many tunnels");
    expect(error.failure.remediation).toContain("devtunnel list");
  });

  test("throws a structured host failure carrying technical detail on early exit", async () => {
    const manager = createManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, _args, handlers) => {
        handlers.onStderr("relay handshake failed unexpectedly");
        handlers.onExit(1);
        return { stop: () => undefined, isAlive: () => false };
      }
    });

    const error = await expectDevtunnelError(manager.ensure());
    expect(error.failure.technicalDetail).toContain("relay handshake failed");
  });

  test("creates a tunnel once and reuses it on subsequent ensure calls", async () => {
    const commands: string[] = [];
    const runner: DashboardTunnelRunner = async (_cmd, args) => {
      commands.push(args.join(" "));
      if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
      if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
      if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
      if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected runner command: ${args.join(" ")}`);
    };
    const manager = createManager({
      port: 3131,
      runner,
      hostSpawner: (_cmd, args, handlers) => {
        commands.push(args.join(" "));
        handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
        return { stop: () => undefined, isAlive: () => true };
      }
    });

    await expect(manager.ensure()).resolves.toMatchObject({
      url: "https://climon-test-3131.eun1.devtunnels.ms/",
      running: true
    });
    await expect(manager.ensure()).resolves.toMatchObject({
      url: "https://climon-test-3131.eun1.devtunnels.ms/",
      tunnelId: "climon-test",
      running: true
    });

    expect(commands.filter((cmd) => cmd.startsWith("create"))).toHaveLength(1);
    expect(commands.filter((cmd) => cmd.startsWith("host"))).toHaveLength(1);
  });

  test("uses persisted tunnel id without creating a new tunnel", async () => {
    const commands: string[] = [];
    const manager = createManager({
      port: 3131,
      persisted: { tunnelId: "saved-tunnel", cluster: "eun1" },
      runner: async (_cmd, args) => {
        commands.push(args.join(" "));
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected runner command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, args, handlers) => {
        commands.push(args.join(" "));
        handlers.onStdout("Ready: https://saved-tunnel-3131.eun1.devtunnels.ms/");
        return { stop: () => undefined, isAlive: () => true };
      }
    });

    await manager.ensure();

    expect(commands.filter((cmd) => cmd.startsWith("create"))).toHaveLength(0);
    expect(commands).toContain("host saved-tunnel");
  });

  test("builds a fallback URL when the host prints no browser link but the id carries a cluster", async () => {
    const portCommands: string[] = [];
    const manager = createManager({
      port: 3131,
      persisted: { tunnelId: "peaceful-dog-g5pzmr1.eun1" },
      watchdogMs: 100000,
      hostUrlTimeoutMs: 50,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "port") {
          portCommands.push(args.join(" "));
          return { status: 1, stdout: "", stderr: "Conflict with existing entity" };
        }
        throw new Error(`unexpected runner command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, _args, handlers) => {
        handlers.onStdout("Connection to host tunnel relay restored.\nHosting port: 3131\n");
        return { stop: () => undefined, isAlive: () => true };
      }
    });

    await expect(manager.ensure()).resolves.toMatchObject({
      url: "https://peaceful-dog-g5pzmr1-3131.eun1.devtunnels.ms/",
      running: true
    });
    expect(portCommands).toContain("port create peaceful-dog-g5pzmr1.eun1 -p 3131 --protocol http");
  });

  test("deletes and recreates the dev tunnel when the link fails verification", async () => {
    const commands: string[] = [];
    let createCount = 0;
    const manager = createManager({
      port: 3131,
      runner: async (_cmd, args) => {
        commands.push(args.join(" "));
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") {
          createCount += 1;
          const id = createCount === 1 ? "broken-tunnel.eun1" : "working-tunnel.eun1";
          return { status: 0, stdout: JSON.stringify({ tunnel: { tunnelId: id } }), stderr: "" };
        }
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "delete") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected runner command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, args, handlers) => {
        const id = args[1];
        handlers.onStdout(`Connect via browser: https://${id.split(".")[0]}-3131.eun1.devtunnels.ms`);
        return { stop: () => undefined, isAlive: () => true };
      },
      verifyTunnel: async (url) => url.includes("working-tunnel")
    });

    await expect(manager.ensure()).resolves.toMatchObject({
      url: "https://working-tunnel-3131.eun1.devtunnels.ms",
      tunnelId: "working-tunnel.eun1",
      running: true
    });
    expect(commands).toContain("delete broken-tunnel.eun1 --force");
    expect(commands.filter((cmd) => cmd.startsWith("create"))).toHaveLength(2);
  });

  test("returns the link as best effort when verification keeps failing after one recreate", async () => {
    let createCount = 0;
    const deletions: string[] = [];
    const manager = createManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") {
          createCount += 1;
          return { status: 0, stdout: JSON.stringify({ tunnel: { tunnelId: `tunnel-${createCount}.eun1` } }), stderr: "" };
        }
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "delete") {
          deletions.push(args[1]);
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected runner command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, args, handlers) => {
        const id = args[1];
        handlers.onStdout(`Connect via browser: https://${id.split(".")[0]}-3131.eun1.devtunnels.ms`);
        return { stop: () => undefined, isAlive: () => true };
      },
      verifyTunnel: async () => false
    });

    await expect(manager.ensure()).resolves.toMatchObject({
      url: "https://tunnel-2-3131.eun1.devtunnels.ms",
      running: true
    });
    expect(deletions).toEqual(["tunnel-1.eun1"]);
    expect(createCount).toBe(2);
  });

  test("recreates and persists replacement when persisted tunnel no longer exists", async () => {
    const persistedWrites: Array<{ tunnelId: string; cluster?: string }> = [];
    const cleared: number[] = [];
    let firstHost = true;
    const manager = createManager({
      port: 3131,
      persisted: { tunnelId: "stale-tunnel", cluster: "eun1" },
      onPersistTunnel: (value) => {
        persistedWrites.push(value);
      },
      onClearPersistedTunnel: () => {
        cleared.push(1);
      },
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") {
          return {
            status: 0,
            stdout: JSON.stringify({ tunnelId: "fresh-tunnel", clusterId: "use1" }),
            stderr: ""
          };
        }
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected runner command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, args, handlers) => {
        if (args[0] === "host" && firstHost) {
          firstHost = false;
          handlers.onStderr("Tunnel stale-tunnel not found");
          handlers.onExit(1);
          return { stop: () => undefined, isAlive: () => false };
        }
        handlers.onStdout("Ready: https://fresh-tunnel-3131.use1.devtunnels.ms/");
        return { stop: () => undefined, isAlive: () => true };
      }
    });

    await manager.ensure();

    expect(cleared).toHaveLength(1);
    expect(persistedWrites).toContainEqual({ tunnelId: "fresh-tunnel", cluster: "use1" });
  });

  test("recreates the tunnel when port create reports the persisted tunnel is missing", async () => {
    const persistedWrites: Array<{ tunnelId: string; cluster?: string }> = [];
    const cleared: number[] = [];
    const portCommands: string[] = [];
    const manager = createManager({
      port: 3131,
      persisted: { tunnelId: "neat-field-091135c", cluster: "eun1" },
      onPersistTunnel: (value) => {
        persistedWrites.push(value);
      },
      onClearPersistedTunnel: () => {
        cleared.push(1);
      },
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") {
          return {
            status: 0,
            stdout: JSON.stringify({ tunnelId: "fresh-tunnel", clusterId: "use1" }),
            stderr: ""
          };
        }
        if (args[0] === "port") {
          portCommands.push(args.join(" "));
          if (args.includes("neat-field-091135c")) {
            return { status: 1, stdout: "", stderr: "Tunnel not found in eun1: neat-field-091135c" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected runner command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, _args, handlers) => {
        handlers.onStdout("Ready: https://fresh-tunnel-3131.use1.devtunnels.ms/");
        return { stop: () => undefined, isAlive: () => true };
      }
    });

    await expect(manager.ensure()).resolves.toMatchObject({
      url: "https://fresh-tunnel-3131.use1.devtunnels.ms/",
      tunnelId: "fresh-tunnel",
      running: true
    });
    expect(cleared).toHaveLength(1);
    expect(persistedWrites).toContainEqual({ tunnelId: "fresh-tunnel", cluster: "use1" });
    expect(portCommands).toContain("port create fresh-tunnel -p 3131 --protocol http");
  });

  test("hosts the existing tunnel without passing port args after creating the port", async () => {
    const hostCommands: string[] = [];
    const manager = createManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") {
          return {
            status: 0,
            stdout: JSON.stringify({ tunnel: { tunnelId: "puzzled-book-2hfcf54.eun1" } }),
            stderr: ""
          };
        }
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected runner command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, args, handlers) => {
        hostCommands.push(args.join(" "));
        handlers.onStdout("Connect via browser: https://mtspdl6f-3131.eun1.devtunnels.ms");
        return { stop: () => undefined, isAlive: () => true };
      }
    });

    await manager.ensure();

    expect(hostCommands).toEqual(["host puzzled-book-2hfcf54.eun1"]);
  });

  test("creates an authenticated dashboard tunnel without anonymous browser access", async () => {
    const runnerCommands: string[] = [];
    const manager = createManager({
      port: 3131,
      runner: async (_cmd, args) => {
        runnerCommands.push(args.join(" "));
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected runner command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, _args, handlers) => {
        handlers.onStdout("Connect via browser: https://climon-test-3131.eun1.devtunnels.ms");
        return { stop: () => undefined, isAlive: () => true };
      }
    });

    await manager.ensure();

    expect(runnerCommands).toContain("create --json");
    expect(runnerCommands.some((cmd) => cmd.includes("--allow-anonymous"))).toBe(false);
  });

  test("pings the dashboard health endpoint through the tunnel to keep the relay alive", async () => {
    const pings: string[] = [];
    const manager = createManager({
      port: 3131,
      keepAliveMs: 1,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, _args, handlers) => {
        handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
        return { stop: () => undefined, isAlive: () => true };
      },
      pingTunnel: async (url) => {
        pings.push(url);
      }
    });

    await manager.ensure();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await manager.close();

    expect(pings.length).toBeGreaterThan(0);
    expect(pings[0]).toBe("https://climon-test-3131.eun1.devtunnels.ms/");
  });

  test("stops pinging the tunnel after close", async () => {
    let pingCount = 0;
    const manager = createManager({
      port: 3131,
      keepAliveMs: 1,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, _args, handlers) => {
        handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
        return { stop: () => undefined, isAlive: () => true };
      },
      pingTunnel: async () => {
        pingCount += 1;
      }
    });

    await manager.ensure();
    await manager.close();
    const afterClose = pingCount;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(pingCount).toBe(afterClose);
  });

  test("a recreated tunnel survives the discarded host's delayed intentional exit", async () => {
    let verifyCount = 0;
    // Captures the discarded host's exit so the test can fire it AFTER the
    // replacement host is live, reproducing the async-exit clobber.
    const deferredExits: Array<() => void> = [];
    const manager = createManager({
      port: 3131,
      // The first host fails verification (forcing one recreation); the second passes.
      verifyTunnel: async () => {
        verifyCount += 1;
        return verifyCount > 1;
      },
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      hostSpawner: (_cmd, _args, handlers) => {
        let alive = true;
        handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
        return {
          // Defer the exit callback: a real SIGTERM'd host exits asynchronously,
          // sometimes after the replacement host is already assigned.
          stop: () => {
            if (!alive) return;
            alive = false;
            deferredExits.push(() => handlers.onExit(1));
          },
          isAlive: () => alive
        };
      }
    });

    const started = await manager.ensure();
    expect(started.running).toBe(true);
    // Flush the discarded host's exit now that the replacement is live.
    for (const fire of deferredExits.splice(0)) fire();
    const after = await manager.status();

    expect(after.running).toBe(true);
    expect(after.state).toBe("running");
    expect(after.lastFailure).toBeUndefined();

    await manager.close();
  });

  test("close reports stopped even when killing the host triggers a nonzero exit", async () => {
    const manager = createManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      hostSpawner: (_cmd, _args, handlers) => {
        let alive = true;
        handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
        return {
          // A killed `devtunnel host` exits nonzero; the exit fires after stop().
          stop: () => {
            if (!alive) return;
            alive = false;
            handlers.onExit(1);
          },
          isAlive: () => alive
        };
      }
    });

    await manager.ensure();
    await manager.close();
    // Let any queued exit callback run.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await manager.status();

    expect(status.running).toBe(false);
    expect(status.state).toBe("stopped");
    expect(status.lastFailure).toBeUndefined();
    expect(status.retry?.paused ?? false).toBe(false);
  });

  test("restarts the host process when the watchdog observes a break", async () => {
    const hostCommands: string[] = [];
    let firstStop: (() => void) | undefined;
    const manager = createManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, args, handlers) => {
        hostCommands.push(args.join(" "));
        handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
        let alive = true;
        const host = { stop: () => { alive = false; }, isAlive: () => alive };
        firstStop ??= () => {
          alive = false;
          handlers.onExit(1);
        };
        return host;
      },
      watchdogMs: 1
    });

    await manager.ensure();
    firstStop?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(hostCommands).toHaveLength(2);
  });

  test("does not treat stale URL as successful host restart and can recover", async () => {
    let breakFirstHost: (() => void) | undefined;
    let hostAttempt = 0;
    const manager = createManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, _args, handlers) => {
        hostAttempt += 1;
        if (hostAttempt === 1) {
          handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
          let alive = true;
          breakFirstHost = () => {
            alive = false;
            handlers.onExit(1);
          };
          return { stop: () => { alive = false; }, isAlive: () => alive };
        }
        if (hostAttempt === 2) {
          handlers.onExit(1);
          return { stop: () => undefined, isAlive: () => false };
        }
        handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
        return { stop: () => undefined, isAlive: () => true };
      }
    });

    await manager.ensure();
    breakFirstHost?.();

    await expectDevtunnelError(manager.ensure());
    await expect(manager.ensure()).resolves.toMatchObject({
      url: "https://climon-test-3131.eun1.devtunnels.ms/",
      running: true
    });
  });

  test("close stops the host process but keeps persisted tunnel metadata for reuse", async () => {
    const commands: string[] = [];
    let stopped = false;
    const manager = createManager({
      port: 3131,
      runner: async (_cmd, args) => {
        commands.push(args.join(" "));
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, args, handlers) => {
        commands.push(args.join(" "));
        handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
        return { stop: () => { stopped = true; }, isAlive: () => true };
      }
    });

    await manager.ensure();
    await manager.close();
    await expect(manager.status()).resolves.toMatchObject({ running: false, url: undefined });
    await manager.ensure();

    expect(stopped).toBe(true);
    expect(commands.filter((cmd) => cmd.startsWith("create"))).toHaveLength(1);
    expect(commands.filter((cmd) => cmd.startsWith("host"))).toHaveLength(2);
  });

  test("recreates and persists replacement after close when reused tunnel is missing", async () => {
    const persistedWrites: Array<{ tunnelId: string; cluster?: string }> = [];
    const cleared: number[] = [];
    let createCount = 0;
    let failReusedTunnel = false;

    const manager = createManager({
      port: 3131,
      onPersistTunnel: (value) => {
        persistedWrites.push(value);
      },
      onClearPersistedTunnel: () => {
        cleared.push(1);
      },
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") {
          createCount += 1;
          if (createCount === 1) {
            return {
              status: 0,
              stdout: JSON.stringify({ tunnelId: "reused-tunnel", clusterId: "eun1" }),
              stderr: ""
            };
          }
          return {
            status: 0,
            stdout: JSON.stringify({ tunnelId: "replacement-tunnel", clusterId: "use1" }),
            stderr: ""
          };
        }
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected runner command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, args, handlers) => {
        let alive = true;
        if (args[0] === "host" && args[1] === "reused-tunnel" && failReusedTunnel) {
          handlers.onStderr("Tunnel reused-tunnel not found");
          alive = false;
          handlers.onExit(1);
          return { stop: () => undefined, isAlive: () => alive };
        }
        if (args[0] === "host" && args[1] === "replacement-tunnel") {
          handlers.onStdout("Ready: https://replacement-tunnel-3131.use1.devtunnels.ms/");
        } else {
          handlers.onStdout("Ready: https://reused-tunnel-3131.eun1.devtunnels.ms/");
        }
        return {
          // A killed host exits nonzero after stop(), matching the real spawner.
          stop: () => {
            if (!alive) return;
            alive = false;
            handlers.onExit(1);
          },
          isAlive: () => alive
        };
      }
    });

    await manager.ensure();
    await manager.close();
    failReusedTunnel = true;

    await expect(manager.ensure()).resolves.toMatchObject({
      url: "https://replacement-tunnel-3131.use1.devtunnels.ms/",
      running: true
    });

    expect(cleared).toHaveLength(1);
    expect(persistedWrites).toContainEqual({ tunnelId: "replacement-tunnel", cluster: "use1" });
  });

  test("close does not permanently disable watchdog restarts", async () => {
    let latestBreak: (() => void) | undefined;
    let hostCount = 0;
    const manager = createManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, _args, handlers) => {
        hostCount += 1;
        handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
        let alive = true;
        latestBreak = () => {
          alive = false;
          handlers.onExit(1);
        };
        return { stop: () => { alive = false; }, isAlive: () => alive };
      },
      watchdogMs: 1
    });
    await manager.ensure();
    await manager.close();
    await manager.ensure();
    latestBreak?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(hostCount).toBe(3);
  });

  test("reports the live dashboard port even when host output lists a stale port first", async () => {
    const manager = createManager({
      port: 39997,
      persisted: { tunnelId: "climon-test", cluster: "eun1" },
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected runner command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, _args, handlers) => {
        // `devtunnel host` prints a browser URL for every mapped port; a stale
        // one (no local listener) can come first and must not be reported.
        handlers.onStdout(
          "Hosting port 39999 at https://climon-test-39999.eun1.devtunnels.ms/\n" +
            "Hosting port 39997 at https://climon-test-39997.eun1.devtunnels.ms/\n"
        );
        return { stop: () => undefined, isAlive: () => true };
      }
    });

    await expect(manager.ensure()).resolves.toMatchObject({
      url: "https://climon-test-39997.eun1.devtunnels.ms/",
      running: true
    });
  });

  test("prunes stale port mappings, keeping only the live dashboard port", async () => {
    const portCommands: string[] = [];
    const manager = createManager({
      port: 39997,
      persisted: { tunnelId: "climon-test", cluster: "eun1" },
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
        if (args[0] === "port") {
          portCommands.push(args.join(" "));
          if (args[1] === "list") {
            return {
              status: 0,
              stdout: JSON.stringify({
                ports: [{ portNumber: 39997 }, { portNumber: 39998 }, { portNumber: 39999 }]
              }),
              stderr: ""
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected runner command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, _args, handlers) => {
        handlers.onStdout("Hosting port 39997 at https://climon-test-39997.eun1.devtunnels.ms/\n");
        return { stop: () => undefined, isAlive: () => true };
      }
    });

    await manager.ensure();

    expect(portCommands).toContain("port delete climon-test -p 39998");
    expect(portCommands).toContain("port delete climon-test -p 39999");
    expect(portCommands).not.toContain("port delete climon-test -p 39997");
  });

  const runningRunner: DashboardTunnelRunner = async (_cmd, args) => {
    if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
    if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
    if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
    if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };

  test("enters the retrying state after a transient host exit", async () => {
    let breakHost: (() => void) | undefined;
    const manager = createManager({
      port: 3131,
      watchdogMs: 100000,
      runner: runningRunner,
      hostSpawner: (_cmd, _args, handlers) => {
        handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
        let alive = true;
        breakHost = () => {
          alive = false;
          handlers.onExit(1);
        };
        return { stop: () => { alive = false; }, isAlive: () => alive };
      }
    });

    await manager.ensure();
    breakHost?.();
    const status = await manager.status();

    expect(status.running).toBe(false);
    expect(status.state).toBe("retrying");
    expect(status.retry?.paused).toBe(false);
    expect(status.lastFailure?.code).toBe("process_exited");
    await manager.close();
  });

  test("pauses after an actionable host failure", async () => {
    let breakHost: (() => void) | undefined;
    const manager = createManager({
      port: 3131,
      watchdogMs: 100000,
      runner: runningRunner,
      hostSpawner: (_cmd, _args, handlers) => {
        handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
        let alive = true;
        breakHost = () => {
          alive = false;
          handlers.onStderr("403 Forbidden: does not have access");
          handlers.onExit(1);
        };
        return { stop: () => { alive = false; }, isAlive: () => alive };
      }
    });

    await manager.ensure();
    breakHost?.();
    const status = await manager.status();

    expect(status.state).toBe("paused");
    expect(status.retry?.paused).toBe(true);
    expect(status.lastFailure?.code).toBe("permission_denied");
    await manager.close();
  });

  test("retry() resumes a paused link and re-attempts hosting", async () => {
    let hostAttempt = 0;
    const manager = createManager({
      port: 3131,
      watchdogMs: 100000,
      runner: runningRunner,
      hostSpawner: (_cmd, _args, handlers) => {
        hostAttempt += 1;
        if (hostAttempt === 1) {
          handlers.onStderr("403 Forbidden: does not have access");
          handlers.onExit(1);
          return { stop: () => undefined, isAlive: () => false };
        }
        handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
        return { stop: () => undefined, isAlive: () => true };
      }
    });

    await expectDevtunnelError(manager.ensure(), "permission_denied");
    await expect(manager.status()).resolves.toMatchObject({ state: "paused" });

    const resumed = await manager.retry();
    expect(resumed.running).toBe(true);
    expect(resumed.state).toBe("running");
    expect(resumed.url).toBe("https://climon-test-3131.eun1.devtunnels.ms/");
    await manager.close();
  });

  test("exports the legacy devtunnel auth message for back-compat", () => {
    expect(dashboardTunnelAuthMessage).toContain("devtunnel user login");
  });
});


describe("parseTunnelExpiry", () => {
  const verboseOutput = [
    "MSAL: Access token is not expired. Returning the found cache entry. [Current time (06/21/2026 19:50:17) - Expiration Time (06/22/2026 03:50:04 +00:00)]",
    "HTTP: GET https://eun1.rel.tunnels.api.visualstudio.com/tunnels/swift-lake-21d3cf3?includePorts=true",
    "HTTP: 200 OK (291 ms)",
    "HTTP: {",
    '  "clusterId": "eun1",',
    '  "tunnelId": "swift-lake-21d3cf3",',
    '  "ports": [],',
    '  "created": "2026-06-20T15:30:07.070058Z",',
    '  "expiration": "2026-07-21T19:50:20Z"',
    "}",
    "{",
    '  "tunnel": {',
    '    "tunnelId": "swift-lake-21d3cf3.eun1",',
    '    "tunnelExpiration": "30 days"',
    "  }",
    "}"
  ].join("\n");

  test("extracts the absolute expiration timestamp from verbose output", () => {
    expect(parseTunnelExpiry(verboseOutput)).toBe("2026-07-21T19:50:20Z");
  });

  test("ignores the relative tunnelExpiration field", () => {
    expect(parseTunnelExpiry('{"tunnelExpiration": "30 days"}')).toBeUndefined();
  });

  test("skips an expiration whose value is not a timestamp", () => {
    expect(parseTunnelExpiry('{"expiration": "unknown"}')).toBeUndefined();
  });

  test("skips a non-timestamp expiration in favour of the real one", () => {
    const output = [
      'LOG: {"expiration": "never"}',
      'HTTP: {"expiration": "2026-07-21T19:50:20Z"}'
    ].join("\n");
    expect(parseTunnelExpiry(output)).toBe("2026-07-21T19:50:20Z");
  });

  test("accepts a timestamp with fractional seconds and offset", () => {
    expect(parseTunnelExpiry('{"expiration": "2026-07-21T19:50:20.123+00:00"}')).toBe(
      "2026-07-21T19:50:20.123+00:00"
    );
  });

  test("returns undefined when no expiration is present", () => {
    expect(parseTunnelExpiry("MSAL: noise only\nHTTP: 200 OK")).toBeUndefined();
  });
});

describe("dashboard tunnel status expiry", () => {
  function expiryRunner(commands: string[]): DashboardTunnelRunner {
    return async (_cmd, args) => {
      commands.push(args.join(" "));
      if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
      if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
      if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test.eun1" }), stderr: "" };
      if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "show") return { status: 0, stdout: '{ "expiration": "2026-07-21T19:50:20Z" }', stderr: "" };
      throw new Error(`unexpected runner command: ${args.join(" ")}`);
    };
  }

  test("includes expiresAt once the tunnel is running", async () => {
    const commands: string[] = [];
    const manager = createManager({
      port: 3131,
      runner: expiryRunner(commands),
      hostSpawner: (_cmd, _args, handlers) => {
        handlers.onStdout("Ready: https://climon-test-3131.eun1.devtunnels.ms/");
        return { stop: () => undefined, isAlive: () => true };
      }
    });

    await manager.ensure();
    await expect(manager.status()).resolves.toMatchObject({
      running: true,
      expiresAt: "2026-07-21T19:50:20Z"
    });
    expect(commands.some((cmd) => cmd.startsWith("show climon-test.eun1 -v -j"))).toBe(true);
  });

  test("omits expiresAt when the tunnel is not running", async () => {
    const commands: string[] = [];
    const manager = createManager({ port: 3131, runner: expiryRunner(commands) });
    const status = await manager.status();
    expect(status.running).toBe(false);
    expect(status.expiresAt).toBeUndefined();
    expect(commands.some((cmd) => cmd.startsWith("show"))).toBe(false);
  });
});

describe("dashboard tunnel expiry cache reset", () => {
  test("refetches expiry after the tunnel identity is reset (missing-port recreation)", async () => {
    let portCreateCalls = 0;
    let showCalls = 0;
    const expirations = ["2026-07-21T19:50:20Z", "2026-08-21T10:00:00Z"];
    const runner: DashboardTunnelRunner = async (_cmd, args) => {
      if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
      if (args[0] === "user") return { status: 0, stdout: JSON.stringify({ status: "Logged in as tester" }), stderr: "" };
      if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "saved-tunnel.eun1" }), stderr: "" };
      if (args[0] === "port" && args[1] === "create") {
        portCreateCalls += 1;
        // The second port-create reports the tunnel is gone, forcing forgetTunnel + recreate.
        if (portCreateCalls === 2) return { status: 1, stdout: "", stderr: "tunnel not found" };
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "delete") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "show") {
        const value = expirations[Math.min(showCalls, expirations.length - 1)];
        showCalls += 1;
        return { status: 0, stdout: `{ "expiration": "${value}" }`, stderr: "" };
      }
      throw new Error(`unexpected runner command: ${args.join(" ")}`);
    };
    const manager = createManager({
      port: 3131,
      persisted: { tunnelId: "saved-tunnel.eun1", cluster: "eun1" },
      runner,
      hostSpawner: (_cmd, _args, handlers) => {
        handlers.onStdout("Ready: https://saved-tunnel-3131.eun1.devtunnels.ms/");
        return { stop: () => undefined, isAlive: () => true };
      }
    });

    await manager.ensure();
    // Cache the first tunnel's expiry.
    await expect(manager.status()).resolves.toMatchObject({ expiresAt: expirations[0] });

    // Drop the live host (the persisted tunnel id is retained), then re-ensure. The next
    // port-create reports the tunnel is gone, so the manager forgets the old id and creates
    // a replacement — which must invalidate the cached expiry so status() refetches it.
    await manager.close();
    await manager.ensure();

    await expect(manager.status()).resolves.toMatchObject({ expiresAt: expirations[1] });
  });
});
