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
export const MUX_IDLE_TIMEOUT_FACTOR = 3;

export function muxIdleTimeoutMs(keepAliveMs: number): number {
  if (!Number.isFinite(keepAliveMs) || keepAliveMs <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(keepAliveMs * MUX_IDLE_TIMEOUT_FACTOR));
}
