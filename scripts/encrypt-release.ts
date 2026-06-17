import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENVELOPE_SCHEME,
  encryptEnvelope,
} from "../src/update/crypto-envelope.js";

export type EncryptReleaseOptions = {
  distDir: string;
  /** Shared distribution password (from CLIMON_DISTRIBUTION_PASSWORD). */
  password: string;
};

/**
 * Encrypts every `climon-*.zip` in `distDir` into a `<zip>.enc` envelope and
 * rewrites `manifest.json`: sets the top-level `encryption` scheme and points
 * each artifact `url` at the `.enc` file. The plaintext zips and `.sig` files
 * are left in place (the plaintext zips are published to the private repo only;
 * the `.sig` covers the plaintext zip and is unchanged).
 */
export function encryptReleaseDir(opts: EncryptReleaseOptions): void {
  const { distDir, password } = opts;

  const zips = readdirSync(distDir)
    .filter((f) => f.startsWith("climon-") && f.endsWith(".zip"))
    .sort();
  for (const zip of zips) {
    const bytes = new Uint8Array(readFileSync(join(distDir, zip)));
    writeFileSync(join(distDir, `${zip}.enc`), encryptEnvelope(bytes, password));
  }

  const manifestPath = join(distDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    encryption?: string;
    artifacts?: Record<string, { url: string; sig: string }>;
  };
  if (
    !manifest.artifacts ||
    Object.keys(manifest.artifacts).length === 0
  ) {
    throw new Error(
      "encrypt-release: manifest.json has no artifacts; run sign-release first"
    );
  }
  manifest.encryption = ENVELOPE_SCHEME;
  for (const artifact of Object.values(manifest.artifacts)) {
    if (artifact.url.endsWith(".zip")) artifact.url = `${artifact.url}.enc`;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

if (import.meta.main) {
  const distDir = process.env.DIST_DIR ?? "dist";
  const password = process.env.CLIMON_DISTRIBUTION_PASSWORD;
  if (!password) {
    process.stderr.write(
      "encrypt-release: CLIMON_DISTRIBUTION_PASSWORD required\n"
    );
    process.exit(1);
  }
  encryptReleaseDir({ distDir, password });
  process.stdout.write(`Encrypted ${distDir}\n`);
}
