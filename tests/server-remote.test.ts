import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { getIngestPidPath } from "../src/remote/ingest.js";
import { isProcessAlive, killProcess } from "../src/process-kill.js";
import { readServerStateFromDir, getServerStatePath, serializeServerState } from "../src/server-state.js";
import { browserResizePayload, computeRemotesActive } from "../src/server/server.js";
import * as serverModule from "../src/server/server.js";
import type { ClimonConfig, SessionMeta } from "../src/types.js";

const { shouldMarkDisconnected, shouldStopIngestForShutdown } = serverModule;

test("remotes are active when wslBridge or remotes flag is enabled", () => {
  expect(computeRemotesActive({} as never)).toBe(false);
  expect(computeRemotesActive({ feature: { wslBridge: "enabled" } } as never)).toBe(true);
  expect(computeRemotesActive({ feature: { remotes: "enabled" } } as never)).toBe(true);
  expect(computeRemotesActive({ feature: { remoteSpawn: "enabled" } } as never)).toBe(false);
});

test("browserResizePayload carries kind and viewerId, not source/mode", () => {
  expect(browserResizePayload({ cols: 100, rows: 40, kind: "dashboard", viewerId: "v1" })).toEqual({
    cols: 100,
    rows: 40,
    kind: "dashboard",
    viewerId: "v1"
  });
  expect(browserResizePayload({ cols: 0, rows: 40 })).toBeNull();
});

