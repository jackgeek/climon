/**
 * ⚠️ LEGACY TypeScript client — frozen. Fix the Rust client instead.
 *
 * The shipping `climon` *client* is the Rust workspace under `rust/` (crates
 * `climon-cli`, `climon-session`, `climon-pty`, `climon-store`, `climon-config`,
 * `climon-remote`, `climon-install`, `climon-update`, …). This module belongs to
 * the legacy Bun/TypeScript client, kept only for local development and the Bun
 * test suite. Do NOT add features or fix client bugs here — make all client
 * changes in the Rust crates. (The Bun dashboard *server* under `src/server*`
 * and `src/web/` is NOT legacy and is still maintained.)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ChangelogEntry = {
  version: string;
  changes: string[];
};

/**
 * Reads the previously installed version from the `.version` file in the
 * install directory. Returns undefined if no previous install is detected.
 */
export function readInstalledVersion(installDir: string): string | undefined {
  const versionFile = join(installDir, ".version");
  if (!existsSync(versionFile)) {
    return undefined;
  }
  return readFileSync(versionFile, "utf8").trim();
}

/**
 * The embedded changelog, inlined at compile time by Bun's bundler just like
 * package.json is imported for the VERSION constant.
 */
import changelog from "../../CHANGELOG.json";

export function loadChangelog(): ChangelogEntry[] {
  return changelog as ChangelogEntry[];
}

/**
 * Compares two strict semver strings. Returns:
 *  -1 if a < b, 0 if equal, 1 if a > b.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * Returns changelog entries that are newer than `fromVersion`.
 * If fromVersion is undefined (fresh install), returns all entries.
 * Entries are returned newest-first.
 */
export function getChangesSince(
  changelog: ChangelogEntry[],
  fromVersion: string | undefined
): ChangelogEntry[] {
  if (fromVersion === undefined) {
    return changelog;
  }

  return changelog.filter(
    (entry) => compareSemver(entry.version, fromVersion) > 0
  );
}

/**
 * Formats changelog entries for terminal display.
 */
export function formatChangelog(entries: ChangelogEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push("");
  lines.push("What's new:");
  lines.push("");

  for (const entry of entries) {
    lines.push(`  v${entry.version}:`);
    for (const change of entry.changes) {
      lines.push(`    • ${change}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
