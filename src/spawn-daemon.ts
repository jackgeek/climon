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
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { getSessionsDir } from "./config.js";
import { selfSpawnArgs } from "./self-spawn.js";

/**
 * Spawns a detached per-session daemon (`climon __session <id>`) that owns the
 * PTY and survives the launcher exiting. The daemon's raw stdio is redirected to
 * `<sessionsDir>/<id>.log` to capture uncaught crash output; structured pino
 * logs are written separately to `$CLIMON_HOME/logs/daemon/<id>.log`.
 * `windowsHide` prevents a console window flashing on Windows; the parent's log
 * fd is closed after the child inherits it.
 */
export function spawnDaemon(id: string, env: NodeJS.ProcessEnv): void {
  const logPath = join(getSessionsDir(env), `${id}.log`);
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, selfSpawnArgs(["__session", id]), {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}
