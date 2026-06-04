import { spawn } from "node:child_process";
import { devtunnelEnv, type Runner, type RunResult } from "../remote/tunnel.js";

export type DashboardTunnelRunner = Runner;

export const dashboardTunnelAuthMessage =
  "Dev tunnels is not authenticated. Run `devtunnel login user` and try again.";

export interface DashboardTunnelStatus {
  devtunnelAvailable: boolean;
  authenticated: boolean;
  running: boolean;
  url?: string;
  version?: string;
}

export interface DashboardTunnelInfo extends DashboardTunnelStatus {
  devtunnelAvailable: true;
  authenticated: true;
  running: true;
  url: string;
}

interface HostHandlers {
  onStdout: (text: string) => void;
  onStderr: (text: string) => void;
  onExit: (code: number | null) => void;
}

interface HostProcess {
  stop: () => void;
  isAlive: () => boolean;
}

type HostSpawner = (cmd: string, args: string[], handlers: HostHandlers) => HostProcess;

interface DashboardTunnelManagerOptions {
  port: number;
  runner?: DashboardTunnelRunner;
  hostSpawner?: HostSpawner;
  watchdogMs?: number;
}

export interface DashboardTunnelManager {
  status: () => Promise<DashboardTunnelStatus>;
  ensure: () => Promise<DashboardTunnelInfo>;
  close: () => Promise<void>;
}

const HOST_URL_TIMEOUT_MS = 5000;

const defaultRunner: DashboardTunnelRunner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: cmd === "devtunnel" ? devtunnelEnv() : process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", () => resolve({ status: 127, stdout, stderr: "spawn failed" }));
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });

const defaultHostSpawner: HostSpawner = (cmd, args, handlers) => {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: cmd === "devtunnel" ? devtunnelEnv() : process.env
  });
  let alive = true;
  child.stdout.on("data", (b: Buffer) => handlers.onStdout(b.toString("utf8")));
  child.stderr.on("data", (b: Buffer) => handlers.onStderr(b.toString("utf8")));
  child.on("error", () => {
    alive = false;
    handlers.onExit(127);
  });
  child.on("close", (code) => {
    alive = false;
    handlers.onExit(code);
  });
  return {
    stop: () => {
      if (alive) {
        child.kill("SIGTERM");
      }
    },
    isAlive: () => alive
  };
};

export function parseDashboardTunnelUrl(output: string): string | undefined {
  return output.match(/https:\/\/[a-z0-9][a-z0-9-]*-\d+\.[^\s/]+\.devtunnels\.ms\/?/i)?.[0];
}

export function buildDashboardTunnelUrl(tunnelId: string, port: number, cluster: string): string {
  return `https://${tunnelId}-${port}.${cluster}.devtunnels.ms/`;
}

function parseTunnelCreate(stdout: string): { tunnelId?: string; cluster?: string } {
  try {
    const obj = JSON.parse(stdout) as {
      tunnelId?: string;
      clusterId?: string;
      cluster?: string;
      tunnel?: { tunnelId?: string; clusterId?: string; cluster?: string };
    };
    return {
      tunnelId: obj.tunnelId ?? obj.tunnel?.tunnelId,
      cluster: obj.clusterId ?? obj.cluster ?? obj.tunnel?.clusterId ?? obj.tunnel?.cluster
    };
  } catch {
    return { tunnelId: stdout.match(/\b([a-z0-9][a-z0-9-]{1,47}[a-z0-9])\b/i)?.[1] };
  }
}

