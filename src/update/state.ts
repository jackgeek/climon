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
import { readGlobalConfigSetting, writeConfigSetting } from "../config.js";

/** True when enough time has passed since the last recorded check. */
export function shouldCheck(
  env: NodeJS.ProcessEnv = process.env,
  intervalMs: number = 24 * 60 * 60 * 1000
): boolean {
  const last = readGlobalConfigSetting("update.lastCheck", env);
  if (typeof last !== "string" || last.length === 0) return true;
  const lastMs = Date.parse(last);
  if (Number.isNaN(lastMs)) return true;
  return Date.now() - lastMs >= intervalMs;
}

/** Records that a check happened now. */
export function recordCheck(env: NodeJS.ProcessEnv = process.env): void {
  writeConfigSetting("update.lastCheck", new Date().toISOString(), "global", env);
}

/** Returns the cached available (newer) version, if any. */
export function getAvailableVersion(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const v = readGlobalConfigSetting("update.availableVersion", env);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Caches a discovered newer version for banner display. */
export function setAvailableVersion(
  version: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  writeConfigSetting("update.availableVersion", version, "global", env);
}

/** Clears the cached available version (e.g. after a successful update). */
export function clearAvailableVersion(
  env: NodeJS.ProcessEnv = process.env
): void {
  writeConfigSetting("update.availableVersion", "", "global", env);
}

/** True when auto-update is enabled. */
export function isAutoUpdate(env: NodeJS.ProcessEnv = process.env): boolean {
  return readGlobalConfigSetting("update.auto", env) === true;
}
