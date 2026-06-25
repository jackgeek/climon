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
/**
 * Base64 of the 32-byte raw Ed25519 public key used to verify update artifacts.
 * REPLACE this placeholder with the real public key from `scripts/gen-update-keys.ts`
 * before shipping signed releases. An empty value disables verification-backed
 * updates (the updater refuses to apply unverifiable downloads).
 */
export const UPDATE_PUBLIC_KEY_B64 =
  "MTrrT1WssqQuGrVEBPqZWKqPifHo2xZXgByXLAX0l/o=";
