import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getClimonHome } from "../config.js";
import { isProcessAlive, killProcess } from "../process-kill.js";
import { getServerStatePath, readServerState } from "../server-state.js";
import { getIngestStatePath } from "./ingest-state.js";
import { getShutdownRequestPath } from "./shutdown-request.js";
import { child } from "../logging/logger.js";
import { logMsg } from "../i18n/log-msg.js";

/**
 * Lazily bind to the active root logger so the role set by the entrypoint's
 * initLogger() call is respected (avoids capturing a default root at import).
 */
const log = () => child("teardown");

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
  logMsg(log(), "debug", "teardown.stopping_uplink_daemon_via_pidfile", { pid });
  return kill(pid, false);
}

function getIngestPidPathLocal(env: NodeJS.ProcessEnv): string {
  // Mirror getIngestPidPath without importing the heavy ingest module into the
  // client bundle.
  return join(getClimonHome(env), "ingest.pid");
}

export interface KillFailure {
  component: string;
  pid: number;
  reason: string;
  advice?: string;
}

export interface StaleFile {
  path: string;
  pid: number;
}

export interface TeardownReport {
  serverStopped: boolean;
  ingestStopped: boolean;
  uplinkStopped: boolean;
  removed: string[];
  failures: KillFailure[];
  staleFiles: StaleFile[];
}

/** Wait a short time for a process to die after being signalled. */
async function waitForDeath(pid: number, isAlive: (pid: number) => boolean, timeoutMs = 3000, pollMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !isAlive(pid);
}

/**
 * Full local teardown of the dashboard stack: SIGTERM the server (pid from
 * server.json), terminate the ingest and uplink via their pidfiles, and remove
 * beacons only after confirming processes are dead. Reports failures with
 * remediation advice.
 */
