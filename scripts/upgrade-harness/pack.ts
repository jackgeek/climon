import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

export type TestKeypair = {
  /** Raw 32-byte Ed25519 public key, base64. Matches build.rs CLIMON_UPDATE_PUBKEY_B64. */
  publicKeyRawB64: string;
  /** PKCS8 Ed25519 private key, base64. Matches signReleaseDir's privateKeyPkcs8B64. */
  privateKeyPkcs8B64: string;
};

/** Generates a throwaway Ed25519 keypair for signing local harness zips. */
export async function generateTestKeypair(): Promise<TestKeypair> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  return {
    publicKeyRawB64: Buffer.from(rawPub).toString("base64"),
    privateKeyPkcs8B64: Buffer.from(pkcs8).toString("base64"),
  };
}

/** Throws unless every named file exists in `dir`. */
function requireFiles(dir: string, names: string[]): void {
  for (const n of names) {
    if (!existsSync(join(dir, n))) {
      throw new Error(`expected ${n} in ${dir}`);
    }
  }
}

/**
 * Asserts a Windows stub-layout install: stubs, a versioned DLL + server payload
 * for `version`, and both pointer files reading `version`.
 */
export function assertStubLayout(dir: string, version: string): void {
  requireFiles(dir, [
    "climon.version",
    "climon-server.version",
    "climon.exe",
    "climon-server.exe",
    `climon-${version}.dll`,
    `climon-server-${version}.exe`,
  ]);
  const clientPtr = readFileSync(join(dir, "climon.version"), "utf8").trim();
  const serverPtr = readFileSync(join(dir, "climon-server.version"), "utf8").trim();
  if (clientPtr !== version) {
    throw new Error(`climon.version = ${clientPtr}, expected ${version}`);
  }
  if (serverPtr !== version) {
    throw new Error(`climon-server.version = ${serverPtr}, expected ${version}`);
  }
}

/** Asserts a legacy layout: single climon.exe, no stub pointer files. */
export function assertLegacyLayout(dir: string): void {
  if (existsSync(join(dir, "climon.version"))) {
    throw new Error(`unexpected climon.version pointer in legacy dir ${dir}`);
  }
  if (existsSync(join(dir, "climon.dll"))) {
    throw new Error(`unexpected climon.dll in legacy dir ${dir}`);
  }
  requireFiles(dir, ["climon.exe", "climon-server.exe"]);
}

/**
 * Serves the signed release dir (manifest.json + climon-*.zip + *.sig) over
 * loopback only. Returns the server and the base URL (e.g. http://127.0.0.1:5599).
 */
export async function serveDir(dir: string): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0].replace(/^\//, ""));
    const allowed = new Set(readdirSync(dir));
    if (!allowed.has(name)) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 200;
    res.end(readFileSync(join(dir, name)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind harness server");
  }
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}
