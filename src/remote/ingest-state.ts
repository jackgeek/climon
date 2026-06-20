import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getClimonHome } from "../config.js";
import { atomicWrite } from "../store.js";
import { isProcessAlive } from "../process-kill.js";
import { DEFAULT_INGEST_PORT } from "./ingest-port.js";

/**
 * Durable beacon for the ingest daemon, written atomically after it binds its
 * port. The ingest is the single writer of this file. It carries the bound pid,
 * port, and published host; the cross-OS control plane is authorized by
 * filesystem permissions, so the beacon carries no token.
 */
export interface IngestState {
  /** PID of the running ingest daemon process. */
  pid: number;
  /** TCP port the ingest actually bound (may differ from the default after a shift). */
  port: number;
  /**
   * Host/interface the ingest bound and that the PEER OS should connect to:
   * loopback when WSL hosts, the `vEthernet (WSL)` IPv4 when Windows hosts.
   * Optional for backward compatibility with PR #65 beacons that predate it.
   */
  host?: string;
  /**
   * Loopback-only socket ref (from formatSessionSocketRef) the dashboard server
   * connects to, to request a signed remote spawn. Optional for backward
   * compatibility with beacons that predate remote spawn.
   */
  controlSocket?: string;
}

export const INGEST_STATE_BASENAME = "ingest.json";

export function getIngestStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), INGEST_STATE_BASENAME);
}

export function parseIngestState(raw: string): IngestState | undefined {
  let parsed: Partial<IngestState>;
  try {
    parsed = JSON.parse(raw) as Partial<IngestState>;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const pidOk = typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0;
  const portOk = typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0;
  if (!pidOk || !portOk) return undefined;
  const state: IngestState = { pid: parsed.pid as number, port: parsed.port as number };
  if (typeof parsed.host === "string" && parsed.host.length > 0) state.host = parsed.host;
  if (typeof parsed.controlSocket === "string" && parsed.controlSocket.length > 0) {
    state.controlSocket = parsed.controlSocket;
  }
  return state;
}

export function serializeIngestState(state: IngestState): string {
  const payload: IngestState = { pid: state.pid, port: state.port };
  if (state.host !== undefined && state.host.length > 0) payload.host = state.host;
  if (state.controlSocket !== undefined && state.controlSocket.length > 0) {
    payload.controlSocket = state.controlSocket;
  }
  return `${JSON.stringify(payload)}\n`;
}

export async function writeIngestState(
  state: IngestState,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await atomicWrite(getIngestStatePath(env), serializeIngestState(state));
}

async function readIngestStateFromPath(path: string): Promise<IngestState | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  return parseIngestState(raw);
}

/** Reads the ingest beacon from an explicit CLIMON_HOME (local or peer over a mount). */
export async function readIngestStateFromDir(homeDir: string): Promise<IngestState | undefined> {
  return readIngestStateFromPath(join(homeDir, INGEST_STATE_BASENAME));
}

/** Reads the local ingest beacon (under this process's CLIMON_HOME). */
export async function readIngestState(env: NodeJS.ProcessEnv = process.env): Promise<IngestState | undefined> {
  return readIngestStateFromPath(getIngestStatePath(env));
}

/**
 * Single source of truth for the ingest port. Returns the live ingest.json
 * `port` (the port the daemon actually bound) when the beacon exists and its
 * pid is alive, then falls back to remote-host.json's ingestPort, then the
 * default. This is the fix for the port-skew bug: every consumer must call this
 * rather than assuming 3132 or trusting a start-port hint.
 */
export async function resolveIngestPort(
  env: NodeJS.ProcessEnv = process.env,
  deps: { isAlive?: (pid: number) => boolean } = {}
): Promise<number> {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const beacon = await readIngestState(env);
  if (beacon && isAlive(beacon.pid)) return beacon.port;
  const { readRemoteHostState } = await import("./ingest.js");
  const hostState = await readRemoteHostState(env);
  if (hostState && Number.isInteger(hostState.ingestPort) && hostState.ingestPort > 0) {
    return hostState.ingestPort;
  }
  return DEFAULT_INGEST_PORT;
}