describe("buildInterimWslExposureWarning", () => {
  const buildInterimWslExposureWarning = (
    serverModule as typeof serverModule & {
      buildInterimWslExposureWarning?: (input: {
        remotesActive: boolean;
        wslBridgeEnabled: boolean;
        ingestBindHost: string;
      }) => string | undefined;
    }
  ).buildInterimWslExposureWarning;
  const warningFor = (input: {
    remotesActive: boolean;
    wslBridgeEnabled: boolean;
    ingestBindHost: string;
  }) => {
    expect(typeof buildInterimWslExposureWarning).toBe("function");
    return buildInterimWslExposureWarning(input);
  };

  test("warns when remotes are active without WSL bridge on a vEthernet bind", () => {
    const warning = warningFor({
      remotesActive: true,
      wslBridgeEnabled: false,
      ingestBindHost: "172.30.192.1"
    });

    expect(warning).toContain("vEthernet (WSL)");
    expect(warning).toContain("WSL bridge is disabled");
    expect(warning).toMatch(/gate #3|ingest cutover/);
  });

  test("does not warn when WSL bridge is enabled", () => {
    expect(
      warningFor({
        remotesActive: true,
        wslBridgeEnabled: true,
        ingestBindHost: "172.30.192.1"
      })
    ).toBeUndefined();
  });

  test("does not warn for loopback ingest binds", () => {
    for (const ingestBindHost of ["127.0.0.1", "::1", "localhost"]) {
      expect(
        warningFor({
          remotesActive: true,
          wslBridgeEnabled: false,
          ingestBindHost
        })
      ).toBeUndefined();
    }
  });

  test("does not warn when remotes are inactive", () => {
    expect(
      warningFor({
        remotesActive: false,
        wslBridgeEnabled: false,
        ingestBindHost: "172.30.192.1"
      })
    ).toBeUndefined();
  });
});

describe("shouldWatchPeerShutdown", () => {
  const shouldWatchPeerShutdown = (
    serverModule as typeof serverModule & {
      shouldWatchPeerShutdown?: (peerHome: string | undefined, remotesActive: boolean) => boolean;
    }
  ).shouldWatchPeerShutdown;
  const shouldWatch = (peerHome: string | undefined, remotesActive: boolean) => {
    expect(typeof shouldWatchPeerShutdown).toBe("function");
    return shouldWatchPeerShutdown(peerHome, remotesActive);
  };

  test("watches when a peer is configured but this host is not serving remotes", () => {
    expect(shouldWatch("/peer/home", false)).toBe(true);
  });

  test("does not watch when this host is serving remotes", () => {
    expect(shouldWatch("/peer/home", true)).toBe(false);
  });

  test("does not watch when no peer is configured", () => {
    expect(shouldWatch(undefined, false)).toBe(false);
  });
});

describe("buildHealthPayload", () => {
  const buildHealthPayload = (
    serverModule as typeof serverModule & {
      buildHealthPayload?: (input: {
        config: ClimonConfig;
        remotesActive: boolean;
        isLocalRequest: boolean;
        ports: { dashboard: number; ingest?: number };
      }) => Record<string, unknown>;
    }
  ).buildHealthPayload;
  const baseConfig = {
    version: 1 as const,
    server: { host: "127.0.0.1", port: 3131 },
    terminal: { detachPrefix: 28 },
    attention: { idleSeconds: 30 },
    hotKeys: { focusTopSession: "Alt+J" },
    feature: { remotes: "enabled" as const }
  } satisfies ClimonConfig;

  test("includes feature flags on loopback health requests", () => {
    expect(typeof buildHealthPayload).toBe("function");
    const payload = buildHealthPayload({
      config: baseConfig,
      remotesActive: true,
      isLocalRequest: true,
      ports: { dashboard: 3131 }
    });

    expect(payload.features).toEqual(expect.objectContaining({
      remotes: expect.objectContaining({ enabled: true })
    }));
  });

  test("omits feature flags on non-loopback health requests", () => {
    expect(typeof buildHealthPayload).toBe("function");
    const payload = buildHealthPayload({
      config: baseConfig,
      remotesActive: true,
      isLocalRequest: false,
      ports: { dashboard: 3131 }
    });

    expect(payload).not.toHaveProperty("features");
  });
});

describe("isLoopbackHostHeader", () => {
  const isLoopbackHostHeader = (
    serverModule as typeof serverModule & {
      isLoopbackHostHeader?: (host: string | null) => boolean;
    }
  ).isLoopbackHostHeader;
  const check = (host: string | null) => {
    expect(typeof isLoopbackHostHeader).toBe("function");
    return isLoopbackHostHeader(host);
  };

  test("accepts loopback Host headers with and without a port", () => {
    expect(check("127.0.0.1:3131")).toBe(true);
    expect(check("localhost:3131")).toBe(true);
    expect(check("127.0.0.1")).toBe(true);
    expect(check("[::1]:3131")).toBe(true);
  });

  test("rejects a tunnel Host so /health internals stay off the dev tunnel", () => {
    // A browser loading the dashboard over the tunnel still presents a loopback
    // source IP (the local devtunnel connector forwards the request), so the
    // tunnel Host header is the only signal that withholds internal fields.
    expect(check("abc123-3131.uks1.devtunnels.ms")).toBe(false);
    expect(check("192.168.1.50:3131")).toBe(false);
    expect(check(null)).toBe(false);
  });
});

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
  // This test spawns a real detached ingest daemon, which requires the Rust
  // `climon` client binary (via CLIMON_CLIENT_BIN or a built rust/target
  // binary). In a dev checkout with no built binary the daemon cannot start, so
  // skip rather than hanging until the timeout. Build it with `cargo build` in
  // rust/ (or set CLIMON_CLIENT_BIN) to exercise this test.
  const resolveIngestInvocation = (
    serverModule as typeof serverModule & {
      resolveIngestInvocation?: (
        env: NodeJS.ProcessEnv,
        execPath: string
      ) => { file: string; args: string[] };
    }
  ).resolveIngestInvocation;
  const ingestBinaryAvailable = (() => {
    if (!resolveIngestInvocation) return false;
    try {
      const inv = resolveIngestInvocation(process.env, process.execPath);
      // A bare `climon` resolves against PATH at spawn time; an absolute path
      // must exist on disk to be spawnable.
      return inv.file === "climon" || existsSync(inv.file);
    } catch {
      return false;
    }
  })();

  test.skipIf(!ingestBinaryAvailable)("stops the ingest daemon on graceful shutdown even with a peer home configured", async () => {
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
        },
        feature: {
          remotes: "enabled"
        }
      })
    );

    const server = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(dashboardPort)],
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
  test("resolves the Rust client binary with __ingest", () => {
    const resolveIngestInvocation = (
      serverModule as typeof serverModule & {
        resolveIngestInvocation?: (
          env: NodeJS.ProcessEnv,
          execPath: string
        ) => { file: string; args: string[] };
      }
    ).resolveIngestInvocation;

    expect(typeof resolveIngestInvocation).toBe("function");
    expect(
      resolveIngestInvocation?.(
        { CLIMON_CLIENT_BIN: "/opt/climon/climon" } as unknown as NodeJS.ProcessEnv,
        "/usr/bin/bun"
      )
    ).toEqual({ file: "/opt/climon/climon", args: ["__ingest"] });
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
      terminal: { detachPrefix: 28 },
      attention: { idleSeconds: 30 },
      hotKeys: { focusTopSession: "Alt+J" }
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
      terminal: { detachPrefix: 28 },
      attention: { idleSeconds: 30 },
      hotKeys: { focusTopSession: "Alt+J" },
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
      terminal: { detachPrefix: 28 },
      attention: { idleSeconds: 30 },
      hotKeys: { focusTopSession: "Alt+J" }
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
      terminal: { detachPrefix: 28 },
      attention: { idleSeconds: 30 },
      hotKeys: { focusTopSession: "Alt+J" },
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

describe("remote status and tunnel HTTP endpoints", () => {
  const testTmp = join(process.cwd(), ".copilot-tmp");

  interface StartedServer {
    server: Bun.Subprocess;
    base: string;
    home: string;
    stop: () => Promise<void>;
  }

  async function startServer(overrides: {
    env?: Record<string, string>;
    fakeDevtunnel?: boolean;
  } = {}): Promise<StartedServer> {
    mkdirSync(testTmp, { recursive: true });
    const home = mkdtempSync(join(testTmp, "climon-remote-http-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({}));
    const dashboardPort = await freePort();
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CLIMON_HOME: home,
      ...(overrides.env ?? {})
    };
    if (overrides.fakeDevtunnel) {
      const binDir = join(home, "fakebin");
      mkdirSync(binDir, { recursive: true });
      const script = join(binDir, "devtunnel");
      writeFileSync(
        script,
        [
          "#!/bin/sh",
          'case "$1" in',
          '  --version) echo "1.0.0-fake"; exit 0 ;;',
          '  user) echo \'{"status":"Logged in"}\'; exit 0 ;;',
          '  show) echo "Error: tunnel not found" 1>&2; exit 1 ;;',
          '  create) echo "Error: maximum number of tunnels reached" 1>&2; exit 1 ;;',
          '  *) echo "unhandled: $*" 1>&2; exit 1 ;;',
          "esac",
          ""
        ].join("\n")
      );
      chmodSync(script, 0o755);
      env.PATH = `${binDir}:${env.PATH ?? ""}`;
    }
    const server = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(dashboardPort)],
      { cwd: process.cwd(), env, stdout: "ignore", stderr: "ignore" }
    );
    let base = `http://127.0.0.1:${dashboardPort}`;
    await waitFor(async () => {
      const res = await fetch(`${base}/health`).catch(() => undefined);
      if (res?.ok) return true;
      const state = await readServerStateFromDir(home);
      if (!state?.port) return undefined;
      base = `http://127.0.0.1:${state.port}`;
      const actual = await fetch(`${base}/health`).catch(() => undefined);
      return actual?.ok ? true : undefined;
    }, 30_000);
    const stop = async () => {
      const shutdown = await fetch(`${base}/__internal/shutdown`, { method: "POST" }).catch(() => undefined);
      const exited = shutdown?.ok ? await waitForExit(server, 10_000) : false;
      if (!exited) {
        server.kill();
        await waitForExit(server, 2000);
      }
      rmSync(home, { recursive: true, force: true });
    };
    return { server, base, home, stop };
  }

  test("GET /api/remote/status includes gateway devtunnel health", async () => {
    const started = await startServer({ env: { CLIMON_DISABLE_DEVTUNNEL: "1" } });
    try {
      const res = await fetch(`${started.base}/api/remote/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        devtunnelAvailable: boolean;
        devtunnel?: { available: boolean; probedAt?: string };
      };
      expect(body.devtunnel).toBeDefined();
      expect(body.devtunnel?.available).toBe(false);
      expect(typeof body.devtunnel?.probedAt).toBe("string");
      expect(body.devtunnelAvailable).toBe(false);
    } finally {
      await started.stop();
    }
  }, 45_000);

  test("POST /api/remote/tunnel returns a structured quota failure", async () => {
    const started = await startServer({ fakeDevtunnel: true });
    try {
      const headers = {
        "content-type": "application/json",
        origin: started.base
      };
      const create = await fetch(`${started.base}/api/remote/tunnel`, {
        method: "POST",
        headers,
        body: JSON.stringify({ mode: "auto" })
      });
      expect(create.status).toBe(409);
      const createBody = (await create.json()) as { error?: { code?: string } };
      expect(createBody.error?.code).toBe("tunnel_quota_exhausted");

      const retry = await fetch(`${started.base}/api/remote/tunnel/retry`, {
        method: "POST",
        headers,
        body: "{}"
      });
      expect(retry.status).toBe(409);
      const retryBody = (await retry.json()) as { error?: { code?: string } };
      expect(retryBody.error?.code).toBe("tunnel_quota_exhausted");
    } finally {
      await started.stop();
    }
  }, 45_000);

  test("POST /api/remote/tunnel returns a structured failure when devtunnel is unavailable", async () => {
    const started = await startServer({ env: { CLIMON_DISABLE_DEVTUNNEL: "1" } });
    try {
      const res = await fetch(`${started.base}/api/remote/tunnel`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: started.base },
        body: JSON.stringify({ mode: "auto" })
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: { code?: string; summary?: string } };
      expect(body.error?.code).toBe("cli_missing");
      expect(typeof body.error?.summary).toBe("string");
    } finally {
      await started.stop();
    }
  }, 45_000);
});
