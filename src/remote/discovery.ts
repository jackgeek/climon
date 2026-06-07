import { resolveConfigSetting } from "../config.js";
import { isProcessAlive } from "../process-kill.js";
import { readServerState, readServerStateFromDir } from "../server-state.js";
import { peerHostCandidates } from "./peer.js";

export interface DashboardTarget {
  /** Whether the dashboard runs on this machine's CLIMON_HOME or the peer's. */
  location: "local" | "peer";
  /** Reachable host for both the dashboard HTTP server and ingest listener. */
  host: string;
  /** Dashboard HTTP port. */
  port: number;
  /** Live ingest port for the uplink, when remotes are running on the dashboard side. */
  ingest?: number;
  /** Dashboard URL to open in a browser. */
  url: string;
}

const HEALTH_TIMEOUT_MS = 1500;

interface HealthPorts {
  dashboard?: number;
  ingest?: number;
}

async function probeHealth(
  host: string,
  port: number,
  fetchFn: typeof fetch
): Promise<HealthPorts | undefined> {
  try {
    const res = await fetchFn(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { ok?: unknown; ports?: HealthPorts };
    if (body.ok !== true) return undefined;
    return body.ports ?? {};
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Discovers a running dashboard for `climon` to connect/uplink to.
 *
 * Order:
 *  1. Local CLIMON_HOME `server.json`, validated by PID liveness (same OS, cheap
 *     and trustworthy).
 *  2. Peer CLIMON_HOME `server.json` (`remote.peerHome`), validated by an HTTP
 *     `/health` probe — never by PID, because a peer-OS PID is meaningless here
 *     and could collide. The probe also self-heals a stale peer beacon and
 *     yields the live ingest port.
 *
 * The dashboard port (and ingest port) always come from the live beacon/health
 * response, so an automatic port bump on collision is handled transparently.
 */
export async function discoverDashboard(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  deps: { fetchFn?: typeof fetch; isAlive?: (pid: number) => boolean } = {}
): Promise<DashboardTarget | undefined> {
  const fetchFn = deps.fetchFn ?? fetch;
  const isAlive = deps.isAlive ?? isProcessAlive;

  const local = await readServerState(env);
  if (local && isAlive(local.pid)) {
    return {
      location: "local",
      host: "127.0.0.1",
      port: local.port,
      ingest: local.ingest,
      url: `http://127.0.0.1:${local.port}/`
    };
  }

  const peerHome = asString(resolveConfigSetting("remote.peerHome", env, cwd));
  if (!peerHome) return undefined;
  const peer = await readServerStateFromDir(peerHome);
  if (!peer) return undefined;

  const override = asString(resolveConfigSetting("remote.peerHost", env, cwd));
  const candidates = override ? [override] : peerHostCandidates(env);
  for (const host of candidates) {
    const ports = await probeHealth(host, peer.port, fetchFn);
    if (ports) {
      return {
        location: "peer",
        host,
        port: peer.port,
        ingest: ports.ingest ?? peer.ingest,
        url: `http://${host}:${peer.port}/`
      };
    }
  }
  return undefined;
}
