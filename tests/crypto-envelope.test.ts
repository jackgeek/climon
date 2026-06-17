import { describe, expect, test } from "bun:test";
import {
  ENVELOPE_SCHEME,
  decryptEnvelope,
  encryptEnvelope,
} from "../src/update/crypto-envelope.js";

describe("crypto-envelope", () => {
  test("round-trips plaintext with the correct password", () => {
    const data = new TextEncoder().encode("hello climon");
    const env = encryptEnvelope(data, "s3cret");
    const res = decryptEnvelope(env, "s3cret");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(new TextDecoder().decode(res.bytes)).toBe("hello climon");
    }
  });

  test("round-trips empty plaintext", () => {
    const env = encryptEnvelope(new Uint8Array(0), "pw");
    const res = decryptEnvelope(env, "pw");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bytes.byteLength).toBe(0);
  });

  test("wrong password fails with wrong-password reason", () => {
    const env = encryptEnvelope(new TextEncoder().encode("x"), "right");
    const res = decryptEnvelope(env, "wrong");
    expect(res).toEqual({ ok: false, reason: "wrong-password" });
  });

  test("malformed envelope fails with malformed reason", () => {
    const res = decryptEnvelope(new Uint8Array([1, 2, 3]), "x");
    expect(res).toEqual({ ok: false, reason: "malformed" });
  });

  test("each encryption uses a fresh salt + nonce", () => {
    const data = new TextEncoder().encode("same");
    const a = encryptEnvelope(data, "pw");
    const b = encryptEnvelope(data, "pw");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test("scheme id is stable", () => {
    expect(ENVELOPE_SCHEME).toBe("aes-256-gcm-scrypt-v1");
  });
});
