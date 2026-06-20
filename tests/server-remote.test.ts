import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { getIngestPidPath } from "../src/remote/ingest.js";
import { isProcessAlive, killProcess } from "../src/process-kill.js";
import { readServerStateFromDir, getServerStatePath, serializeServerState } from "../src/server-state.js";
import * as serverModule from "../src/server/server.js";
import type { ClimonConfig, SessionMeta } from "../src/types.js";

const { shouldMarkDisconnected, shouldStopIngestForShutdown } = serverModule;

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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 20000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Bound each attempt so a hung probe cannot block the loop past the deadline.
    const value = await Promise.race([
      Promise.resolve().then(fn).catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(resolve, 1000, undefined))
    ]);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

async function waitForExit(proc: Bun.Subprocess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(false);
    }, ms);
    void proc.exited.finally(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function readPid(path: string): Promise<number | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function stopPid(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  killProcess(pid, false);
  const stopped = await waitFor(() => (!isProcessAlive(pid) ? true : undefined), 3000).catch(() => false);
  if (!stopped) {
    killProcess(pid, true);
  }
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

describe("shouldStopIngestForShutdown", () => {
  test("stops ingest on ordinary shutdown requests", () => {
    expect(shouldStopIngestForShutdown(null)).toBe(true);
    expect(shouldStopIngestForShutdown("cleanup")).toBe(true);
  });

  test("lets ingest finish its own demotion shutdown path", () => {
    expect(shouldStopIngestForShutdown("ingest-demotion")).toBe(false);
  });
});

describe("server shutdown ingest lifecycle", () => {
  test("stops the ingest daemon on graceful shutdown even with a peer home configured", async () => {
    const testTmp = join(process.cwd(), ".copilot-tmp");
    mkdirSync(testTmp, { recursive: true });
    const home = mkdtempSync(join(testTmp, "climon-server-shutdown-"));
    const peerHome = mkdtempSync(join(testTmp, "climon-server-shutdown-peer-"));
    const dashboardPort = await freePort();
    const ingestPort = await freePort();
    const env = { ...process.env, CLIMON_HOME: home };
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        remote: {
          peerHome,
          ingestHost: "127.0.0.1",
          port: ingestPort,
          ingestPortRetryAttempts: 5
        }
      })
    );

    const server = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(dashboardPort), "--enable-remotes"],
      { cwd: process.cwd(), env, stdout: "ignore", stderr: "ignore" }
    );
    let serverExited = false;
    let ingestPid: number | undefined;
    let base = `http://127.0.0.1:${dashboardPort}`;
    try {
      await waitFor(async () => {
        const res = await fetch(`${base}/health`).catch(() => undefined);
        if (res?.ok) return true;
        const state = await readServerStateFromDir(home);
        if (!state?.port) return undefined;
        base = `http://127.0.0.1:${state.port}`;
        const actual = await fetch(`${base}/health`).catch(() => undefined);
        return actual?.ok ? true : undefined;
      }, 30_000);
      ingestPid = await waitFor(() => readPid(getIngestPidPath(env)), 10_000);
      expect(isProcessAlive(ingestPid)).toBe(true);

      const shutdown = await fetch(`${base}/__internal/shutdown`, { method: "POST" });
      expect(shutdown.ok).toBe(true);
      serverExited = await waitForExit(server, 10_000);
      expect(serverExited).toBe(true);
      await waitFor(() => (ingestPid && !isProcessAlive(ingestPid) ? true : undefined), 10_000);
      expect(isProcessAlive(ingestPid)).toBe(false);
    } finally {
      if (!serverExited) {
        server.kill();
        await waitForExit(server, 2000);
      }
      if (ingestPid) {
        await stopPid(ingestPid);
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(peerHome, { recursive: true, force: true });
    }
  }, 45_000);
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
      attention: { idleSeconds: 30 },
      hotKeys: { focusTopSession: "Alt+T" }
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
      hotKeys: { focusTopSession: "Alt+T" },
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
      attention: { idleSeconds: 30 },
      hotKeys: { focusTopSession: "Alt+T" }
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
      hotKeys: { focusTopSession: "Alt+T" },
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

