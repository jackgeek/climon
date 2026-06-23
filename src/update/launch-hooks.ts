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
import { t } from "../i18n/t.js";
import { VERSION } from "../version.js";
import { compareSemver } from "./manifest.js";
import { getAvailableVersion, isAutoUpdate, shouldCheck } from "./state.js";

/**
 * Prints a one-line banner when a newer version is cached. When auto-update is
 * enabled, it does NOT auto-apply inline (which could disrupt the session start);
 * applying happens via `climon update`, spawned detached below for auto mode.
 */
export async function maybeShowUpdateBanner(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const next = getAvailableVersion(env);
  // Re-compare against the running version: the cache can be stale-equal (e.g.
  // after an out-of-band reinstall) and must not trigger a banner or a download.
  if (!next || compareSemver(next, VERSION) <= 0) return;
  if (isAutoUpdate(env)) {
    // Auto mode: apply in a detached child so the session starts immediately and
    // running sessions are never interrupted (the swap is non-destructive).
    spawnDetachedUpdate(process.execPath, env);
    return;
  }
  process.stderr.write(t("update.banner", { current: VERSION, next }) + "\n");
}

/** Spawns a detached background version check at most once per interval. */
export function maybeSpawnBackgroundCheck(
  execPath: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!shouldCheck(env)) return;
  const child = spawn(execPath, ["__update-check"], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
}

function spawnDetachedUpdate(execPath: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(execPath, ["update"], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
}
