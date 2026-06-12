import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getClimonHome } from "../config.js";
import { isProcessAlive, killProcess } from "../process-kill.js";
import { getServerStatePath, readServerState } from "../server-state.js";
import { getIngestStatePath } from "./ingest-state.js";
import { getShutdownRequestPath } from "./shutdown-request.js";

export function getUplinkPidPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), "uplink.pid");
}

async function readPid(path: string): Promise<number | undefined> {
  try {
    const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stops the detached uplink daemon by its pidfile. Returns true if a live
 * uplink was signalled. Best-effort and idempotent: absent/dead pid → false.
 */
export async function stopUplinkDaemon(
  options: {
    env?: NodeJS.ProcessEnv;
    isProcessAlive?: (pid: number) => boolean;
    killProcess?: (pid: number, force: boolean) => boolean;
  } = {}
): Promise<boolean> {
  const env = options.env ?? process.env;
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const kill = options.killProcess ?? killProcess;
  const pid = await readPid(getUplinkPidPath(env));
  if (pid === undefined || !isAlive(pid)) return false;
  return kill(pid, false);
}

function getIngestPidPathLocal(env: NodeJS.ProcessEnv): string {
  // Mirror getIngestPidPath without importing the heavy ingest module into the
  // client bundle.
  return join(getClimonHome(env), "ingest.pid");
}

export interface TeardownReport {
  serverStopped: boolean;
  ingestStopped: boolean;
  uplinkStopped: boolean;
  removed: string[];
}

/**
 * Full local teardown of the dashboard stack: SIGTERM the server (pid from
 * server.json), terminate the ingest and uplink via their pidfiles, and remove
 * all beacons. Idempotent — already-dead daemons and absent files are fine. All
 * effects injected for testability.
 */
export async function teardownLocalServerStack(
  options: {
    env?: NodeJS.ProcessEnv;
    isProcessAlive?: (pid: number) => boolean;
    killProcess?: (pid: number, force: boolean) => boolean;
    removeFile?: (path: string) => Promise<void>;
  } = {}
): Promise<TeardownReport> {
  const env = options.env ?? process.env;
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const kill = options.killProcess ?? killProcess;
  const removeFile = options.removeFile ?? ((path: string) => rm(path, { force: true }).then(() => {}));

  const serverState = await readServerState(env);
  const serverStopped =
    serverState !== undefined && isAlive(serverState.pid) ? kill(serverState.pid, false) : false;
  const ingestPid = await readPid(getIngestPidPathLocal(env));
  const ingestStopped = ingestPid !== undefined && isAlive(ingestPid) ? kill(ingestPid, false) : false;
  const uplinkStopped = await stopUplinkDaemon({ env, isProcessAlive: isAlive, killProcess: kill });

  const removed: string[] = [];
  for (const path of [
    getServerStatePath(env),
    getIngestStatePath(env),
    getIngestPidPathLocal(env),
    getUplinkPidPath(env),
    getShutdownRequestPath(env)
  ]) {
    const exists = await stat(path).then(() => true, () => false);
    if (exists) {
      await removeFile(path);
      removed.push(path);
    }
  }

  return { serverStopped, ingestStopped, uplinkStopped, removed };
}