export async function teardownLocalServerStack(
  options: {
    env?: NodeJS.ProcessEnv;
    isProcessAlive?: (pid: number) => boolean;
    killProcess?: (pid: number, force: boolean) => boolean;
    removeFile?: (path: string) => Promise<void>;
    /** How long to wait for a process to die after kill signal (ms). Default 3000. */
    waitTimeoutMs?: number;
  } = {}
): Promise<TeardownReport> {
  const env = options.env ?? process.env;
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const kill = options.killProcess ?? killProcess;
  const removeFile = options.removeFile ?? ((path: string) => rm(path, { force: true }).then(() => {}));
  const waitTimeout = options.waitTimeoutMs ?? 3000;

  const failures: KillFailure[] = [];
  const staleFiles: StaleFile[] = [];

  logMsg(log(), "debug", "teardown.starting_local_dashboard_stack_teardown", {});

  // --- Kill processes ---
  const serverState = await readServerState(env);
  let serverStopped = false;
  let serverDead = true;
  if (serverState && isAlive(serverState.pid)) {
    logMsg(log(), "debug", "teardown.stopping_dashboard_server", { pid: serverState.pid, port: serverState.port });
    // Try graceful HTTP shutdown first (cross-platform, no signal issues).
    try {
      await fetch(`http://127.0.0.1:${serverState.port}/__internal/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(1000),
      }).catch(() => {});
      serverDead = await waitForDeath(serverState.pid, isAlive, waitTimeout);
    } catch {
      serverDead = false;
    }
    if (serverDead) {
      serverStopped = true;
    } else {
      // Fall back to force kill on Windows (taskkill without /F fails for
      // headless console processes that have no message loop).
      const killed = kill(serverState.pid, process.platform === "win32");
      if (killed) {
        serverDead = await waitForDeath(serverState.pid, isAlive, waitTimeout);
        if (serverDead) {
          serverStopped = true;
        } else {
          kill(serverState.pid, true);
          serverDead = await waitForDeath(serverState.pid, isAlive, Math.min(waitTimeout, 2000));
          if (serverDead) {
            serverStopped = true;
          } else {
            failures.push({
              component: "dashboard server",
              pid: serverState.pid,
              reason: "process did not terminate after force kill",
              advice: process.platform === "win32"
                ? `Stop-Process -Id ${serverState.pid} -Force`
                : `kill -9 ${serverState.pid}`
            });
          }
        }
      } else {
        serverDead = false;
        failures.push({
          component: "dashboard server",
          pid: serverState.pid,
          reason: "kill signal could not be sent",
          advice: process.platform === "win32"
            ? `Stop-Process -Id ${serverState.pid} -Force`
            : `kill -9 ${serverState.pid}`
        });
      }
    }
  }

  const ingestPid = await readPid(getIngestPidPathLocal(env));
  let ingestStopped = false;
  let ingestDead = true;
  if (ingestPid !== undefined && isAlive(ingestPid)) {
    logMsg(log(), "debug", "teardown.stopping_ingest_daemon", { pid: ingestPid });
    // On Windows, headless daemon processes (no message loop) ignore taskkill
    // without /F. Skip the graceful attempt and force-kill directly.
    const forceFirst = process.platform === "win32";
    const killed = kill(ingestPid, forceFirst);
    if (killed) {
      ingestDead = await waitForDeath(ingestPid, isAlive, waitTimeout);
      if (ingestDead) {
        ingestStopped = true;
      } else {
        if (!forceFirst) kill(ingestPid, true);
        ingestDead = await waitForDeath(ingestPid, isAlive, Math.min(waitTimeout, 2000));
        if (ingestDead) {
          ingestStopped = true;
        } else {
          failures.push({
            component: "ingest daemon",
            pid: ingestPid,
            reason: "process did not terminate after force kill",
            advice: process.platform === "win32"
              ? `Stop-Process -Id ${ingestPid} -Force`
              : `kill -9 ${ingestPid}`
          });
        }
      }
    } else {
      ingestDead = false;
      failures.push({
        component: "ingest daemon",
        pid: ingestPid,
        reason: "kill signal could not be sent",
        advice: process.platform === "win32"
          ? `Stop-Process -Id ${ingestPid} -Force`
          : `kill -9 ${ingestPid}`
      });
    }
  }

  const uplinkPid = await readPid(getUplinkPidPath(env));
  let uplinkStopped = false;
  let uplinkDead = true;
  if (uplinkPid !== undefined && isAlive(uplinkPid)) {
    logMsg(log(), "debug", "teardown.stopping_uplink_daemon", { pid: uplinkPid });
    const forceFirstUplink = process.platform === "win32";
    const killed = kill(uplinkPid, forceFirstUplink);
    if (killed) {
      uplinkDead = await waitForDeath(uplinkPid, isAlive, waitTimeout);
      if (uplinkDead) {
        uplinkStopped = true;
      } else {
        if (!forceFirstUplink) kill(uplinkPid, true);
        uplinkDead = await waitForDeath(uplinkPid, isAlive, Math.min(waitTimeout, 2000));
        if (uplinkDead) {
          uplinkStopped = true;
        } else {
          failures.push({
            component: "uplink daemon",
            pid: uplinkPid,
            reason: "process did not terminate after force kill",
            advice: process.platform === "win32"
              ? `Stop-Process -Id ${uplinkPid} -Force`
              : `kill -9 ${uplinkPid}`
          });
        }
      }
    } else {
      uplinkDead = false;
      failures.push({
        component: "uplink daemon",
        pid: uplinkPid,
        reason: "kill signal could not be sent",
        advice: process.platform === "win32"
          ? `Stop-Process -Id ${uplinkPid} -Force`
          : `kill -9 ${uplinkPid}`
      });
    }
  }

  // --- Remove beacon files (only if owning process is confirmed dead) ---
  if (serverStopped) logMsg(log(), "debug", "teardown.dashboard_server_stopped", { pid: serverState?.pid });
  if (ingestStopped) logMsg(log(), "debug", "teardown.ingest_daemon_stopped", { pid: ingestPid });
  if (uplinkStopped) logMsg(log(), "debug", "teardown.uplink_daemon_stopped", { pid: uplinkPid });
  for (const failure of failures) {
    logMsg(log(), "warn", "teardown.failed_to_stop_daemon", {
      daemon: failure.component,
      pid: failure.pid,
      reason: failure.reason
    });
  }

  const removed: string[] = [];
  const beaconOwners: Array<{ path: string; pid?: number; dead: boolean }> = [
    { path: getServerStatePath(env), pid: serverState?.pid, dead: serverDead },
    { path: getIngestStatePath(env), pid: ingestPid, dead: ingestDead },
    { path: getIngestPidPathLocal(env), pid: ingestPid, dead: ingestDead },
    { path: getUplinkPidPath(env), pid: uplinkPid, dead: uplinkDead },
    { path: getShutdownRequestPath(env), pid: undefined, dead: true }
  ];

  for (const { path, pid, dead } of beaconOwners) {
    const exists = await stat(path).then(() => true, () => false);
    if (!exists) continue;
    if (!dead && pid !== undefined) {
      staleFiles.push({ path, pid });
      logMsg(log(), "warn", "teardown.beacon_retained_owner_alive", { path, pid });
    } else {
      await removeFile(path);
      removed.push(path);
      logMsg(log(), "debug", "teardown.removed_beacon", { path });
    }
  }

  logMsg(log(), "debug", "teardown.local_dashboard_stack_teardown_complete", {
    serverStopped,
    ingestStopped,
    uplinkStopped,
    removed: removed.length,
    failures: failures.length,
    staleFiles: staleFiles.length
  });

  return { serverStopped, ingestStopped, uplinkStopped, removed, failures, staleFiles };
}
