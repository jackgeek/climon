import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { runUpdateCommand } from "../src/update/update-cmd.js";
import type { Manifest } from "../src/update/manifest.js";

let dir: string;
let installDir: string;
let server: ReturnType<typeof Bun.serve>;
let keypair: CryptoKeyPair;
let pubB64: string;

async function sign(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const sig = new Uint8Array(
    await crypto.subtle.sign("Ed25519", keypair.privateKey, copy.buffer)
  );
  return Buffer.from(sig).toString("base64");
}

function arch(): string {
  return process.arch === "arm64" ? "arm64" : "x64";
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "climon-upd-"));
  installDir = join(dir, "bin");
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, "climon"), "old-binary");
  writeFileSync(join(installDir, "climon-beta"), "old-beta");

  keypair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  pubB64 = Buffer.from(
    await crypto.subtle.exportKey("raw", keypair.publicKey)
  ).toString("base64");

  const zipBytes = zipSync({
    install: new TextEncoder().encode("new-binary"),
    "climon-beta": new TextEncoder().encode("new-beta"),
  });
  const sigB64 = await sign(zipBytes);

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/artifact.zip") return new Response(zipBytes);
      if (path === "/artifact.zip.sig") return new Response(sigB64);
      return new Response("nope", { status: 404 });
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("runUpdateCommand", () => {
  test("verified update replaces install files on Unix", async () => {
    if (process.platform === "win32") return;
    const base = `http://localhost:${server.port}`;
    const manifest: Manifest = {
      version: "0.99.0",
      artifacts: {
        [`linux-${arch()}`]: {
          url: `${base}/artifact.zip`,
          sig: `${base}/artifact.zip.sig`,
        },
      },
    };
    const result = await runUpdateCommand({
      installDir,
      currentVersion: "0.12.1",
      manifest,
      publicKeyB64: pubB64,
      platform: "linux",
      print: () => {},
    });
    expect(result.status).toBe("updated");
    expect(readFileSync(join(installDir, "climon"), "utf8")).toBe("new-binary");
    expect(readFileSync(join(installDir, "climon-beta"), "utf8")).toBe("new-beta");
  });

  test("tampered artifact is rejected and files are unchanged", async () => {
    if (process.platform === "win32") return;
    const base = `http://localhost:${server.port}`;
    const manifest: Manifest = {
      version: "0.99.0",
      artifacts: {
        [`linux-${arch()}`]: {
          url: `${base}/artifact.zip`,
          sig: `${base}/artifact.zip.sig`,
        },
      },
    };
    const result = await runUpdateCommand({
      installDir,
      currentVersion: "0.12.1",
      manifest,
      publicKeyB64: "AAAA", // wrong key -> verification fails
      platform: "linux",
      print: () => {},
    });
    expect(result.status).toBe("verify-failed");
    expect(readFileSync(join(installDir, "climon"), "utf8")).toBe("old-binary");
  });

  test("already up to date is a no-op", async () => {
    const result = await runUpdateCommand({
      installDir,
      currentVersion: "0.99.0",
      manifest: { version: "0.99.0", artifacts: {} },
      publicKeyB64: pubB64,
      platform: "linux",
      print: () => {},
    });
    expect(result.status).toBe("up-to-date");
  });
});
