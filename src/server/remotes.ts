const STALE_AFTER_MS = 30_000;

export interface IngestConnectionStatus {
  clientId: string;
  hostname: string;
  os: string;
  address?: string;
  connectedAt: number;
  sessionCount: number;
  lastPingAt?: number;
}

export interface IngestStatusFile {
  pid: number;
  updatedAt: number;
  connections: IngestConnectionStatus[];
}

export interface RemotesConnection extends IngestConnectionStatus {
  stale: boolean;
}

export interface RemotesResponse {
  connections: RemotesConnection[];
  ingestRunning: boolean;
  remotesActive: boolean;
}

/** Derives the `/api/remotes` payload. Staleness is computed, never trusted. */
export function buildRemotesResponse(
  status: IngestStatusFile | undefined,
  nowMs: number,
  remotesActive: boolean,
  isAlive: (pid: number) => boolean,
): RemotesResponse {
  if (!status) {
    return { connections: [], ingestRunning: false, remotesActive };
  }
  const pidAlive = isAlive(status.pid);
  const statusStale = !pidAlive || nowMs - status.updatedAt > STALE_AFTER_MS;
  const connections: RemotesConnection[] = status.connections.map((c) => {
    const reference = c.lastPingAt ?? c.connectedAt;
    const stale = statusStale || nowMs - reference > STALE_AFTER_MS;
    return { ...c, stale };
  });
  return { connections, ingestRunning: pidAlive && !statusStale, remotesActive };
}