function ensureOk(result: RunResult, label: string): void {
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr.trim() || result.status}`);
  }
}

function isAuthenticatedUserOutput(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return true;
  try {
    const obj = JSON.parse(trimmed) as { status?: unknown; username?: unknown; user?: unknown };
    const status = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
    if (status.includes("not logged in") || status.includes("not authenticated")) {
      return false;
    }
    return Boolean(obj.username || obj.user || !obj.status);
  } catch {
    return !/not\s+logged\s+in|not\s+authenticated/i.test(trimmed);
  }
}

export function createDashboardTunnelManager(options: DashboardTunnelManagerOptions): DashboardTunnelManager {
  const runner = options.runner ?? defaultRunner;
  const hostSpawner = options.hostSpawner ?? defaultHostSpawner;
  const watchdogMs = options.watchdogMs ?? 5000;
  let tunnelId: string | undefined;
  let cluster: string | undefined;
  let url: string | undefined;
  let host: HostProcess | undefined;
  let closing = false;
  let starting: Promise<DashboardTunnelInfo> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;

  async function detect(): Promise<{ devtunnelAvailable: boolean; authenticated: boolean; version?: string }> {
    const version = await runner("devtunnel", ["--version"]);
    if (version.status !== 0) {
      return { devtunnelAvailable: false, authenticated: false };
    }
    const user = await runner("devtunnel", ["user", "show", "--json"]);
    return {
      devtunnelAvailable: true,
      authenticated: user.status === 0 && isAuthenticatedUserOutput(user.stdout),
      version: version.stdout.trim() || undefined
    };
  }

  function isRunning(): boolean {
    return Boolean(host?.isAlive());
  }

  function startWatchdog(): void {
    if (watchdog) return;
    watchdog = setInterval(() => {
      if (closing || !tunnelId) return;
      if (!host?.isAlive()) {
        void startHost();
      }
    }, watchdogMs);
  }

  async function createTunnel(): Promise<void> {
    const create = await runner("devtunnel", ["create", "--json"]);
    ensureOk(create, "devtunnel create");
    const parsed = parseTunnelCreate(create.stdout);
    if (!parsed.tunnelId) {
      throw new Error("Could not parse tunnel id from `devtunnel create` output.");
    }
    tunnelId = parsed.tunnelId;
    cluster = parsed.cluster;
    const port = await runner("devtunnel", [
      "port",
      "create",
      tunnelId,
      "-p",
      String(options.port),
      "--protocol",
      "http"
    ]);
    ensureOk(port, "devtunnel port create");
  }

  async function startHost(): Promise<DashboardTunnelInfo> {
    if (!tunnelId) {
      await createTunnel();
    }
    if (!tunnelId) {
      throw new Error("Tunnel id was not initialized.");
    }
    const args = ["host", tunnelId];
    const startedHost = hostSpawner("devtunnel", args, {
      onStdout: (text) => {
        url = parseDashboardTunnelUrl(text) ?? url;
      },
      onStderr: (text) => {
        url = parseDashboardTunnelUrl(text) ?? url;
      },
      onExit: () => {
        host = undefined;
      }
    });
    host = startedHost;
    if (!url && cluster) {
      url = buildDashboardTunnelUrl(tunnelId, options.port, cluster);
    }
    const deadline = Date.now() + HOST_URL_TIMEOUT_MS;
    while (!url && startedHost.isAlive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!url) {
      if (cluster) {
        url = buildDashboardTunnelUrl(tunnelId, options.port, cluster);
      } else {
        throw new Error("Could not determine dashboard tunnel URL from devtunnel host output.");
      }
    }
    startWatchdog();
    return {
      devtunnelAvailable: true,
      authenticated: true,
      running: true,
      url
    };
  }

  return {
    async status() {
      const detected = await detect();
      return {
        ...detected,
        running: isRunning(),
        url: isRunning() ? url : undefined
      };
    },
    async ensure() {
      const detected = await detect();
      if (!detected.devtunnelAvailable) {
        throw new Error("devtunnel CLI is not available.");
      }
      if (!detected.authenticated) {
        throw new Error(dashboardTunnelAuthMessage);
      }
      if (isRunning() && url) {
        return {
          ...detected,
          devtunnelAvailable: true,
          authenticated: true,
          running: true,
          url
        };
      }
      starting ??= startHost().finally(() => {
        starting = undefined;
      });
      return starting;
    },
    async close() {
      closing = true;
      try {
        if (watchdog) {
          clearInterval(watchdog);
          watchdog = undefined;
        }
        host?.stop();
        host = undefined;
        const ownedTunnel = tunnelId;
        tunnelId = undefined;
        cluster = undefined;
        url = undefined;
        if (ownedTunnel) {
          const deleted = await runner("devtunnel", ["delete", ownedTunnel]);
          ensureOk(deleted, "devtunnel delete");
        }
      } finally {
        closing = false;
      }
    }
  };
}
