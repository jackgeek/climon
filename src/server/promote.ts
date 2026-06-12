/**
 * Promote coordinator: decides and drives how `bun run server` (becoming host)
 * displaces a peer host, entirely over the shared filesystem plus a single
 * data-plane-reachable TCP probe of the peer ingest. All I/O is injected so the
 * matrix is deterministically testable.
 *
 * Matrix (spec error-handling):
 *   - no peer beacons                          -> proceed (no peer host)
 *   - peer ingest present, not listening       -> clear stale peer beacons, proceed
 *   - peer ingest listening, demoted in grace  -> proceed (graceful handoff)
 *   - peer ingest listening, not demoted       -> abort (cleanup on peer OS)
 *   - peer server present, no ingest beacon    -> abort (no ingest to request)
 */
export interface IngestTarget {
  /** Live ingest port from the peer beacon. */
  port: number;
  /** Published bind host from the peer beacon (preferred probe target). */
  host?: string;
}

export interface PromoteDeps {
  /** Human label of the peer OS for the `climon cleanup` advice (e.g. "WSL"). */
  peerLabel: string;
  /** Optional diagnostic sink; receives human-readable progress lines. */
  log?: (message: string) => void;
  /** Read peer server.json (port), or undefined if absent. */
  readPeerServer: () => Promise<{ port: number } | undefined>;
  /** Read peer ingest.json (port + published host), or undefined if absent/invalid. */
  readPeerIngest: () => Promise<{ port: number; host?: string } | undefined>;
  /** TCP-probe the peer ingest (published host first, candidate fallback). */
  probeIngestListening: (target: IngestTarget) => Promise<boolean>;
  /** Write a (token-free) shutdown-request into the peer's home over the mount. */
  writeShutdownRequest: () => Promise<void>;
  /** Poll until the peer beacons vanish AND the ingest port is closed (bounded). */
  confirmDemoted: (target: IngestTarget) => Promise<boolean>;
  /** Remove the peer's stale beacons (server.json/ingest.json/pid/request). */
  clearPeerBeacons: () => Promise<void>;
  /**
   * Request graceful shutdown of the peer dashboard via its HTTP endpoint.
   * Used when there's no ingest to coordinate through. Optional — if absent
   * the promote falls back to abort.
   */
  requestPeerShutdown?: (port: number) => Promise<boolean>;
}

/** How a successful promote displaced (or didn't need to displace) the peer. */
export type PromoteVia = "graceful" | "no-live-peer";

export type PromoteOutcome =
  | { kind: "proceed"; via: PromoteVia }
  | { kind: "aborted"; reason: string; cleanupOn: string };

export async function runPromote(deps: PromoteDeps): Promise<PromoteOutcome> {
  const log = deps.log ?? ((): void => {});
  const [peerServer, peerIngest] = await Promise.all([deps.readPeerServer(), deps.readPeerIngest()]);
  log(
    `peer beacons: server.json ${peerServer ? `present (port ${peerServer.port})` : "absent"}, ` +
      `ingest.json ${
        peerIngest ? `present (port ${peerIngest.port}${peerIngest.host ? `, host ${peerIngest.host}` : ""})` : "absent"
      }`
  );

  // 1. No peer host at all.
  if (!peerServer && !peerIngest) {
    log("no peer beacons; proceeding");
    return { kind: "proceed", via: "no-live-peer" };
  }

  // 2. The peer ingest is the contested anchor and the only daemon we can ask to
  //    stand down by writing a request into its home.
  if (peerIngest) {
    const listening = await deps.probeIngestListening(peerIngest);
    log(`peer ingest ${listening ? "listening" : "not listening"}`);
    if (!listening) {
      log("clearing stale peer beacons and proceeding");
      await deps.clearPeerBeacons();
      return { kind: "proceed", via: "no-live-peer" };
    }
    log("writing shutdown-request into the peer home");
    await deps.writeShutdownRequest();
    if (await deps.confirmDemoted(peerIngest)) {
      log("peer demoted (beacons gone, ingest port closed)");
      return { kind: "proceed", via: "graceful" };
    }
    log("peer ingest would not demote within the grace window; aborting");
    return {
      kind: "aborted",
      reason: "A climon ingest is still listening on the peer OS and would not demote.",
      cleanupOn: deps.peerLabel
    };
  }

  // 3. Peer dashboard beacon present but no ingest beacon: try a direct HTTP
  //    shutdown of the peer server. This handles the common case where the peer
  //    server is running without an ingest (e.g. Windows server started without
  //    remotes, or ingest crashed).
  if (deps.requestPeerShutdown && peerServer) {
    log("peer dashboard beacon present but no ingest; attempting HTTP shutdown");
    const stopped = await deps.requestPeerShutdown(peerServer.port);
    if (stopped) {
      log("peer server shut down via HTTP; clearing stale beacons");
      await deps.clearPeerBeacons();
      return { kind: "proceed", via: "graceful" };
    }
    log("HTTP shutdown failed or timed out");
  } else {
    log("peer dashboard beacon present but no ingest beacon; cannot author a shutdown-request");
  }
  return {
    kind: "aborted",
    reason: "The peer dashboard left a server.json but no ingest beacon to coordinate a clean handoff.",
    cleanupOn: deps.peerLabel
  };
}