describe("stopDashboardServer", () => {
  test("also stops the co-located ingest daemon", async () => {
    const testTmp = join(process.cwd(), ".copilot-tmp");
    mkdirSync(testTmp, { recursive: true });
    const home = mkdtempSync(join(testTmp, "climon-server-remote-"));
    try {
      const env = { CLIMON_HOME: home };
      writeFileSync(getServerStatePath(env), serializeServerState({ pid: 4321, port: 3131 }));
      const kills: Array<[number, boolean]> = [];
      let serverAlive = true;
      let ingestStopCalled = false;

      const stopDashboardServer = (
        serverModule as typeof serverModule & {
          stopDashboardServer?: (options: {
            env: NodeJS.ProcessEnv;
            killProcess: (pid: number, force: boolean) => boolean;
            isProcessAlive: (pid: number) => boolean;
            graceMs?: number;
            pollMs?: number;
            stopIngest?: (options?: unknown) => Promise<boolean>;
          }) => Promise<boolean>;
        }
      ).stopDashboardServer;

      expect(typeof stopDashboardServer).toBe("function");
      const stopped = await stopDashboardServer?.({
        env,
        killProcess: (pid, force) => {
          kills.push([pid, force]);
          serverAlive = false;
          return true;
        },
        isProcessAlive: () => serverAlive,
        stopIngest: async () => {
          ingestStopCalled = true;
          return true;
        }
      });

      expect(stopped).toBe(true);
      expect(kills).toEqual([[4321, false]]);
      expect(ingestStopCalled).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("stops an orphaned ingest even when no server is running", async () => {
    const testTmp = join(process.cwd(), ".copilot-tmp");
    mkdirSync(testTmp, { recursive: true });
    const home = mkdtempSync(join(testTmp, "climon-server-remote-"));
    try {
      const env = { CLIMON_HOME: home };
      // No server.json present → server pid is undefined.
      let ingestStopCalled = false;

      const stopDashboardServer = (
        serverModule as typeof serverModule & {
          stopDashboardServer?: (options: {
            env: NodeJS.ProcessEnv;
            killProcess: (pid: number, force: boolean) => boolean;
            isProcessAlive: (pid: number) => boolean;
            stopIngest?: (options?: unknown) => Promise<boolean>;
          }) => Promise<boolean>;
        }
      ).stopDashboardServer;

      const stopped = await stopDashboardServer?.({
        env,
        killProcess: () => true,
        isProcessAlive: () => false,
        stopIngest: async () => {
          ingestStopCalled = true;
          return true;
        }
      });

      // No server was stopped, but the ingest cleanup still ran.
      expect(stopped).toBe(false);
      expect(ingestStopCalled).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("applyDashboardTunnelEnabled", () => {
  test("records the enabled flag on the remote config", () => {
    const applyDashboardTunnelEnabled = (
      serverModule as typeof serverModule & {
        applyDashboardTunnelEnabled?: (config: ClimonConfig, enabled: boolean) => void;
      }
    ).applyDashboardTunnelEnabled;

    expect(typeof applyDashboardTunnelEnabled).toBe("function");
    const config = { server: { host: "127.0.0.1", port: 3131 } } as unknown as ClimonConfig;
    applyDashboardTunnelEnabled?.(config, true);
    expect(config.remote?.dashboardTunnelEnabled).toBe(true);
    applyDashboardTunnelEnabled?.(config, false);
    expect(config.remote?.dashboardTunnelEnabled).toBe(false);
  });

  test("preserves existing dashboard tunnel identity when toggling enabled", () => {
    const applyDashboardTunnelEnabled = (
      serverModule as typeof serverModule & {
        applyDashboardTunnelEnabled?: (config: ClimonConfig, enabled: boolean) => void;
      }
    ).applyDashboardTunnelEnabled;

    const config = {
      server: { host: "127.0.0.1", port: 3131 },
      remote: { dashboardTunnelId: "happy-tree-abc123", dashboardTunnelCluster: "eun1" }
    } as unknown as ClimonConfig;
    applyDashboardTunnelEnabled?.(config, true);
    expect(config.remote?.dashboardTunnelId).toBe("happy-tree-abc123");
    expect(config.remote?.dashboardTunnelCluster).toBe("eun1");
    expect(config.remote?.dashboardTunnelEnabled).toBe(true);
  });
});
