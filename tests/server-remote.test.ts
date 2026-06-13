import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getIngestPidPath } from "../src/remote/ingest.js";
import * as serverModule from "../src/server/server.js";
import type { ClimonConfig, SessionMeta } from "../src/types.js";

const { shouldMarkDisconnected } = serverModule;

function meta(over: Partial<SessionMeta>): SessionMeta {
  const now = new Date().toISOString();
  return {
    id: "x",
    command: ["bash"],
    displayCommand: "bash",
    cwd: "/x",
    status: "running",
    priorityReason: "running",
    socketPath: "/tmp/x.sock",
    cols: 80,
    rows: 24,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    ...over
  };
}

describe("shouldMarkDisconnected", () => {
  test("local session with dead daemon and no socket -> disconnected", async () => {
    const probe = async () => false;
    expect(await shouldMarkDisconnected(meta({ origin: "local", daemonPid: undefined }), probe)).toBe(true);
  });

  test("remote sessions are left to ingest liveness without probing their bridge sockets", async () => {
    let probed = false;
    const probe = async () => {
      probed = true;
      return false;
    };
    expect(await shouldMarkDisconnected(meta({ origin: "remote", daemonPid: undefined }), probe)).toBe(false);
    expect(probed).toBe(false);
  });

  test("paused local sessions can be marked disconnected when unreachable", async () => {
    const probeDead = async () => false;
    expect(await shouldMarkDisconnected(meta({ status: "paused", origin: "local" }), probeDead)).toBe(true);
  });

  test("terminated sessions are never touched", async () => {
    const probe = async () => false;
    expect(await shouldMarkDisconnected(meta({ status: "completed" }), probe)).toBe(false);
  });
});

describe("resolveIngestInvocation", () => {
  test("uses the dev server entrypoint when running from source", () => {
    const testTmp = join(process.cwd(), ".copilot-tmp");
    mkdirSync(testTmp, { recursive: true });
    const dir = mkdtempSync(join(testTmp, "climon-ingest-invocation-"));
    const devEntry = join(dir, "server.ts");
    writeFileSync(devEntry, "");

    const resolveIngestInvocation = (
      serverModule as typeof serverModule & {
        resolveIngestInvocation?: (
          env: NodeJS.ProcessEnv,
          execPath: string,
          devEntrypoint?: string
        ) => { file: string; args: string[] };
      }
    ).resolveIngestInvocation;

    expect(typeof resolveIngestInvocation).toBe("function");
    expect(resolveIngestInvocation?.({} as NodeJS.ProcessEnv, "/usr/bin/bun", devEntry)).toEqual({
      file: "/usr/bin/bun",
      args: [devEntry, "__ingest"]
    });
  });
});

