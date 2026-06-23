/**
 * ⚠️ LEGACY TypeScript client — frozen. Fix the Rust client instead.
 *
 * The shipping `climon` *client* is the Rust workspace under `rust/` (crates
 * `climon-cli`, `climon-session`, `climon-pty`, `climon-store`, `climon-config`,
 * `climon-remote`, `climon-install`, `climon-update`, …). This module belongs to
 * the legacy Bun/TypeScript client, kept only for local development and the Bun
 * test suite. Do NOT add features or fix client bugs here — make all client
 * changes in the Rust crates. (The Bun dashboard *server* under `src/server*`
 * and `src/web/` is NOT legacy and is still maintained.)
 */
import { connect } from "node:net";
import { resolveConfigSetting } from "../config.js";
import { isProcessAlive } from "../process-kill.js";
import { readServerState, readServerStateFromDir } from "../server-state.js";
import { readIngestStateFromDir, resolveIngestPort } from "./ingest-state.js";
import { peerHostCandidates } from "./peer.js";
import { child } from "../logging/logger.js";
import { logMsg } from "../i18n/log-msg.js";

const log = () => child("discovery");

export interface DashboardTarget {
  /** Whether the dashboard runs on this machine's CLIMON_HOME or the peer's. */
  location: "local" | "peer";
  /** Reachable host for the ingest (and, locally, the dashboard HTTP server). */
  host: string;
  /** Dashboard HTTP port (from the peer server.json; may be loopback-only cross-OS). */
  port: number;
  /** Live ingest port for the uplink. */
  ingest?: number;
  /** Dashboard URL to open in a browser (reachable for a local host). */
  url: string;
}

const PROBE_TIMEOUT_MS = 1500;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Raw TCP liveness probe of the peer ingest (it speaks binary mux). */
function probeTcpDefault(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
  });
}

/**
 * Discovers a running dashboard for `climon` to connect/uplink to.
 *
 * Order:
 *  1. Local CLIMON_HOME `server.json`, validated by PID liveness (same OS).
 *  2. Peer CLIMON_HOME (`remote.peerHome`), validated by the peer `ingest.json`
 *     beacon plus a direct TCP probe of its PUBLISHED host (then the candidate
 *     list). The dashboard `/health` is never probed: under default WSL2 NAT a
 *     Windows-hosted dashboard binds loopback and is unreachable from WSL, while
 *     the ingest is bound to a peer-reachable interface and published.
 *
 * Ports come from the live beacons, so an automatic port bump is handled.
 */
export async function discoverDashboard(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  deps: { probeTcp?: (host: string, port: number) => Promise<boolean>; isAlive?: (pid: number) => boolean } = {}
): Promise<DashboardTarget | undefined> {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const probeTcp = deps.probeTcp ?? probeTcpDefault;

  logMsg(log(), "debug", "discovery.discovering_dashboard", {});
  const local = await readServerState(env);
  if (local && isAlive(local.pid)) {
    const ingest = await resolveIngestPort(env, { isAlive });
    logMsg(log(), "debug", "discovery.found_local_dashboard", {
      pid: local.pid,
      port: local.port,
      ingest: ingest ?? "none"
    });
    return {
      location: "local",
      host: "127.0.0.1",
      port: local.port,
      ingest,
      url: `http://127.0.0.1:${local.port}/`
    };
  }
  if (local) logMsg(log(), "debug", "discovery.local_server_pid_not_alive", { pid: local.pid });

  const peerHome = asString(resolveConfigSetting("remote.peerHome", env, cwd));
  if (!peerHome) {
    logMsg(log(), "debug", "discovery.no_peer_home_configured", {});
    return undefined;
  }
  logMsg(log(), "debug", "discovery.checking_peer_home", { peerHome });
  const peerIngest = await readIngestStateFromDir(peerHome);
  if (!peerIngest) {
    logMsg(log(), "debug", "discovery.no_peer_ingest_found", {});
    return undefined;
  }
  logMsg(log(), "debug", "discovery.peer_ingest_state", {
    port: peerIngest.port,
    host: peerIngest.host ?? "unset"
  });

  const override = asString(resolveConfigSetting("remote.peerHost", env, cwd));
  const candidates: string[] = [];
  if (peerIngest.host) candidates.push(peerIngest.host);
  for (const host of override ? [override] : peerHostCandidates(env)) {
    if (!candidates.includes(host)) candidates.push(host);
  }
  logMsg(log(), "debug", "discovery.probing_peer_host_candidates", { candidates: candidates.join(", ") });

  for (const host of candidates) {
    const reachable = await probeTcp(host, peerIngest.port);
    logMsg(log(), "debug", "discovery.peer_host_probe_result", {
      host,
      port: peerIngest.port,
      reachability: reachable ? "reachable" : "unreachable"
    });
    if (reachable) {
      const peerServer = await readServerStateFromDir(peerHome);
      const dashboardPort = peerServer?.port ?? peerIngest.port;
      return {
        location: "peer",
        host,
        port: dashboardPort,
        ingest: peerIngest.port,
        url: `http://${host}:${dashboardPort}/`
      };
    }
  }
  logMsg(log(), "debug", "discovery.no_reachable_peer_host_found", {});
  return undefined;
}
