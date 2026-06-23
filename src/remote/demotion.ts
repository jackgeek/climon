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
/**
 * Shared demotion primitive (host -> client). Run when this OS hands the host
 * role to the peer: spawn an uplink so this OS's still-running sessions push to
 * the new host, stop the co-located dashboard server, free the contested ingest
 * listener, and remove this daemon's own beacon(s). Each caller injects its own
 * steps so the same ordering is shared and unit-testable.
 */
export interface DemotionDeps {
  /** Spawn a detached `__uplink` for this OS's local sessions. */
  spawnUplink: () => void;
  /** Stop the co-located dashboard server (SIGTERM its pid; no network). */
  stopLocalServer: () => Promise<void>;
  /** Stop accepting connections on the contested ingest listener. */
  closeListener: () => Promise<void>;
  /** Remove this daemon's own beacon file(s) and the consumed request file. */
  removeBeacons: () => Promise<void>;
}

export async function demote(deps: DemotionDeps): Promise<void> {
  // Close the ingest listener BEFORE spawning the uplink so the child
  // process does not inherit the listening socket handle.  On Windows,
  // spawn() inherits all inheritable handles even with detached+stdio:ignore;
  // if the uplink holds the socket, the port stays open after process.exit().
  await deps.closeListener();
  deps.spawnUplink();
  await deps.stopLocalServer();
  await deps.removeBeacons();
}
