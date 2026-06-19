import { spawn } from "node:child_process";
import { devtunnelEnv, type Runner, type RunResult } from "../remote/tunnel.js";

export type DashboardTunnelRunner = Runner;

export const dashboardTunnelAuthMessage =
  "devtunnel is not authenticated. Run `devtunnel user login` and try again.";

export interface DashboardTunnelStatus {
  devtunnelAvailable: boolean;
  authenticated: boolean;
  running: boolean;
  url?: string;
  tunnelId?: string;
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
  hostUrlTimeoutMs?: number;
  keepAliveMs?: number;
  verifyTunnel?: (url: string) => Promise<boolean>;
  pingTunnel?: (url: string) => Promise<void>;
  persisted?: {
    tunnelId?: string;
    cluster?: string;
  };
  onPersistTunnel?: (value: { tunnelId: string; cluster?: string }) => void | Promise<void>;
  onClearPersistedTunnel?: () => void | Promise<void>;
}

export interface DashboardTunnelManager {
  status: () => Promise<DashboardTunnelStatus>;
  ensure: () => Promise<DashboardTunnelInfo>;
  close: () => Promise<void>;
}

const HOST_URL_TIMEOUT_MS = 5000;
const VERIFY_TIMEOUT_MS = 8000;
const VERIFY_ATTEMPTS = 3;
const VERIFY_RETRY_DELAY_MS = 1000;
const MAX_TUNNEL_RECREATIONS = 1;
const KEEP_ALIVE_MS = 60000;
const KEEP_ALIVE_TIMEOUT_MS = 8000;

/**
 * Pings the dashboard `health` endpoint through the public tunnel URL to keep the
 * dev tunnels relay from idling out. The request travels the full relay path so the
 * relay registers activity; the response status is irrelevant, only that traffic flowed.
 */
