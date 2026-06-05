import { describe, expect, test } from "bun:test";
import {
  buildDashboardTunnelUrl,
  createDashboardTunnelManager,
  dashboardTunnelAuthMessage,
  parseDashboardTunnelUrl,
  type DashboardTunnelRunner
} from "../src/server/dashboard-tunnel.js";

describe("parseDashboardTunnelUrl", () => {
  test("extracts the dashboard URL from devtunnel host output", () => {
    expect(
      parseDashboardTunnelUrl("Hosting port 3131 at https://climon-test-3131.eun1.devtunnels.ms/")
    ).toBe("https://climon-test-3131.eun1.devtunnels.ms/");
  });
});

describe("buildDashboardTunnelUrl", () => {
  test("builds the browser URL from tunnel id, port, and cluster", () => {
    expect(buildDashboardTunnelUrl("climon-test", 3131, "eun1")).toBe(
      "https://climon-test-3131.eun1.devtunnels.ms/"
    );
  });
});

describe("createDashboardTunnelManager", () => {
  test("reports unavailable when the devtunnel CLI cannot run", async () => {
    const manager = createDashboardTunnelManager({
      port: 3131,
      runner: async () => ({ status: 127, stdout: "", stderr: "missing" })
    });

    await expect(manager.status()).resolves.toMatchObject({
      devtunnelAvailable: false,
      authenticated: false,
      running: false
    });
  });

  test("asks the user to run devtunnel login user before hosting", async () => {
    const manager = createDashboardTunnelManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 1, stdout: "", stderr: "not logged in" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    });

    await expect(manager.ensure()).rejects.toThrow(dashboardTunnelAuthMessage);
  });

  test("treats devtunnel user show Not logged in JSON as unauthenticated", async () => {
    const manager = createDashboardTunnelManager({
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
    await expect(manager.ensure()).rejects.toThrow(dashboardTunnelAuthMessage);
  });

  test("reports a controlled startup error if the host exits before a URL is available", async () => {
    const manager = createDashboardTunnelManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: "{}\n", stderr: "" };
        if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
        if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
      hostSpawner: (_cmd, _args, handlers) => {
        handlers.onExit(1);
        return { stop: () => undefined, isAlive: () => false };
      }
    });

    await expect(manager.ensure()).rejects.toThrow("Could not determine dashboard tunnel URL");
  });

  test("creates a tunnel once and reuses it on subsequent ensure calls", async () => {
    const commands: string[] = [];
    const runner: DashboardTunnelRunner = async (_cmd, args) => {
      commands.push(args.join(" "));
      if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
      if (args[0] === "user") return { status: 0, stdout: "{}\n", stderr: "" };
      if (args[0] === "create") return { status: 0, stdout: JSON.stringify({ tunnelId: "climon-test" }), stderr: "" };
      if (args[0] === "port") return { status: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected runner command: ${args.join(" ")}`);
    };
    const manager = createDashboardTunnelManager({
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
      running: true
    });

    expect(commands.filter((cmd) => cmd.startsWith("create"))).toHaveLength(1);
    expect(commands.filter((cmd) => cmd.startsWith("host"))).toHaveLength(1);
  });

  test("uses persisted tunnel id without creating a new tunnel", async () => {
    const commands: string[] = [];
    const manager = createDashboardTunnelManager({
      port: 3131,
      persisted: { tunnelId: "saved-tunnel", cluster: "eun1" },
      runner: async (_cmd, args) => {
        commands.push(args.join(" "));
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: "{}\n", stderr: "" };
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

  test("recreates and persists replacement when persisted tunnel no longer exists", async () => {
    const persistedWrites: Array<{ tunnelId: string; cluster?: string }> = [];
    const cleared: number[] = [];
    let firstHost = true;
    const manager = createDashboardTunnelManager({
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
        if (args[0] === "user") return { status: 0, stdout: "{}\n", stderr: "" };
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

  test("hosts the existing tunnel without passing port args after creating the port", async () => {
    const hostCommands: string[] = [];
    const manager = createDashboardTunnelManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: "{}\n", stderr: "" };
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
    const manager = createDashboardTunnelManager({
      port: 3131,
      runner: async (_cmd, args) => {
        runnerCommands.push(args.join(" "));
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: "{}\n", stderr: "" };
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

  test("restarts the host process when the watchdog observes a break", async () => {
    const hostCommands: string[] = [];
    let firstStop: (() => void) | undefined;
    const manager = createDashboardTunnelManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: "{}\n", stderr: "" };
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

  test("close stops the host process but keeps persisted tunnel metadata for reuse", async () => {
    const commands: string[] = [];
    let stopped = false;
    const manager = createDashboardTunnelManager({
      port: 3131,
      runner: async (_cmd, args) => {
        commands.push(args.join(" "));
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: "{}\n", stderr: "" };
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

  test("close does not permanently disable watchdog restarts", async () => {
    let latestBreak: (() => void) | undefined;
    let hostCount = 0;
    const manager = createDashboardTunnelManager({
      port: 3131,
      runner: async (_cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
        if (args[0] === "user") return { status: 0, stdout: "{}\n", stderr: "" };
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
});
