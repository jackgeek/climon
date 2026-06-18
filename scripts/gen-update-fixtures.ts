import { encryptEnvelope } from "../src/update/crypto-envelope.ts";
import { writeFileSync } from "node:fs";

const enc = new TextEncoder();

// 1) Ed25519 signed payload (detached) with a generated test key.
const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const data = enc.encode("climon update fixture payload v1");
const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, data));
writeFileSync(
  "fixtures/update/signed-payload.json",
  JSON.stringify(
    {
      description: "Bun-produced detached Ed25519 signature over `data` (base64).",
      publicKeyB64: Buffer.from(rawPub).toString("base64"),
      dataB64: Buffer.from(data).toString("base64"),
      signatureB64: Buffer.from(sig).toString("base64"),
    },
    null,
    2
  ) + "\n"
);

// 2) Bun-produced encryption envelope (fixed-input decrypt vector for Rust).
const password = "fixture-shared-pw";
const plaintext = enc.encode("the quick brown climon");
const envelope = encryptEnvelope(plaintext, password);
writeFileSync(
  "fixtures/update/bun-envelope.json",
  JSON.stringify(
    {
      description:
        "Bun-produced aes-256-gcm-scrypt-v1 envelope; Rust must decrypt to plaintext.",
      scheme: "aes-256-gcm-scrypt-v1",
      password,
      plaintextB64: Buffer.from(plaintext).toString("base64"),
      envelopeHex: Buffer.from(envelope).toString("hex"),
    },
    null,
    2
  ) + "\n"
);

// 3) Sample manifest parsed identically by both implementations.
writeFileSync(
  "fixtures/update/manifest.json",
  JSON.stringify(
    {
      version: "0.99.0",
      encryption: "aes-256-gcm-scrypt-v1",
      artifacts: {
        "linux-x64": {
          url: "https://example.test/linux-x64.zip.enc",
          sig: "https://example.test/linux-x64.zip.sig",
        },
        "darwin-arm64": {
          url: "https://example.test/darwin-arm64.zip.enc",
          sig: "https://example.test/darwin-arm64.zip.sig",
        },
      },
    },
    null,
    2
  ) + "\n"
);

console.log("wrote fixtures/update/{signed-payload,bun-envelope,manifest}.json");
