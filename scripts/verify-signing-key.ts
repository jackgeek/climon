import { createPrivateKey } from "node:crypto";
import { UPDATE_PUBLIC_KEY_B64 } from "../src/update/pubkey.js";

export type VerifySigningKeyInput = {
  /** Base64 PKCS8 Ed25519 private key (from CLIMON_UPDATE_PRIVATE_KEY). */
  privateKeyPkcs8B64: string;
  /** Base64 raw Ed25519 public key the release must verify against. */
  expectedPublicKeyB64: string;
};

export type VerifySigningKeyResult =
  | { ok: true; publicKeyB64: string }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "invalid"; error: string }
  | {
      ok: false;
      reason: "mismatch";
      derivedPublicKeyB64: string;
      expectedPublicKeyB64: string;
    };

/** Derives the raw base64 Ed25519 public key from a PKCS8 private key. */
function derivePublicKeyB64(privateKeyPkcs8B64: string): string {
  const priv = createPrivateKey({
    key: Buffer.from(privateKeyPkcs8B64, "base64"),
    format: "der",
    type: "pkcs8"
  });
  // An Ed25519 private-key JWK carries the raw public point in `x`, so we can
  // derive the public key without createPublicKey (whose @types/node overload no
  // longer accepts a KeyObject).
  const jwk = priv.export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

/**
 * Checks that the signing private key corresponds to the expected public key.
 * Returns a discriminated result rather than throwing so callers can render a
 * tailored message per failure mode.
 */
export function verifySigningKey(
  input: VerifySigningKeyInput
): VerifySigningKeyResult {
  if (!input.privateKeyPkcs8B64.trim()) {
    return { ok: false, reason: "missing" };
  }
  let derivedPublicKeyB64: string;
  try {
    derivedPublicKeyB64 = derivePublicKeyB64(input.privateKeyPkcs8B64);
  } catch (err) {
    return { ok: false, reason: "invalid", error: String(err) };
  }
  if (derivedPublicKeyB64 !== input.expectedPublicKeyB64) {
    return {
      ok: false,
      reason: "mismatch",
      derivedPublicKeyB64,
      expectedPublicKeyB64: input.expectedPublicKeyB64
    };
  }
  return { ok: true, publicKeyB64: derivedPublicKeyB64 };
}

if (import.meta.main) {
  const result = verifySigningKey({
    privateKeyPkcs8B64: process.env.CLIMON_UPDATE_PRIVATE_KEY ?? "",
    expectedPublicKeyB64: UPDATE_PUBLIC_KEY_B64
  });
  if (result.ok) {
    process.stdout.write(
      `verify-signing-key: OK — signing key matches embedded public key ${result.publicKeyB64}\n`
    );
    process.exit(0);
  }
  switch (result.reason) {
    case "missing":
      process.stderr.write(
        "verify-signing-key: CLIMON_UPDATE_PRIVATE_KEY is empty. The release " +
          "would ship unsigned and clients could not verify updates. Set the " +
          "signing key secret (see scripts/gen-update-keys.ts).\n"
      );
      break;
    case "invalid":
      process.stderr.write(
        `verify-signing-key: CLIMON_UPDATE_PRIVATE_KEY is not a valid base64 ` +
          `PKCS8 Ed25519 private key: ${result.error}\n`
      );
      break;
    case "mismatch":
      process.stderr.write(
        "verify-signing-key: signing key does not match the embedded public key.\n" +
          `  expected (src/update/pubkey.ts): ${result.expectedPublicKeyB64}\n` +
          `  derived from private key:        ${result.derivedPublicKeyB64}\n` +
          "Update CLIMON_UPDATE_PRIVATE_KEY or UPDATE_PUBLIC_KEY_B64 so they " +
          "correspond, then re-run.\n"
      );
      break;
  }
  process.exit(1);
}