describe("handleExistingDashboardServer", () => {
  test("non-interactive launch prints the existing URL and exits", async () => {
    let output = "";
    let stopped = false;
    const handleExistingDashboardServer = (
      serverModule as typeof serverModule & {
        handleExistingDashboardServer?: (
          existing: { url: string; pid?: number },
          options: {
            stdinIsTTY: boolean;
            write: (text: string) => void;
            stopServer: (pid: number) => Promise<boolean>;
          }
        ) => Promise<"continue" | "exit">;
      }
    ).handleExistingDashboardServer;

    expect(typeof handleExistingDashboardServer).toBe("function");
    const action = await handleExistingDashboardServer?.(
      { url: "http://127.0.0.1:3131/", pid: 1234 },
      {
        stdinIsTTY: false,
        write: (text) => {
          output += text;
        },
        stopServer: async () => {
          stopped = true;
          return true;
        }
      }
    );

    expect(action).toBe("exit");
    expect(output).toContain("climon server is already running at http://127.0.0.1:3131/");
    expect(stopped).toBe(false);
  });

  test("interactive launch terminates the existing server when confirmed", async () => {
    const stopped: number[] = [];
    const handleExistingDashboardServer = (
      serverModule as typeof serverModule & {
        handleExistingDashboardServer?: (
          existing: { url: string; pid?: number },
          options: {
            stdinIsTTY: boolean;
            write: (text: string) => void;
            ask: (question: string) => Promise<string>;
            stopServer: (pid: number) => Promise<boolean>;
          }
        ) => Promise<"continue" | "exit">;
      }
    ).handleExistingDashboardServer;

    const action = await handleExistingDashboardServer?.(
      { url: "http://127.0.0.1:3131/", pid: 1234 },
      {
        stdinIsTTY: true,
        write: () => {},
        ask: async () => "y",
        stopServer: async (pid) => {
          stopped.push(pid);
          return true;
        }
      }
    );

    expect(action).toBe("continue");
    expect(stopped).toEqual([1234]);
  });

  test("interactive launch exits when termination is declined", async () => {
    let output = "";
    const handleExistingDashboardServer = (
      serverModule as typeof serverModule & {
        handleExistingDashboardServer?: (
          existing: { url: string; pid?: number },
          options: {
            stdinIsTTY: boolean;
            write: (text: string) => void;
            ask: (question: string) => Promise<string>;
            stopServer: (pid: number) => Promise<boolean>;
          }
        ) => Promise<"continue" | "exit">;
      }
    ).handleExistingDashboardServer;

    const action = await handleExistingDashboardServer?.(
      { url: "http://127.0.0.1:3131/", pid: 1234 },
      {
        stdinIsTTY: true,
        write: (text) => {
          output += text;
        },
        ask: async () => "no",
        stopServer: async () => {
          throw new Error("should not stop");
        }
      }
    );

    expect(action).toBe("exit");
    expect(output).toContain("Existing server left running at http://127.0.0.1:3131/");
  });
  test("interactive launch uses HTTP shutdown when PID is unknown", async () => {
    let output = "";
    let httpShutdownRequested = false;
    const handleExistingDashboardServer = (
      serverModule as typeof serverModule & {
        handleExistingDashboardServer?: (
          existing: { url: string; pid?: number },
          options: {
            stdinIsTTY: boolean;
            write: (text: string) => void;
            ask: (question: string) => Promise<string>;
            stopServer: (pid: number) => Promise<boolean>;
            requestShutdown: (url: string) => Promise<boolean>;
          }
        ) => Promise<"continue" | "exit">;
      }
    ).handleExistingDashboardServer;

    const action = await handleExistingDashboardServer?.(
      { url: "http://127.0.0.1:3131/" },
      {
        stdinIsTTY: true,
        write: (text) => { output += text; },
        ask: async () => "y",
        stopServer: async () => { throw new Error("should not be called without pid"); },
        requestShutdown: async () => { httpShutdownRequested = true; return true; }
      }
    );

    expect(action).toBe("continue");
    expect(httpShutdownRequested).toBe(true);
    expect(output).toContain("terminated");
  });
});

