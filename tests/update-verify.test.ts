import { describe, expect, test } from "bun:test";
import { verifySignature } from "../src/update/verify.js";

async function makeKeypair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { kp, pubB64: Buffer.from(rawPub).toString("base64") };
}

describe("verifySignature", () => {
  test("accepts a valid signature", async () => {
    const { kp, pubB64 } = await makeKeypair();
    const data = new TextEncoder().encode("hello climon");
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", kp.privateKey, data)
    );
    const sigB64 = Buffer.from(sig).toString("base64");
    expect(await verifySignature(data, sigB64, pubB64)).toBe(true);
  });

  test("rejects a tampered payload", async () => {
    const { kp, pubB64 } = await makeKeypair();
    const data = new TextEncoder().encode("hello climon");
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", kp.privateKey, data)
    );
    const sigB64 = Buffer.from(sig).toString("base64");
    const tampered = new TextEncoder().encode("hello climoN");
    expect(await verifySignature(tampered, sigB64, pubB64)).toBe(false);
  });

  test("returns false for an empty public key", async () => {
    const data = new TextEncoder().encode("x");
    expect(await verifySignature(data, "AAAA", "")).toBe(false);
  });
});
