import { describe, expect, test } from "bun:test";
import { generateUpdateKeypair } from "../scripts/gen-update-keys.js";

describe("generateUpdateKeypair", () => {
  test("produces a 32-byte raw public key and a usable private key", async () => {
    const { publicKeyB64, privateKeyPkcs8B64 } = await generateUpdateKeypair();
    expect(Buffer.from(publicKeyB64, "base64").length).toBe(32);
    // The PKCS8 private key must import for signing.
    const pk = await crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(privateKeyPkcs8B64, "base64"),
      { name: "Ed25519" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "Ed25519",
      pk,
      new TextEncoder().encode("x")
    );
    expect(new Uint8Array(sig).length).toBe(64);
  });
});