export async function defaultPingDashboardTunnel(url: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KEEP_ALIVE_TIMEOUT_MS);
  try {
    await fetch(`${url.replace(/\/?$/, "/")}health`, {
      method: "GET",
      redirect: "manual",
      headers: { "X-Tunnel-Skip-AntiPhishing-Page": "true" },
      signal: controller.signal
    });
  } catch {
    // Network error / timeout — the watchdog handles a genuinely dead host; a missed
    // keep-alive ping is harmless and will be retried on the next interval.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes the public tunnel URL to confirm the relay is forwarding to the local
 * dashboard. Any HTTP response other than 404 / 5xx (including auth redirects or
 * the dev tunnels interstitial) means the endpoint is reachable; a network error,
 * timeout, 404, or 5xx means the tunnel is not working.
 */
export async function defaultVerifyDashboardTunnel(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, VERIFY_RETRY_DELAY_MS));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { "X-Tunnel-Skip-AntiPhishing-Page": "true" },
        signal: controller.signal
      });
      if (res.status !== 404 && res.status < 500) {
        return true;
      }
    } catch {
      // network error / timeout — treat as unreachable and retry
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

const defaultRunner: DashboardTunnelRunner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: cmd === "devtunnel" ? devtunnelEnv() : process.env,
      windowsHide: true
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
    env: cmd === "devtunnel" ? devtunnelEnv() : process.env,
    windowsHide: true
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

export function parseDashboardTunnelUrl(output: string, expectedPort?: number): string | undefined {
  const matches = output.match(/https:\/\/[a-z0-9][a-z0-9-]*-\d+\.[^\s/]+\.devtunnels\.ms\/?/gi);
  if (!matches) return undefined;
  if (expectedPort === undefined) return matches[0];
  // `devtunnel host` prints a browser URL for every mapped port; only the URL whose
  // port segment matches the live dashboard port forwards to a real listener.
  return matches.find((url) => url.includes(`-${expectedPort}.`));
}

/**
 * Splits a devtunnel id into its base name and cluster. The `devtunnel` CLI
 * returns tunnel ids in the form `<base>.<cluster>` (e.g. `peaceful-dog-g5pzmr1.eun1`);
 * the base contains only hyphens, so any `.` separates the trailing cluster.
 */
export function splitTunnelId(tunnelId: string): { base: string; cluster?: string } {
  const dot = tunnelId.lastIndexOf(".");
  if (dot === -1) return { base: tunnelId };
  return { base: tunnelId.slice(0, dot), cluster: tunnelId.slice(dot + 1) || undefined };
}

export function buildDashboardTunnelUrl(tunnelId: string, port: number, cluster: string): string {
  const { base } = splitTunnelId(tunnelId);
  return `https://${base}-${port}.${cluster}.devtunnels.ms/`;
}

export function parseTunnelCreate(stdout: string): { tunnelId?: string; cluster?: string } {
  const jsonStart = stdout.indexOf("{");
  const payload = jsonStart === -1 ? stdout : stdout.slice(jsonStart);
  try {
    const obj = JSON.parse(payload) as {
      tunnelId?: string;
      clusterId?: string;
      cluster?: string;
      tunnel?: { tunnelId?: string; clusterId?: string; cluster?: string };
    };
    const tunnelId = obj.tunnelId ?? obj.tunnel?.tunnelId;
    const explicitCluster = obj.clusterId ?? obj.cluster ?? obj.tunnel?.clusterId ?? obj.tunnel?.cluster;
    return {
      tunnelId,
      cluster: explicitCluster ?? (tunnelId ? splitTunnelId(tunnelId).cluster : undefined)
    };
  } catch {
    const tunnelId = payload.match(/\b([a-z0-9][a-z0-9-]{1,47}[a-z0-9](?:\.[a-z0-9]+)?)\b/i)?.[1];
    return { tunnelId, cluster: tunnelId ? splitTunnelId(tunnelId).cluster : undefined };
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

function isMissingTunnelError(output: string): boolean {
  return /not\s+found|does\s+not\s+exist|404|no tunnel/i.test(output);
}

function isExistingPortError(output: string): boolean {
  return /conflict|already\s+exists/i.test(output);
}

export function createDashboardTunnelManager(options: DashboardTunnelManagerOptions): DashboardTunnelManager {
  const runner = options.runner ?? defaultRunner;
  const hostSpawner = options.hostSpawner ?? defaultHostSpawner;
  const watchdogMs = options.watchdogMs ?? 5000;
  const hostUrlTimeoutMs = options.hostUrlTimeoutMs ?? HOST_URL_TIMEOUT_MS;
  const keepAliveMs = options.keepAliveMs ?? KEEP_ALIVE_MS;
  const verifyTunnel = options.verifyTunnel ?? defaultVerifyDashboardTunnel;
  const pingTunnel = options.pingTunnel ?? defaultPingDashboardTunnel;
  let tunnelId: string | undefined = options.persisted?.tunnelId;
  let cluster: string | undefined = options.persisted?.cluster;
  let persistedTunnelId: string | undefined = options.persisted?.tunnelId;
  let url: string | undefined;
  let host: HostProcess | undefined;
  let closing = false;
  let starting: Promise<DashboardTunnelInfo> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;

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

  function startKeepAlive(): void {
    if (keepAlive || keepAliveMs <= 0) return;
    keepAlive = setInterval(() => {
      if (closing || !url || !host?.isAlive()) return;
      void pingTunnel(url);
    }, keepAliveMs);
  }

  async function createTunnel(): Promise<void> {
    const create = await runner("devtunnel", ["create", "--json"]);
    ensureOk(create, "devtunnel create");
    const parsed = parseTunnelCreate(create.stdout);
    if (!parsed.tunnelId) {
      throw new Error("Could not parse tunnel id from `devtunnel create` output.");
    }
    tunnelId = parsed.tunnelId;
    cluster = parsed.cluster ?? splitTunnelId(tunnelId).cluster;
    await options.onPersistTunnel?.({ tunnelId, cluster });
    persistedTunnelId = tunnelId;
  }

  async function ensurePort(): Promise<RunResult | undefined> {
    if (!tunnelId) return undefined;
    return runner("devtunnel", [
      "port",
      "create",
      tunnelId,
      "-p",
      String(options.port),
      "--protocol",
      "http"
    ]);
  }

  /**
   * Removes any port mappings on the tunnel other than the live dashboard port.
   * The dashboard binds the next free port on each restart, so re-using a persisted
   * tunnel accumulates stale mappings that forward to dead local ports (502s).
   * Best-effort: a failed list or delete leaves the tunnel usable on the live port.
   */
  async function pruneStalePorts(id: string): Promise<void> {
    const list = await runner("devtunnel", ["port", "list", id, "--json"]);
    if (list.status !== 0) return;
    let ports: number[];
    try {
      const parsed = JSON.parse(list.stdout) as { ports?: Array<{ portNumber?: number }> };
      ports = (parsed.ports ?? [])
        .map((entry) => entry.portNumber)
        .filter((value): value is number => typeof value === "number");
    } catch {
      return;
    }
    for (const port of ports) {
      if (port === options.port) continue;
      await runner("devtunnel", ["port", "delete", id, "-p", String(port)]);
    }
  }

  async function forgetTunnel(id: string): Promise<void> {
    tunnelId = undefined;
    cluster = undefined;
    url = undefined;
    if (persistedTunnelId === id) {
      persistedTunnelId = undefined;
      await options.onClearPersistedTunnel?.();
    }
  }

  async function deleteTunnel(id: string): Promise<void> {
    await runner("devtunnel", ["delete", id, "-f"]);
  }

  async function discardTunnel(id: string): Promise<void> {
    host?.stop();
    host = undefined;
    await deleteTunnel(id);
    tunnelId = undefined;
    cluster = undefined;
    url = undefined;
    if (persistedTunnelId === id) {
      persistedTunnelId = undefined;
      await options.onClearPersistedTunnel?.();
    }
  }

  async function startHost(recreations = 0): Promise<DashboardTunnelInfo> {
    if (!tunnelId) {
      await createTunnel();
    }
    if (!tunnelId) {
      throw new Error("Tunnel id was not initialized.");
    }
    if (!cluster) {
      const derived = splitTunnelId(tunnelId).cluster;
      if (derived) {
        cluster = derived;
        if (persistedTunnelId === tunnelId) {
          await options.onPersistTunnel?.({ tunnelId, cluster });
        }
      }
    }
    const portResult = await ensurePort();
    if (portResult && portResult.status !== 0) {
      const portOutput = `${portResult.stderr}\n${portResult.stdout}`;
      if (!isExistingPortError(portOutput)) {
        if (isMissingTunnelError(portOutput)) {
          await forgetTunnel(tunnelId);
          await createTunnel();
          return startHost(recreations);
        }
        ensureOk(portResult, "devtunnel port create");
      }
    }
    const attemptedTunnelId = tunnelId;
    await pruneStalePorts(attemptedTunnelId);
    url = undefined;
    let startupStdout = "";
    let startupStderr = "";
    const args = ["host", attemptedTunnelId];
    const startedHost = hostSpawner("devtunnel", args, {
      onStdout: (text) => {
        startupStdout += text;
        url = parseDashboardTunnelUrl(text, options.port) ?? url;
      },
      onStderr: (text) => {
        startupStderr += text;
        url = parseDashboardTunnelUrl(text, options.port) ?? url;
      },
      onExit: () => {
        host = undefined;
      }
    });
    host = startedHost;
    const deadline = Date.now() + hostUrlTimeoutMs;
    while (!url && startedHost.isAlive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!url) {
      const startupOutput = `${startupStdout}\n${startupStderr}`.trim();
      if (!startedHost.isAlive() && isMissingTunnelError(startupOutput)) {
        await forgetTunnel(attemptedTunnelId);
        await createTunnel();
        return startHost();
      }
      if (startedHost.isAlive() && cluster) {
        url = buildDashboardTunnelUrl(attemptedTunnelId, options.port, cluster);
      } else {
        throw new Error("Could not determine dashboard tunnel URL from devtunnel host output.");
      }
    }
    if (startedHost.isAlive() && recreations < MAX_TUNNEL_RECREATIONS && !(await verifyTunnel(url))) {
      await discardTunnel(attemptedTunnelId);
      return startHost(recreations + 1);
    }
    startWatchdog();
    startKeepAlive();
    return {
      devtunnelAvailable: true,
      authenticated: true,
      running: true,
      url,
      tunnelId
    };
  }

  return {
    async status() {
      const detected = await detect();
      return {
        ...detected,
        running: isRunning(),
        url: isRunning() ? url : undefined,
        tunnelId
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
          url,
          tunnelId
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
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = undefined;
        }
        host?.stop();
        host = undefined;
        url = undefined;
      } finally {
        closing = false;
      }
    }
  };
}
