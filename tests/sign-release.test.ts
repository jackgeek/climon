import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signReleaseDir } from "../scripts/sign-release.js";
import { generateUpdateKeypair } from "../scripts/gen-update-keys.js";
import { verifySignature } from "../src/update/verify.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "climon-sign-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("signReleaseDir", () => {
  test("writes a .sig per zip and a manifest.json with verifiable signatures", async () => {
    const distDir = join(dir, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "climon-linux-x64.zip"), "zip-bytes-1");
    writeFileSync(join(distDir, "climon-windows-x64.zip"), "zip-bytes-2");

    const { publicKeyB64, privateKeyPkcs8B64 } = await generateUpdateKeypair();
    await signReleaseDir({
      distDir,
      version: "1.2.3",
      privateKeyPkcs8B64,
      baseUrl: "https://example.test/download",
    });

    const sig = readFileSync(join(distDir, "climon-linux-x64.zip.sig"), "utf8").trim();
    const ok = await verifySignature(
      new Uint8Array(readFileSync(join(distDir, "climon-linux-x64.zip"))),
      sig,
      publicKeyB64
    );
    expect(ok).toBe(true);

    const manifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8"));
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.artifacts["linux-x64"].url).toBe(
      "https://example.test/download/climon-linux-x64.zip"
    );
    expect(manifest.artifacts["windows-x64"].sig).toBe(
      "https://example.test/download/climon-windows-x64.zip.sig"
    );
  });
});
