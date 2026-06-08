/**
 * Debug logging for remote connection troubleshooting.
 * Enabled by setting CLIMON_DEBUG=1 (or any truthy value).
 *
 * Logs are written to BOTH stderr (when connected) AND a rotating log file at
 * `$CLIMON_HOME/remote-debug.log`. This ensures detached daemon processes
 * (ingest, uplink) — whose stdio is /dev/null — still produce traceable output.
 *
 * View logs with: cat ~/.climon/remote-debug.log
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getClimonHome } from "../config.js";

const enabled = !!process.env.CLIMON_DEBUG;

let logFilePath: string | undefined;

function getLogFile(): string {
  if (!logFilePath) {
    const home = getClimonHome();
    mkdirSync(home, { recursive: true });
    logFilePath = join(home, "remote-debug.log");
  }
  return logFilePath;
}

function timestamp(): string {
  return new Date().toISOString();
}

function makeLogger(component: string) {
  const prefix = `climon:${component}`;
  return (message: string, ...args: unknown[]): void => {
    if (!enabled) return;
    const extra = args.length > 0
      ? " " + args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")
      : "";
    const line = `[${timestamp()}] ${prefix} (pid=${process.pid}): ${message}${extra}\n`;
    // Write to stderr if it's writable (not the case for detached daemons)
    try { process.stderr.write(line); } catch { /* stdio not connected */ }
    // Always append to log file so detached processes leave a trace
    try { appendFileSync(getLogFile(), line); } catch { /* best effort */ }
  };
}

export const debugUplink = makeLogger("uplink");
export const debugIngest = makeLogger("ingest");
export const debugDiscovery = makeLogger("discovery");
export const debugMux = makeLogger("mux");
