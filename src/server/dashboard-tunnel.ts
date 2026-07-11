import { spawn } from "node:child_process";
import { classifyDevtunnelFailure } from "../devtunnel/classify.js";
import {
  createDevtunnelGateway,
  devtunnelEnv,
  type DevtunnelGateway,
  type Runner,
  type RunResult
} from "../devtunnel/gateway.js";
import type { DevtunnelProcess, DevtunnelProcessHandlers } from "../devtunnel/process.js";
import { DevtunnelRetryController } from "../devtunnel/retry.js";
import {
  DevtunnelError,
  type DevtunnelFailure,
  type DevtunnelHealth,
  type DevtunnelOperation,
  type DevtunnelRetryState
} from "../devtunnel/types.js";

export type DashboardTunnelRunner = Runner;

type TunnelState = DevtunnelHealth["state"];

export const dashboardTunnelAuthMessage =
  "devtunnel is not authenticated. Run `devtunnel user login` and try again.";

export interface DashboardTunnelStatus extends DevtunnelHealth {
  running: boolean;
  url?: string;
  tunnelId?: string;
  expiresAt?: string;
  /**
   * Back-compat mirror of {@link DevtunnelHealth.available}. Existing dashboard
   * components read `devtunnelAvailable`; the structured `available` field is
   * exposed alongside it so both old and new consumers keep working.
   */
  devtunnelAvailable: boolean;
}

/** Narrowed view of a successfully running tunnel returned by {@link DashboardTunnelManager.ensure}. */
export interface DashboardTunnelInfo extends DashboardTunnelStatus {
  devtunnelAvailable: true;
  authenticated: true;
  running: true;
  url: string;
}

/**
 * A factory that receives the manager's host process handlers and returns a
 * gateway wired to deliver `devtunnel host` output back to the manager. Because
 * {@link DevtunnelGateway.spawnHost} takes its handlers from construction-time
 * deps (`processHandlers`), the manager must own gateway construction to route
 * per-lifetime host output; tests supply a factory to inject a fake gateway.
 */
export type DashboardTunnelGatewayFactory = (handlers: DevtunnelProcessHandlers) => DevtunnelGateway;

interface DashboardTunnelManagerOptions {
  port: number;
  gateway?: DevtunnelGateway | DashboardTunnelGatewayFactory;
  /**
   * Raw runner used only for the best-effort verbose expiry probe
   * (`devtunnel show <id> -v -j`). The gateway parses JSON, which does not work
   * on the interleaved MSAL/HTTP verbose stream, so this narrow raw path is kept.
   */
  rawRunner?: Runner;
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
  ensure: () => Promise<DashboardTunnelStatus>;
  retry: () => Promise<DashboardTunnelStatus>;
  close: () => Promise<void>;
}

const HOST_URL_TIMEOUT_MS = 5000;
const VERIFY_TIMEOUT_MS = 8000;
const VERIFY_ATTEMPTS = 3;
const VERIFY_RETRY_DELAY_MS = 1000;
const MAX_TUNNEL_RECREATIONS = 1;
const KEEP_ALIVE_MS = 60000;
const EXPIRY_TTL_MS = 60000;
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

/** Spawn-based raw runner used for the best-effort verbose expiry probe. */
const defaultRawRunner: Runner = (cmd, args) =>
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

/**
 * Extracts the tunnel's absolute expiry (ISO 8601) from `devtunnel show -v -j`
 * output. The verbose stream interleaves MSAL/HTTP log lines with the raw
 * service JSON; only the JSON carries an absolute `"expiration"`, whereas the
 * non-verbose summary exposes a relative `"tunnelExpiration"` we deliberately
 * skip. The leading quote in the pattern anchors to the exact `expiration` key
 * so `tunnelExpiration` never matches, and the value must be an ISO-8601
 * timestamp so a stray `"expiration"` carrying a non-datetime value (e.g. log
 * noise) is skipped in favour of the real one.
 */
export function parseTunnelExpiry(output: string): string | undefined {
  const match = output.match(
    /"expiration"\s*:\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))"/
  );
  return match?.[1];
}

