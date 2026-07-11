import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

/** Released v3.1.3 source containing the real legacy install -> climon updater mapping. */
export const LEGACY_UPDATER_COMMIT =
  "3aca69df1420ff4954c4348ccea01980cb681635";
export const LEGACY_VERSION = "3.1.3";

export type HarnessPlatform = "win32" | "darwin" | "linux";
export type CurrentLayoutKind = "windows-stub" | "unix";

export function legacyInstalledEntries(platform: HarnessPlatform): string[] {
  const exe = platform === "win32" ? ".exe" : "";
  return [`climon${exe}`, `climon-server${exe}`];
}

export function currentLayoutKind(platform: HarnessPlatform): CurrentLayoutKind {
  return platform === "win32" ? "windows-stub" : "unix";
}

export function hostHarnessPlatform(): HarnessPlatform {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

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

/** Asserts the current Unix layout and exact installed version marker. */
export function assertUnixLayout(dir: string, version: string): void {
  requireFiles(dir, ["climon", "climon-server", ".version"]);
  const installed = readFileSync(join(dir, ".version"), "utf8").trim();
  if (installed !== version) {
    throw new Error(`.version = ${installed}, expected ${version}`);
  }
  for (const name of ["climon.version", "climon-server.version", "climon.dll"]) {
    if (existsSync(join(dir, name))) {
      throw new Error(`unexpected ${name} in Unix install dir ${dir}`);
    }
  }
}

/** Asserts the installer-owned current layout for a host platform. */
export function assertCurrentLayout(
  dir: string,
  version: string,
  platform: HarnessPlatform = hostHarnessPlatform()
): void {
  if (currentLayoutKind(platform) === "windows-stub") {
    assertStubLayout(dir, version);
  } else {
    assertUnixLayout(dir, version);
  }
}

/** Asserts a legacy installed layout with no current-layout version pointers. */
export function assertLegacyLayout(
  dir: string,
  platform: HarnessPlatform = hostHarnessPlatform()
): void {
  if (existsSync(join(dir, "climon.version"))) {
    throw new Error(`unexpected climon.version pointer in legacy dir ${dir}`);
  }
  if (existsSync(join(dir, ".version"))) {
    throw new Error(`unexpected .version marker in legacy dir ${dir}`);
  }
  if (existsSync(join(dir, "climon.dll"))) {
    throw new Error(`unexpected climon.dll in legacy dir ${dir}`);
  }
  requireFiles(dir, legacyInstalledEntries(platform));
}

/** Returns a stable byte snapshot of the flat install directory. */
export function snapshotInstallDir(dir: string): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isFile()) {
      snapshot.set(name, readFileSync(path));
    }
  }
  return snapshot;
}

export function assertInstallSnapshot(
  actualDir: string,
  expected: Map<string, Buffer>
): void {
  const actual = snapshotInstallDir(actualDir);
  if (
    actual.size !== expected.size ||
    [...expected].some(
      ([name, bytes]) => !actual.get(name)?.equals(bytes)
    )
  ) {
    throw new Error(`install directory changed unexpectedly: ${actualDir}`);
  }
}

/** Fails closed unless released v3.1.3 maps install[.exe] to climon[.exe]. */
export function assertReleasedLegacyUpdaterMapping(source: string): void {
  const normalized = source.replace(/\s+/g, " ");
  const client =
    'source: format!("install{exe}"), dest: format!("climon{exe}"),';
  const server =
    'source: format!("climon-server{exe}"), dest: format!("climon-server{exe}"),';
  if (!normalized.includes(client) || !normalized.includes(server)) {
    throw new Error(
      "released v3.1.3 updater mapping shape is absent; refusing to build fixture"
    );
  }
}

/** Replaces exactly one source occurrence, failing on source drift. */
export function replaceExactlyOnce(
  source: string,
  expected: string,
  replacement: string,
  label: string
): string {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`expected exactly one ${label} occurrence`);
  }
  return source.slice(0, first) + replacement + source.slice(first + expected.length);
}

/**
 * Serves the signed release dir (manifest.json + climon-*.zip + *.sig) over
 * loopback only. Returns the server and the base URL (e.g. http://127.0.0.1:5599).
 */
export async function serveDir(
  dir: string
): Promise<{ server: Server; baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0].replace(/^\//, ""));
    requests.push(name);
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
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, requests };
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
