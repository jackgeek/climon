import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getClimonHome } from "./config.js";

/**
 * Single state file for the running dashboard server. Keeping the pid and the
 * bound ports in one atomically-written file guarantees they can never skew (a
 * stale pid paired with a fresh port, or vice versa). The ports are recorded
 * because they can differ from the configured ones after an automatic bump on
 * collision; other processes — including a peer OS over a shared mount — read
 * this to discover the live server and auto-wire to it without any port config.
 */
export interface ServerState {
  /** PID of the running dashboard server process. */
  pid: number;
  /** TCP port the dashboard server (HTTP) bound to. */
  port: number;
  /** TCP port the remote ingest listener bound to, when remotes are enabled. */
  ingest?: number;
}

/** Basename of the server state file under CLIMON_HOME. */
export const SERVER_STATE_BASENAME = "server.json";

export function getServerStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), SERVER_STATE_BASENAME);
}

function parseServerState(raw: string): ServerState | undefined {
  let parsed: Partial<ServerState>;
  try {
    parsed = JSON.parse(raw) as Partial<ServerState>;
  } catch {
    return undefined;
  }
  const pidOk = typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0;
  const portOk = typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0;
  if (!pidOk || !portOk) return undefined;
  const ingestOk =
    typeof parsed.ingest === "number" && Number.isInteger(parsed.ingest) && parsed.ingest > 0;
  const state: ServerState = { pid: parsed.pid as number, port: parsed.port as number };
  if (ingestOk) state.ingest = parsed.ingest as number;
  return state;
}

/**
 * Reads a dashboard server state file from an explicit CLIMON_HOME directory.
 * Used for peer discovery, where the directory belongs to the other OS and is
 * reached over a mount (`/mnt/c/...` or `\\wsl.localhost\...`). Returns
 * undefined when the file is absent, unreadable, malformed, or missing a valid
 * pid/port.
 */
export async function readServerStateFromDir(homeDir: string): Promise<ServerState | undefined> {
  return readServerStateFromPath(join(homeDir, SERVER_STATE_BASENAME));
}

/** Reads the local dashboard server state file (under this process's CLIMON_HOME). */
export async function readServerState(
  env: NodeJS.ProcessEnv = process.env
): Promise<ServerState | undefined> {
  return readServerStateFromPath(getServerStatePath(env));
}

async function readServerStateFromPath(path: string): Promise<ServerState | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
  return parseServerState(raw);
}

/** Serializes server state to the JSON written into the state file. */
export function serializeServerState(state: ServerState): string {
  const payload: ServerState = { pid: state.pid, port: state.port };
  if (state.ingest !== undefined) payload.ingest = state.ingest;
  return `${JSON.stringify(payload)}\n`;
}
