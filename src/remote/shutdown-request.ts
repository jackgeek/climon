import { join } from "node:path";
import { getClimonHome } from "../config.js";
import { atomicWrite } from "../store.js";

/**
 * The single cross-OS control message. The promoting OS writes this file into
 * the PEER's CLIMON_HOME over the shared mount to ask the peer's durable ingest
 * daemon to demote itself. It carries NO token: writing the file already requires
 * same-user write access to the peer's home, which IS the authorization. Its mere
 * presence (well-formed) is the demote signal; replay is prevented by the ingest
 * clearing any request at startup and consuming it after acting.
 */
export interface ShutdownRequest {
  /** "WSL" | "Windows" — diagnostics/observability only. */
  requestedBy: string;
  /** Epoch milliseconds the request was written. */
  ts: number;
}

export const SHUTDOWN_REQUEST_BASENAME = "shutdown-request.json";

/** Upper bound on the on-disk file; an oversized request is rejected before parsing. */
export const MAX_SHUTDOWN_REQUEST_BYTES = 4096;
const ALLOWED_REQUESTERS = new Set(["WSL", "Windows"]);

export function getShutdownRequestPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), SHUTDOWN_REQUEST_BASENAME);
}

/** Path to the request file inside an explicit home dir (the peer's, over the mount). */
export function getShutdownRequestPathInDir(homeDir: string): string {
  return join(homeDir, SHUTDOWN_REQUEST_BASENAME);
}

export function serializeShutdownRequest(request: ShutdownRequest): string {
  const payload: ShutdownRequest = { requestedBy: request.requestedBy, ts: request.ts };
  return `${JSON.stringify(payload)}\n`;
}

/**
 * Parses and validates a request. Returns undefined for anything oversized,
 * malformed, or outside the allow-listed shape so the watcher can ignore it
 * without acting.
 */
export function parseShutdownRequest(raw: string): ShutdownRequest | undefined {
  if (raw.length > MAX_SHUTDOWN_REQUEST_BYTES) return undefined;
  let parsed: Partial<ShutdownRequest>;
  try {
    parsed = JSON.parse(raw) as Partial<ShutdownRequest>;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const requestedByOk =
    typeof parsed.requestedBy === "string" && ALLOWED_REQUESTERS.has(parsed.requestedBy);
  const tsOk = typeof parsed.ts === "number" && Number.isFinite(parsed.ts) && parsed.ts > 0;
  if (!requestedByOk || !tsOk) return undefined;
  return { requestedBy: parsed.requestedBy as string, ts: parsed.ts as number };
}

/** Atomically writes a shutdown request into an explicit home dir (the peer's). */
export async function writeShutdownRequestToDir(homeDir: string, request: ShutdownRequest): Promise<void> {
  await atomicWrite(getShutdownRequestPathInDir(homeDir), serializeShutdownRequest(request));
}