describe("applyDashboardTunnelPersistence", () => {
  test("persist creates remote config when undefined", () => {
    const applyDashboardTunnelPersistence = (
      serverModule as typeof serverModule & {
        applyDashboardTunnelPersistence?: (
          config: import("../src/types.js").ClimonConfig,
          action:
            | { type: "persist"; tunnelId: string; cluster?: string }
            | { type: "clear" }
        ) => void;
      }
    ).applyDashboardTunnelPersistence;

    expect(typeof applyDashboardTunnelPersistence).toBe("function");
    const config: ClimonConfig = {
      version: 1 as const,
      server: { host: "127.0.0.1", port: 3131 },
      terminal: { clampBrowserToHost: true, detachPrefix: 28, setTitle: true },
      attention: { idleSeconds: 30 }
    };

    applyDashboardTunnelPersistence?.(config, { type: "persist", tunnelId: "tunnel-1", cluster: "eun1" });

    expect(config.remote).toEqual({
      dashboardTunnelId: "tunnel-1",
      dashboardTunnelCluster: "eun1"
    });
  });

  test("persist preserves unrelated remote config keys", () => {
    const applyDashboardTunnelPersistence = (
      serverModule as typeof serverModule & {
        applyDashboardTunnelPersistence?: (
          config: import("../src/types.js").ClimonConfig,
          action:
            | { type: "persist"; tunnelId: string; cluster?: string }
            | { type: "clear" }
        ) => void;
      }
    ).applyDashboardTunnelPersistence;

    const config: ClimonConfig = {
      version: 1 as const,
      server: { host: "127.0.0.1", port: 3131 },
      terminal: { clampBrowserToHost: true, detachPrefix: 28, setTitle: true },
      attention: { idleSeconds: 30 },
      remote: { enabled: true, tunnelId: "uplink", ingestHost: "localhost" }
    };

    applyDashboardTunnelPersistence?.(config, { type: "persist", tunnelId: "dashboard-1", cluster: "use1" });

    expect(config.remote).toEqual({
      enabled: true,
      tunnelId: "uplink",
      ingestHost: "localhost",
      dashboardTunnelId: "dashboard-1",
      dashboardTunnelCluster: "use1"
    });
  });

  test("clear is a no-op when remote config is undefined", () => {
    const applyDashboardTunnelPersistence = (
      serverModule as typeof serverModule & {
        applyDashboardTunnelPersistence?: (
          config: import("../src/types.js").ClimonConfig,
          action:
            | { type: "persist"; tunnelId: string; cluster?: string }
            | { type: "clear" }
        ) => void;
      }
    ).applyDashboardTunnelPersistence;

    const config: ClimonConfig = {
      version: 1 as const,
      server: { host: "127.0.0.1", port: 3131 },
      terminal: { clampBrowserToHost: true, detachPrefix: 28, setTitle: true },
      attention: { idleSeconds: 30 }
    };

    applyDashboardTunnelPersistence?.(config, { type: "clear" });

    expect(config.remote).toBeUndefined();
  });

  test("clear removes only dashboard tunnel keys", () => {
    const applyDashboardTunnelPersistence = (
      serverModule as typeof serverModule & {
        applyDashboardTunnelPersistence?: (
          config: import("../src/types.js").ClimonConfig,
          action:
            | { type: "persist"; tunnelId: string; cluster?: string }
            | { type: "clear" }
        ) => void;
      }
    ).applyDashboardTunnelPersistence;

    const config: ClimonConfig = {
      version: 1 as const,
      server: { host: "127.0.0.1", port: 3131 },
      terminal: { clampBrowserToHost: true, detachPrefix: 28, setTitle: true },
      attention: { idleSeconds: 30 },
      remote: {
        enabled: true,
        tunnelId: "uplink",
        dashboardTunnelId: "dashboard-1",
        dashboardTunnelCluster: "use1"
      }
    };

    applyDashboardTunnelPersistence?.(config, { type: "clear" });

    expect(config.remote).toEqual({
      enabled: true,
      tunnelId: "uplink"
    });
  });
});

