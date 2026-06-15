import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SignReleaseOptions = {
  distDir: string;
  version: string;
  /** Base64 PKCS8 Ed25519 private key (from CLIMON_UPDATE_PRIVATE_KEY). */
  privateKeyPkcs8B64: string;
  /** Base URL where artifacts will be hosted (release download base). */
  baseUrl: string;
};

/** Maps a zip filename to its manifest artifact key, e.g. linux-x64. */
function artifactKeyFromZip(name: string): string {
  // climon-linux-x64.zip -> linux-x64 ; windows-x64 stays windows-x64.
  return name.replace(/^climon-/, "").replace(/\.zip$/, "");
}

/** Copies bytes into a fresh ArrayBuffer-backed view for WebCrypto. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Signs every `climon-*.zip` in `distDir` with a detached Ed25519 signature
 * (written as `<zip>.sig`, base64) and emits `manifest.json` describing the
 * release version and per-artifact download/signature URLs.
 */
export async function signReleaseDir(opts: SignReleaseOptions): Promise<void> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(Buffer.from(opts.privateKeyPkcs8B64, "base64")),
    { name: "Ed25519" },
    false,
    ["sign"]
  );

  const zips = readdirSync(opts.distDir)
    .filter((f) => f.startsWith("climon-") && f.endsWith(".zip"))
    .sort();

  const artifacts: Record<string, { url: string; sig: string }> = {};
  for (const zip of zips) {
    const bytes = new Uint8Array(readFileSync(join(opts.distDir, zip)));
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", key, toArrayBuffer(bytes))
    );
    const sigB64 = Buffer.from(sig).toString("base64");
    writeFileSync(join(opts.distDir, `${zip}.sig`), sigB64 + "\n");

    const base = opts.baseUrl.replace(/\/$/, "");
    artifacts[artifactKeyFromZip(zip)] = {
      url: `${base}/${zip}`,
      sig: `${base}/${zip}.sig`,
    };
  }

  const manifest = { version: opts.version, artifacts };
  writeFileSync(
    join(opts.distDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );
}

if (import.meta.main) {
  const distDir = process.env.DIST_DIR ?? "dist";
  const version = process.env.RELEASE_VERSION;
  const privateKeyPkcs8B64 = process.env.CLIMON_UPDATE_PRIVATE_KEY;
  const baseUrl = process.env.RELEASE_BASE_URL;
  if (!version || !privateKeyPkcs8B64 || !baseUrl) {
    process.stderr.write(
      "sign-release: RELEASE_VERSION, CLIMON_UPDATE_PRIVATE_KEY, RELEASE_BASE_URL required\n"
    );
    process.exit(1);
  }
  await signReleaseDir({ distDir, version, privateKeyPkcs8B64, baseUrl });
  process.stdout.write(`Signed ${distDir} for ${version}\n`);
}
