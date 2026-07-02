/**
 * ⚠️ SHARED SOURCE OF TRUTH — do NOT delete with the rest of the legacy client.
 *
 * The rest of the Bun/TypeScript self-updater has been removed; the shipping
 * updater lives in the Rust crate `rust/climon-update`. This file is retained
 * because `rust/climon-update/build.rs` reads `UPDATE_PUBLIC_KEY_B64` from here
 * at build time so the Rust updater embeds the exact same base64 Ed25519 public
 * key. Deleting this file breaks the Rust client build. `scripts/gen-update-keys.ts`
 * also documents this file as the place to store the public key.
 */
/**
 * Base64 of the 32-byte raw Ed25519 public key used to verify update artifacts.
 * REPLACE this placeholder with the real public key from `scripts/gen-update-keys.ts`
 * before shipping signed releases. An empty value disables verification-backed
 * updates (the updater refuses to apply unverifiable downloads).
 */
export const UPDATE_PUBLIC_KEY_B64 =
  "MTrrT1WssqQuGrVEBPqZWKqPifHo2xZXgByXLAX0l/o=";
