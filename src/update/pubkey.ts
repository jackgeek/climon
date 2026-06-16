/**
 * Base64 of the 32-byte raw Ed25519 public key used to verify update artifacts.
 * REPLACE this placeholder with the real public key from `scripts/gen-update-keys.ts`
 * before shipping signed releases. An empty value disables verification-backed
 * updates (the updater refuses to apply unverifiable downloads).
 */
export const UPDATE_PUBLIC_KEY_B64 =
  "MTrrT1WssqQuGrVEBPqZWKqPifHo2xZXgByXLAX0l/o=";