function fallbackFailure(operation: DevtunnelOperation, status: number, stderr: string): DevtunnelFailure {
  return classifyDevtunnelFailure({ operation, status, stdout: "", stderr }, new Date());
}

export function createDashboardTunnelManager(options: DashboardTunnelManagerOptions): DashboardTunnelManager {
  const watchdogMs = options.watchdogMs ?? 5000;
  const hostUrlTimeoutMs = options.hostUrlTimeoutMs ?? HOST_URL_TIMEOUT_MS;
  const keepAliveMs = options.keepAliveMs ?? KEEP_ALIVE_MS;
  const verifyTunnel = options.verifyTunnel ?? defaultVerifyDashboardTunnel;
  const pingTunnel = options.pingTunnel ?? defaultPingDashboardTunnel;
  const rawRunner = options.rawRunner ?? defaultRawRunner;
  const retryController = new DevtunnelRetryController();

  let tunnelId: string | undefined = options.persisted?.tunnelId;
  let cluster: string | undefined = options.persisted?.cluster;
  let persistedTunnelId: string | undefined = options.persisted?.tunnelId;
  let url: string | undefined;
  let expiresAt: string | undefined;
  let expiresAtFetchedAt = 0;
  let host: DevtunnelProcess | undefined;
  let closing = false;
  let starting: Promise<DashboardTunnelStatus> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  // Health surfaced over the wire, updated by detectHealth() / host lifecycle.
  let available = false;
  let authenticated = false;
  let version: string | undefined;
  let managerState: TunnelState = "idle";
  let lastFailure: DevtunnelFailure | undefined;
  let lastSuccessAt: string | undefined;
  let retryState: DevtunnelRetryState | undefined;

  // Per-start host accumulation, reset at the top of each startHost attempt.
  let startupStdout = "";
  let startupStderr = "";
  let lastHostExitFailure: DevtunnelFailure | undefined;
  // Number of pending host exits that were triggered by us (close/recreation) and
  // must NOT be recorded as failures. The host exits asynchronously after stop(),
  // so we tag intentional stops here and consume the tag in onExit.
  let intentionalStops = 0;

  const hostHandlers: DevtunnelProcessHandlers = {
    onStdout: (text) => {
      startupStdout += text;
      url = parseDashboardTunnelUrl(text, options.port) ?? url;
    },
    onStderr: (text) => {
      startupStderr += text;
      url = parseDashboardTunnelUrl(text, options.port) ?? url;
    },
    onExit: (failure) => {
      if (intentionalStops > 0) {
        // A deliberate stop (close/recreation) already cleared `host`; never let
        // its async exit null a host that may have been reassigned since, and
        // never record it as a crash.
        intentionalStops -= 1;
        return;
      }
      host = undefined;
      if (failure) {
        lastHostExitFailure = failure;
        lastFailure = failure;
        retryState = retryController.fail(failure);
        managerState = retryState.paused ? "paused" : "retrying";
      }
    }
  };

  /**
   * Stops the running host as a deliberate action (close or recreation). The
   * ensuing async exit is suppressed so it is not mistaken for a crash that would
   * flip the manager into a retrying/paused state.
   */
  function stopHostIntentionally(): void {
    const current = host;
    host = undefined;
    if (current?.isAlive()) {
      intentionalStops += 1;
    }
    current?.stop();
  }

  const gateway: DevtunnelGateway =
    typeof options.gateway === "function"
      ? options.gateway(hostHandlers)
      : options.gateway ?? createDevtunnelGateway({ processHandlers: hostHandlers });

  function buildStatus(running: boolean): DashboardTunnelStatus {
    return {
      available,
      devtunnelAvailable: available,
      authenticated,
      running,
      url: running ? url : undefined,
      tunnelId,
      version,
      expiresAt: running ? expiresAt : undefined,
      state: running ? "running" : managerState,
      lastFailure,
      lastSuccessAt,
      retry: retryState,
      probedAt: new Date().toISOString()
    };
  }

  /** Refreshes available/authenticated/version from the gateway probes. */
  async function detectHealth(): Promise<void> {
    const detected = await gateway.detect();
    available = detected.available;
    if (detected.version) version = detected.version;
    if (!available) {
      authenticated = false;
      lastFailure = detected.lastFailure ?? lastFailure;
      return;
    }
    const user = await gateway.showUser();
    authenticated = user.authenticated;
    if (!authenticated) {
      lastFailure = user.lastFailure ?? lastFailure;
    }
  }

  function isRunning(): boolean {
    return Boolean(host?.isAlive());
  }

  /** Clears the per-start host scratch state before spawning a new host process. */
  function resetHostStartupState(): void {
    startupStdout = "";
    startupStderr = "";
    lastHostExitFailure = undefined;
  }

  function startWatchdog(): void {
    if (watchdog) return;
    watchdog = setInterval(() => {
      if (closing || !tunnelId) return;
      // A paused link is waiting on an actionable/permanent failure; only an
      // explicit retry() should re-attempt it, so the watchdog stands down.
      if (managerState === "paused") return;
      if (!host?.isAlive()) {
        void startHost().catch(() => {
          // A restart failure keeps the retry/pause state set by the host exit
          // handler; the next watchdog tick or an explicit retry() re-attempts.
        });
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
    const create = await gateway.createTunnel({});
    const parsed = parseTunnelCreate(create.stdout);
    if (!parsed.tunnelId) {
      throw new DevtunnelError(fallbackFailure("create-tunnel", 1, "Could not parse tunnel id from `devtunnel create` output."));
    }
    tunnelId = parsed.tunnelId;
    cluster = parsed.cluster ?? splitTunnelId(tunnelId).cluster;
    await options.onPersistTunnel?.({ tunnelId, cluster });
    persistedTunnelId = tunnelId;
  }

  /**
   * Ensures the live dashboard port is mapped on the current tunnel. Returns
   * `true` when the caller should retry with a freshly created tunnel (the
   * persisted tunnel disappeared); throws a {@link DevtunnelError} for any other
   * failure. A pre-existing mapping (`port_conflict`) is swallowed by the gateway.
   */
  async function ensurePort(): Promise<boolean> {
    if (!tunnelId) return false;
    try {
      await gateway.createPort(tunnelId, options.port, "http");
      return false;
    } catch (error) {
      if (error instanceof DevtunnelError && error.failure.code === "tunnel_not_found") {
        await forgetTunnel(tunnelId);
        await createTunnel();
        return true;
      }
      throw error;
    }
  }

  /**
   * Removes any port mappings on the tunnel other than the live dashboard port.
   * The dashboard binds the next free port on each restart, so re-using a persisted
   * tunnel accumulates stale mappings that forward to dead local ports (502s).
   * Best-effort: a failed list or delete leaves the tunnel usable on the live port.
   */
  async function pruneStalePorts(id: string): Promise<void> {
    let list: RunResult;
    try {
      list = await gateway.listPorts(id);
    } catch {
      return;
    }
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
      try {
        await gateway.deletePort(id, port);
      } catch {
        // Best-effort — a stale mapping we could not delete is non-fatal.
      }
    }
  }

  async function forgetTunnel(id: string): Promise<void> {
    tunnelId = undefined;
    cluster = undefined;
    url = undefined;
    expiresAt = undefined;
    expiresAtFetchedAt = 0;
    if (persistedTunnelId === id) {
      persistedTunnelId = undefined;
      await options.onClearPersistedTunnel?.();
    }
  }

  async function deleteTunnel(id: string): Promise<void> {
    try {
      await gateway.deleteTunnel(id, true);
    } catch {
      // Best-effort cleanup — a delete failure must not block recreation.
    }
  }

  async function discardTunnel(id: string): Promise<void> {
    stopHostIntentionally();
    await deleteTunnel(id);
    tunnelId = undefined;
    cluster = undefined;
    url = undefined;
    expiresAt = undefined;
    expiresAtFetchedAt = 0;
    if (persistedTunnelId === id) {
      persistedTunnelId = undefined;
      await options.onClearPersistedTunnel?.();
    }
  }

  function markRunning(): DashboardTunnelStatus {
    available = true;
    authenticated = true;
    managerState = "running";
    lastSuccessAt = new Date().toISOString();
    lastFailure = undefined;
    retryState = retryController.success();
    return buildStatus(true);
  }

  async function startHost(recreations = 0): Promise<DashboardTunnelStatus> {
    if (!tunnelId) {
      await createTunnel();
    }
    if (!tunnelId) {
      throw new DevtunnelError(fallbackFailure("create-tunnel", 1, "Tunnel id was not initialized."));
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
    if (await ensurePort()) {
      return startHost(recreations);
    }
    const attemptedTunnelId = tunnelId;
    await pruneStalePorts(attemptedTunnelId);
    url = undefined;
    resetHostStartupState();
    const startedHost = gateway.spawnHost(attemptedTunnelId);
    host = startedHost;
    const deadline = Date.now() + hostUrlTimeoutMs;
    while (!url && startedHost.isAlive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!url) {
      if (!startedHost.isAlive() && lastHostExitFailure?.code === "tunnel_not_found") {
        await forgetTunnel(attemptedTunnelId);
        await createTunnel();
        return startHost();
      }
      if (startedHost.isAlive() && cluster) {
        url = buildDashboardTunnelUrl(attemptedTunnelId, options.port, cluster);
      } else {
        // The host exited before printing a browser link. Surface the classified
        // exit failure (which carries sanitized technical detail) so callers can
        // present a structured error rather than an opaque string.
        throw new DevtunnelError(
          lastHostExitFailure ??
            fallbackFailure(
              "host-tunnel",
              1,
              `${startupStdout}\n${startupStderr}`.trim() ||
                "Could not determine dashboard tunnel URL from devtunnel host output."
            )
        );
      }
    }
    if (startedHost.isAlive() && recreations < MAX_TUNNEL_RECREATIONS && !(await verifyTunnel(url))) {
      await discardTunnel(attemptedTunnelId);
      return startHost(recreations + 1);
    }
    startWatchdog();
    startKeepAlive();
    return markRunning();
  }

  /**
   * Refreshes the cached absolute tunnel expiry via `devtunnel show -v -j`,
   * at most once per `EXPIRY_TTL_MS`. Best-effort: any failure or unparseable
   * output leaves the previous value untouched and never throws.
   */
  async function refreshExpiry(): Promise<void> {
    if (!tunnelId) return;
    if (Date.now() - expiresAtFetchedAt < EXPIRY_TTL_MS) return;
    expiresAtFetchedAt = Date.now();
    try {
      const result = await rawRunner("devtunnel", ["show", tunnelId, "-v", "-j"]);
      if (result.status === 0) {
        const parsed = parseTunnelExpiry(result.stdout);
        if (parsed) expiresAt = parsed;
      }
    } catch {
      // ignore — keep the last known expiry
    }
  }

  async function ensure(): Promise<DashboardTunnelStatus> {
    await detectHealth();
    if (!available) {
      throw new DevtunnelError(lastFailure ?? fallbackFailure("detect", 127, "devtunnel CLI is not available."));
    }
    if (!authenticated) {
      throw new DevtunnelError(lastFailure ?? fallbackFailure("show-user", 1, "not logged in"));
    }
    if (isRunning() && url) {
      return buildStatus(true);
    }
    starting ??= startHost().finally(() => {
      starting = undefined;
    });
    return starting;
  }

  return {
    async status() {
      await detectHealth();
      const running = isRunning();
      if (running) {
        await refreshExpiry();
      }
      return buildStatus(running);
    },
    ensure,
    async retry() {
      retryState = retryController.resume();
      if (managerState === "paused") {
        managerState = "idle";
      }
      return ensure();
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
        stopHostIntentionally();
        url = undefined;
        managerState = "stopped";
      } finally {
        closing = false;
      }
    }
  };
}