describe("stopIngestDaemon", () => {
  test("sends a graceful stop to the pid recorded by the ingest daemon", async () => {
    const testTmp = join(process.cwd(), ".copilot-tmp");
    mkdirSync(testTmp, { recursive: true });
    const home = mkdtempSync(join(testTmp, "climon-server-remote-"));
    try {
      const env = { CLIMON_HOME: home };
      writeFileSync(getIngestPidPath(env), "1234\n");
      const kills: Array<[number, boolean]> = [];
      let alive = true;
      const stopIngestDaemon = (
        serverModule as typeof serverModule & {
          stopIngestDaemon?: (options: {
            env: NodeJS.ProcessEnv;
            killProcess: (pid: number, force: boolean) => boolean;
            isProcessAlive: (pid: number) => boolean;
          }) => Promise<boolean>;
        }
      ).stopIngestDaemon;

      expect(typeof stopIngestDaemon).toBe("function");
      const stopped = await stopIngestDaemon?.({
        env,
        killProcess: (pid, force) => {
          kills.push([pid, force]);
          alive = false;
          return true;
        },
        isProcessAlive: () => alive
      });

      expect(stopped).toBe(true);
      expect(kills).toEqual([[1234, false]]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("waits for the ingest process to exit before returning", async () => {
    const testTmp = join(process.cwd(), ".copilot-tmp");
    mkdirSync(testTmp, { recursive: true });
    const home = mkdtempSync(join(testTmp, "climon-server-remote-"));
    try {
      const env = { CLIMON_HOME: home };
      writeFileSync(getIngestPidPath(env), "1234\n");
      let checks = 0;
      const stopIngestDaemon = (
        serverModule as typeof serverModule & {
          stopIngestDaemon?: (options: {
            env: NodeJS.ProcessEnv;
            killProcess: (pid: number, force: boolean) => boolean;
            isProcessAlive: (pid: number) => boolean;
            graceMs?: number;
            pollMs?: number;
          }) => Promise<boolean>;
        }
      ).stopIngestDaemon;

      const stopped = await stopIngestDaemon?.({
        env,
        killProcess: () => true,
        isProcessAlive: () => {
          checks += 1;
          return checks < 3;
        },
        graceMs: 100,
        pollMs: 1
      });

      expect(stopped).toBe(true);
      expect(checks).toBe(3);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("forces the ingest process when graceful stop times out", async () => {
    const testTmp = join(process.cwd(), ".copilot-tmp");
    mkdirSync(testTmp, { recursive: true });
    const home = mkdtempSync(join(testTmp, "climon-server-remote-"));
    try {
      const env = { CLIMON_HOME: home };
      writeFileSync(getIngestPidPath(env), "1234\n");
      const kills: Array<[number, boolean]> = [];
      let alive = true;
      const stopIngestDaemon = (
        serverModule as typeof serverModule & {
          stopIngestDaemon?: (options: {
            env: NodeJS.ProcessEnv;
            killProcess: (pid: number, force: boolean) => boolean;
            isProcessAlive: (pid: number) => boolean;
            graceMs?: number;
            pollMs?: number;
          }) => Promise<boolean>;
        }
      ).stopIngestDaemon;

      const stopped = await stopIngestDaemon?.({
        env,
        killProcess: (pid, force) => {
          kills.push([pid, force]);
          if (force) alive = false;
          return true;
        },
        isProcessAlive: () => alive,
        graceMs: 1,
        pollMs: 1
      });

      expect(stopped).toBe(true);
      expect(kills).toEqual([
        [1234, false],
        [1234, true]
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("escalates to a forced kill when the graceful stop cannot be issued (Windows console process)", async () => {
    const testTmp = join(process.cwd(), ".copilot-tmp");
    mkdirSync(testTmp, { recursive: true });
    const home = mkdtempSync(join(testTmp, "climon-server-remote-"));
    try {
      const env = { CLIMON_HOME: home };
      writeFileSync(getIngestPidPath(env), "1234\n");
      const kills: Array<[number, boolean]> = [];
      let alive = true;
      const stopIngestDaemon = (
        serverModule as typeof serverModule & {
          stopIngestDaemon?: (options: {
            env: NodeJS.ProcessEnv;
            killProcess: (pid: number, force: boolean) => boolean;
            isProcessAlive: (pid: number) => boolean;
            graceMs?: number;
            pollMs?: number;
          }) => Promise<boolean>;
        }
      ).stopIngestDaemon;

      const stopped = await stopIngestDaemon?.({
        env,
        // Mirrors Windows `taskkill` without /F on a windowless console
        // process: the graceful kill reports failure, but the forced kill works.
        killProcess: (pid, force) => {
          kills.push([pid, force]);
          if (!force) return false;
          alive = false;
          return true;
        },
        isProcessAlive: () => alive,
        graceMs: 1000,
        pollMs: 1
      });

      expect(stopped).toBe(true);
      // The graceful attempt is made and reported failed, then escalated to
      // force WITHOUT waiting out the full grace window.
      expect(kills).toEqual([
        [1234, false],
        [1234, true]
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
