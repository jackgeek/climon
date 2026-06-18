import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decryptEnvelope,
  encryptEnvelope,
} from "../src/update/crypto-envelope.js";
import { verifySignature } from "../src/update/verify.js";
import { fetchManifest } from "../src/update/manifest.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "update");

function load(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "hex"));
}

describe("cross-language signature parity", () => {
  const fixture = load("signed-payload.json");

  test("Bun verifies its own fixture signature", async () => {
    const ok = await verifySignature(
      fromB64(fixture.dataB64),
      fixture.signatureB64,
      fixture.publicKeyB64
    );
    expect(ok).toBe(true);
  });

  test("tampered payload is rejected", async () => {
    const data = fromB64(fixture.dataB64);
    const tampered = new Uint8Array(data);
    tampered[0] ^= 0x01;
    const ok = await verifySignature(
      tampered,
      fixture.signatureB64,
      fixture.publicKeyB64
    );
    expect(ok).toBe(false);
  });
});

describe("cross-language envelope parity", () => {
  test("Bun decrypts the Rust-produced envelope (Rust -> Bun)", () => {
    const f = load("rust-envelope.json");
    const res = decryptEnvelope(fromHex(f.envelopeHex), f.password);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Buffer.from(res.bytes).toString("base64")).toBe(f.plaintextB64);
    }
  });

  test("Bun decrypts its own committed envelope vector", () => {
    const f = load("bun-envelope.json");
    const res = decryptEnvelope(fromHex(f.envelopeHex), f.password);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Buffer.from(res.bytes).toString("base64")).toBe(f.plaintextB64);
    }
  });

  test("Bun round-trips its own envelope (sanity)", () => {
    const data = new TextEncoder().encode("round-trip climon");
    const env = encryptEnvelope(data, "pw");
    const res = decryptEnvelope(env, "pw");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(new TextDecoder().decode(res.bytes)).toBe("round-trip climon");
    }
  });
});

describe("cross-language manifest parity", () => {
  async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await fn();
    } finally {
      globalThis.fetch = original;
    }
  }

  test("Bun parses the shared manifest fixture", async () => {
    const raw = readFileSync(join(FIXTURES, "manifest.json"), "utf8");
    const manifest = await withFetch(
      (async () => new Response(raw, { status: 200 })) as unknown as typeof fetch,
      () => fetchManifest("https://example.test/manifest.json")
    );
    expect(manifest.version).toBe("0.99.0");
    expect(manifest.encryption).toBe("aes-256-gcm-scrypt-v1");
    expect(manifest.artifacts["linux-x64"].url).toContain("linux-x64");
    expect(manifest.artifacts["darwin-arm64"].sig).toContain("darwin-arm64");
  });
});
