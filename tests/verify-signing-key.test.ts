import { describe, expect, test } from "bun:test";
import { generateUpdateKeypair } from "../scripts/gen-update-keys.js";
import { verifySigningKey } from "../scripts/verify-signing-key.js";

describe("verifySigningKey", () => {
  test("returns ok when the private key matches the public key", async () => {
    const kp = await generateUpdateKeypair();
    const result = verifySigningKey({
      privateKeyPkcs8B64: kp.privateKeyPkcs8B64,
      expectedPublicKeyB64: kp.publicKeyB64
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publicKeyB64).toBe(kp.publicKeyB64);
    }
  });

  test("fails with reason 'mismatch' when the keys don't correspond", async () => {
    const a = await generateUpdateKeypair();
    const b = await generateUpdateKeypair();
    const result = verifySigningKey({
      privateKeyPkcs8B64: a.privateKeyPkcs8B64,
      expectedPublicKeyB64: b.publicKeyB64
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "mismatch") {
      expect(result.derivedPublicKeyB64).toBe(a.publicKeyB64);
      expect(result.expectedPublicKeyB64).toBe(b.publicKeyB64);
    } else {
      throw new Error(`expected mismatch, got ${JSON.stringify(result)}`);
    }
  });

  test("fails with reason 'missing' when the private key is empty", async () => {
    const kp = await generateUpdateKeypair();
    const result = verifySigningKey({
      privateKeyPkcs8B64: "   ",
      expectedPublicKeyB64: kp.publicKeyB64
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing");
    }
  });
});
