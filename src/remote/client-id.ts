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
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { resolveConfigSetting } from "../config.js";

/**
 * Coerces an arbitrary string into a valid clientId: letters, digits, dots,
 * hyphens, underscores; 1-64 chars; no leading/trailing hyphens. Falls back to
 * a random `dev-<hex>` id when nothing valid remains.
 */
export function sanitizeClientId(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : `dev-${randomBytes(5).toString("hex")}`;
}

/** The per-host default clientId: the sanitised machine hostname. */
export function defaultClientId(): string {
  return sanitizeClientId(hostname());
}

/**
 * Resolves this machine's clientId: the configured `remote.clientId` if set,
 * otherwise the sanitised hostname. Does not persist anything.
 */
export function resolveClientId(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string {
  const configured = resolveConfigSetting("remote.clientId", env, cwd);
  if (typeof configured === "string" && configured.length > 0) {
    return configured;
  }
  return defaultClientId();
}
