import { teardownLocalServerStack } from "../remote/teardown.js";

export interface CleanupCommandOptions {
  env?: NodeJS.ProcessEnv;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, force: boolean) => boolean;
  stdout?: (chunk: string) => void;
}

/**
 * `climon cleanup`: stop this OS's dashboard server, ingest, and uplink, and
 * remove their beacons. Local-only — it cannot stop the peer OS's processes.
 */
export async function runCleanupCommand(options: CleanupCommandOptions = {}): Promise<number> {
  const write = options.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const report = await teardownLocalServerStack({
    env: options.env,
    isProcessAlive: options.isProcessAlive,
    killProcess: options.killProcess
  });

  const lines: string[] = [];
  if (report.serverStopped) lines.push("Stopped dashboard server.");
  if (report.ingestStopped) lines.push("Stopped ingest daemon.");
  if (report.uplinkStopped) lines.push("Stopped uplink daemon.");

  if (lines.length === 0) {
    write("Nothing to clean up — no local climon daemons were running.\n");
    return 0;
  }
  for (const line of lines) write(`${line}\n`);
  write("Removed local server.json, ingest.json, and pidfiles.\n");
  return 0;
}