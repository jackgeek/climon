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
import {
  chmodSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type SwapResult = {
  /** True when the new bytes are now in place. */
  applied: boolean;
  /** True when application was deferred because the file was locked. */
  deferred: boolean;
};

/**
 * Atomically replaces `dir/name` with `bytes` without killing any process.
 *
 * Unix: write a temp file in the same directory, then rename() over the target.
 * The rename is atomic and running processes keep their old inode until they
 * exit, so live sessions are never disrupted.
 *
 * Windows: a running executable cannot be overwritten or renamed away while
 * locked, but a NON-running target can. We write a temp file, try to displace
 * any existing target to `name.old`, then rename the temp into place. If the
 * displace fails because the file is locked (EBUSY/EPERM/EACCES), we defer
 * rather than kill, leaving the current binary untouched.
 *
 * The replacement preserves the existing target's permission bits (or defaults
 * to 0o755) so the swapped-in binary stays executable.
 */
export function replaceFileAtomic(
  dir: string,
  name: string,
  bytes: Uint8Array
): SwapResult {
  const target = join(dir, name);
  const tmp = join(dir, `${name}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, bytes);

  try {
    // Preserve the target's mode (these are executables); default to 0o755.
    let mode = 0o755;
    try {
      if (existsSync(target)) mode = statSync(target).mode & 0o777;
    } catch {
      // Unreadable target; fall back to the executable default.
    }
    try {
      chmodSync(tmp, mode);
    } catch {
      // Best effort; some filesystems ignore chmod.
    }

    if (process.platform === "win32") {
      const old = join(dir, `${name}.old`);
      try {
        if (existsSync(old)) rmSync(old, { force: true });
      } catch {
        // A previous .old still locked; ignore and continue.
      }
      let displaced = false;
      try {
        if (existsSync(target)) {
          renameSync(target, old);
          displaced = true;
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
          return { applied: false, deferred: true };
        }
        throw err;
      }
      try {
        renameSync(tmp, target);
      } catch (err) {
        // Final rename failed after displacing; restore the prior binary so the
        // install is never left with no executable at the expected path.
        if (displaced) {
          try {
            renameSync(old, target);
          } catch {
            // Leave .old in place for manual/next-run recovery.
          }
        }
        throw err;
      }
      return { applied: true, deferred: false };
    }

    // Unix: atomic rename-over.
    renameSync(tmp, target);
    return { applied: true, deferred: false };
  } finally {
    // Remove the temp on any path that didn't consume it (defer/error).
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      // Best effort.
    }
  }
}

/** Best-effort cleanup of leftover `.old` files from prior Windows swaps. */
export function cleanupOldFiles(dir: string, names: string[]): void {
  for (const name of names) {
    const old = join(dir, `${name}.old`);
    try {
      if (existsSync(old)) unlinkSync(old);
    } catch {
      // Still locked by a running process; try again next time.
    }
  }
}
