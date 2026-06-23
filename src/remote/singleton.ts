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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface SingletonResult {
  acquired: boolean;
  /** PID of the existing holder when acquired is false. */
  holder?: number;
}

/** Returns true if this process now owns the singleton, false if another live instance holds it. */
export async function acquireSingleton(pidFile: string): Promise<boolean> {
  const result = await acquireSingletonDetailed(pidFile);
  return result.acquired;
}

/** Like acquireSingleton but returns the blocking PID for diagnostics. */
export async function acquireSingletonDetailed(pidFile: string): Promise<SingletonResult> {
  try {
    const existing = await readFile(pidFile, "utf8");
    const pid = Number.parseInt(existing.trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      return { acquired: false, holder: pid };
    }
  } catch {
    // No (or unreadable) pidfile: we may proceed.
  }
  await mkdir(dirname(pidFile), { recursive: true, mode: 0o700 });
  await writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 });
  return { acquired: true };
}
