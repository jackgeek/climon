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
import { teardownLocalServerStack } from "../remote/teardown.js";
import { writeStdout, writeStderr } from "../logging/cli-io.js";

export interface CleanupCommandOptions {
  env?: NodeJS.ProcessEnv;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, force: boolean) => boolean;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  waitTimeoutMs?: number;
}

/**
 * `climon cleanup`: stop this OS's dashboard server, ingest, and uplink, and
 * remove their beacons. Verifies each process is actually dead before removing
 * its beacon, and reports problems with manual remediation advice.
 */
export async function runCleanupCommand(options: CleanupCommandOptions = {}): Promise<number> {
  const write = options.stdout ?? ((chunk: string) => writeStdout(chunk));
  const writeErr = options.stderr ?? ((chunk: string) => writeStderr(chunk));
  const report = await teardownLocalServerStack({
    env: options.env,
    isProcessAlive: options.isProcessAlive,
    killProcess: options.killProcess,
    waitTimeoutMs: options.waitTimeoutMs
  });

  let hadProblems = false;
  const lines: string[] = [];

  if (report.serverStopped) lines.push("Stopped dashboard server.");
  if (report.ingestStopped) lines.push("Stopped ingest daemon.");
  if (report.uplinkStopped) lines.push("Stopped uplink daemon.");

  if (report.removed.length > 0) {
    for (const path of report.removed) {
      lines.push(`Removed ${path}`);
    }
  }

  // Report failures
  for (const failure of report.failures) {
    hadProblems = true;
    writeErr(`WARNING: ${failure.component} (pid ${failure.pid}): ${failure.reason}\n`);
    if (failure.advice) writeErr(`  → ${failure.advice}\n`);
  }

  // Report files that could not be removed because the process is still alive
  for (const stale of report.staleFiles) {
    hadProblems = true;
    writeErr(`WARNING: Cannot remove ${stale.path} — process ${stale.pid} is still running.\n`);
    writeErr(`  → Kill it manually: ${platformKillAdvice(stale.pid)}\n`);
  }

  if (lines.length === 0 && !hadProblems) {
    write("Nothing to clean up — no local climon daemons were running.\n");
    return 0;
  }
  for (const line of lines) write(`${line}\n`);
  return hadProblems ? 1 : 0;
}

function platformKillAdvice(pid: number): string {
  if (process.platform === "win32") {
    return `Stop-Process -Id ${pid} -Force`;
  }
  return `kill -9 ${pid}`;
}