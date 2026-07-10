#!/usr/bin/env bun
/**
 * Peer-dependency compatibility gate.
 *
 * Guards against the class of bug where a dependency bump lands a package
 * without its tightly-coupled sibling — e.g. `@xterm/xterm` was bumped to 6.0.0
 * while `@xterm/addon-fit` (peerDep `@xterm/xterm ^5.0.0`) was left at 0.10,
 * whose `proposeDimensions()` reads an xterm-6-removed internal and throws at
 * runtime. The unit suite passed because nothing exercised that path, so the
 * mismatch shipped silently.
 *
 * This walks every installed package and fails if any non-optional
 * `peerDependencies` range is not satisfied by the installed peer, using
 * `Bun.semver.satisfies` (no extra dependency). It reports the exact
 * dependent → peer pairs that are out of range so the fix is obvious: bump the
 * lagging peer to a compatible version.
 *
 * Peers that are declared optional (`peerDependenciesMeta`) or not installed at
 * all are skipped — the target here is a peer that IS present but on an
 * incompatible version (the "coupled sibling left behind" case).
 *
 * Run directly (`bun run check:peers`). Used as a mandatory gate by the
 * `merge-dependabot-prs` skill after `bun install`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface PackageManifest {
  name?: string;
  version?: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function readManifest(dir: string): PackageManifest | null {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  } catch {
    return null;
  }
}

function installedPackageDirs(nodeModules: string): string[] {
  if (!existsSync(nodeModules)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      const scopeDir = join(nodeModules, entry.name);
      for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
        if (scoped.isDirectory()) dirs.push(join(scopeDir, scoped.name));
      }
    } else if (!entry.name.startsWith(".")) {
      dirs.push(join(nodeModules, entry.name));
    }
  }
  return dirs;
}

/**
 * Return one message per installed package whose non-optional peer is present
 * but on a version outside the declared range. Empty means all peers are
 * satisfied.
 */
export function findPeerDependencyViolations(nodeModules: string): string[] {
  const violations: string[] = [];
  for (const dir of installedPackageDirs(nodeModules)) {
    const manifest = readManifest(dir);
    if (!manifest?.peerDependencies) continue;
    const meta = manifest.peerDependenciesMeta ?? {};
    for (const [peer, range] of Object.entries(manifest.peerDependencies)) {
      if (meta[peer]?.optional) continue;
      const version = readManifest(join(nodeModules, peer))?.version ?? null;
      if (version == null) continue;
      if (!Bun.semver.satisfies(version, range)) {
        violations.push(
          `${manifest.name}@${manifest.version} requires ${peer}@${range}, but ${peer}@${version} is installed`
        );
      }
    }
  }
  return violations.sort();
}

if (import.meta.main) {
  const violations = findPeerDependencyViolations(join(process.cwd(), "node_modules"));
  if (violations.length > 0) {
    console.error("Peer-dependency mismatches detected:\n");
    for (const violation of violations) {
      console.error(`  \u2717 ${violation}`);
    }
    console.error(
      `\n${violations.length} mismatch(es). A bumped package left a coupled peer behind; ` +
        "bump the lagging peer to a compatible version (or the leading one down)."
    );
    process.exit(1);
  }
  console.log("\u2713 All installed peerDependencies are satisfied.");
}
