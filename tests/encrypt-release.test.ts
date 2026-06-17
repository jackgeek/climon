import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { encryptReleaseDir } from "../scripts/encrypt-release.js";
import { decryptEnvelope } from "../src/update/crypto-envelope.js";

let dist: string;

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "climon-enc-"));
});

afterEach(() => {
  rmSync(dist, { recursive: true, force: true });
});

describe("encryptReleaseDir", () => {
  test("encrypts each zip and rewrites the manifest", () => {
    const zip = zipSync({ install: new TextEncoder().encode("binary") });
    writeFileSync(join(dist, "climon-linux-x64.zip"), zip);
    writeFileSync(
      join(dist, "manifest.json"),
      JSON.stringify({
        version: "v1.0.0",
        artifacts: {
          "linux-x64": {
            url: "https://example/v1.0.0/climon-linux-x64.zip",
            sig: "https://example/v1.0.0/climon-linux-x64.zip.sig",
          },
        },
      }) + "\n"
    );

    encryptReleaseDir({ distDir: dist, password: "pw" });

    const enc = new Uint8Array(
      readFileSync(join(dist, "climon-linux-x64.zip.enc"))
    );
    const dec = decryptEnvelope(enc, "pw");
    expect(dec.ok).toBe(true);
    if (dec.ok) {
      expect(Buffer.from(dec.bytes).equals(Buffer.from(zip))).toBe(true);
    }

    const manifest = JSON.parse(
      readFileSync(join(dist, "manifest.json"), "utf8")
    );
    expect(manifest.encryption).toBe("aes-256-gcm-scrypt-v1");
    expect(manifest.artifacts["linux-x64"].url).toBe(
      "https://example/v1.0.0/climon-linux-x64.zip.enc"
    );
    expect(manifest.artifacts["linux-x64"].sig).toBe(
      "https://example/v1.0.0/climon-linux-x64.zip.sig"
    );
  });

  test("throws when manifest has no artifacts", () => {
    const zip = zipSync({ install: new TextEncoder().encode("binary") });
    writeFileSync(join(dist, "climon-linux-x64.zip"), zip);
    writeFileSync(
      join(dist, "manifest.json"),
      JSON.stringify({ version: "v1.0.0" }) + "\n"
    );

    expect(() =>
      encryptReleaseDir({ distDir: dist, password: "pw" })
    ).toThrow("encrypt-release: manifest.json has no artifacts");
  });
});
