// Usage: bun scripts/bridge-release.ts <tag> [--dry-run]
// Publishes a final signed, UNENCRYPTED manifest to jackgeek/climon-releases
// whose artifact URLs point at the jackgeek/climon release assets, so existing
// installs upgrade once and thereafter poll jackgeek/climon.
//
// This is a ONE-TIME migration bridge: the legacy client polls
// https://github.com/jackgeek/climon-releases/releases/latest/download/manifest.json
// and expects encrypted artifacts. After the relicense we no longer encrypt, so
// this script republishes the new plaintext, signed manifest + zips + sigs to the
// latest release on jackgeek/climon-releases. The manifest's artifact URLs point
// at jackgeek/climon, so the very next update lands the client on the new repo and
// it never consults climon-releases again.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal shape of the signed manifest emitted by sign-release.ts. */
export type BridgeManifest = {
  version: string;
  encryption?: string;
  artifacts: Record<string, { url: string; sig: string }>;
};

/** The repository whose release assets the bridged manifest points at. */
export const TARGET_REPO = "jackgeek/climon";
/** The legacy repository whose latest release we republish the manifest to. */
export const BRIDGE_REPO = "jackgeek/climon-releases";

/** Base download URL for a jackgeek/climon release tag. */
export function releaseBaseUrl(tag: string): string {
  return `https://github.com/${TARGET_REPO}/releases/download/${tag}`;
}

/**
 * Returns a copy of `manifest` with every artifact URL/sig repointed at the
 * jackgeek/climon release for `tag` and any `encryption` field stripped. The
 * rewrite is idempotent: it keys off each URL's basename, so a manifest already
 * produced by the de-DRM'd release workflow round-trips unchanged.
 */
export function bridgeManifest(
  manifest: BridgeManifest,
  tag: string
): BridgeManifest {
  const base = releaseBaseUrl(tag);
  const basename = (u: string): string => u.split("/").pop() ?? u;
  const artifacts: BridgeManifest["artifacts"] = {};
  for (const [key, art] of Object.entries(manifest.artifacts)) {
    artifacts[key] = {
      url: `${base}/${basename(art.url)}`,
      sig: `${base}/${basename(art.sig)}`,
    };
  }
  return { version: manifest.version, artifacts };
}

function parseArgs(argv: string[]): { tag: string; dryRun: boolean } {
  const args = argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const tag = args.find((a) => !a.startsWith("--"));
  if (!tag) {
    process.stderr.write(
      "bridge-release: usage: bun scripts/bridge-release.ts <tag> [--dry-run]\n"
    );
    process.exit(1);
  }
  return { tag, dryRun };
}

/** Resolves the tag GitHub currently marks as the latest release on a repo. */
function latestReleaseTag(repo: string): string {
  const out = execFileSync(
    "gh",
    ["release", "view", "--repo", repo, "--json", "tagName", "--jq", ".tagName"],
    { encoding: "utf8" }
  );
  const tag = out.trim();
  if (!tag) throw new Error(`No latest release found on ${repo}`);
  return tag;
}

if (import.meta.main) {
  const { tag, dryRun } = parseArgs(process.argv);
  const distDir = process.env.DIST_DIR ?? "dist";

  const raw = JSON.parse(
    readFileSync(join(distDir, "manifest.json"), "utf8")
  ) as BridgeManifest;
  const manifest = bridgeManifest(raw, tag);

  if (dryRun) {
    process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
    process.exit(0);
  }

  // Collect the assets to republish: the bridged manifest plus every zip and its
  // detached signature. Write the rewritten manifest back to dist before upload.
  const manifestPath = join(distDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const assets = [manifestPath];
  for (const f of readdirSync(distDir).sort()) {
    if (f.startsWith("climon-") && (f.endsWith(".zip") || f.endsWith(".zip.sig"))) {
      assets.push(join(distDir, f));
    }
  }

  const bridgeTag = latestReleaseTag(BRIDGE_REPO);
  process.stdout.write(
    `Bridging ${tag} -> ${BRIDGE_REPO}@${bridgeTag} (${assets.length} assets)\n`
  );
  execFileSync(
    "gh",
    ["release", "upload", bridgeTag, ...assets, "--repo", BRIDGE_REPO, "--clobber"],
    { stdio: "inherit" }
  );
}
