#!/usr/bin/env bun
/**
 * Bumps the package.json version, commits the change, and creates a matching
 * git tag. Usage:
 *
 *   bun run release            # patch bump (default)
 *   bun run release minor
 *   bun run release major
 *
 * Refuses to run with a dirty working tree so the release commit only ever
 * contains the version bump. Does NOT push — print the suggested push command
 * and let the human (or CI) push when ready.
 */
import { $ } from "bun";
import { resolve, dirname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { bumpVersion, parseLevel } from "../src/release/version-bump.ts";

const projectRoot = dirname(dirname(import.meta.path));
const pkgPath = resolve(projectRoot, "package.json");

async function workingTreeIsClean(): Promise<boolean> {
  const status = (await $`git status --porcelain`.cwd(projectRoot).text()).trim();
  return status.length === 0;
}

async function main(): Promise<void> {
  const level = parseLevel(process.argv[2]);

  if (!(await workingTreeIsClean())) {
    throw new Error(
      "Working tree is not clean. Commit or stash changes before releasing so the release commit only contains the version bump."
    );
  }

  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  if (typeof pkg.version !== "string") {
    throw new Error("package.json has no version field.");
  }

  const current = pkg.version;
  const next = bumpVersion(current, level);
  const tag = `v${next}`;

  // Preserve the file's exact formatting (2-space indent + trailing newline)
  // by replacing only the version string rather than re-serialising the object.
  const updated = raw.replace(
    /("version"\s*:\s*")[^"]+(")/,
    `$1${next}$2`
  );
  if (updated === raw) {
    throw new Error("Failed to rewrite the version field in package.json.");
  }
  writeFileSync(pkgPath, updated);

  await $`git add ${pkgPath}`.cwd(projectRoot);
  await $`git commit -m ${`chore(release): ${tag}`}`.cwd(projectRoot);
  await $`git tag -a ${tag} -m ${tag}`.cwd(projectRoot);

  console.log(`✓ Released ${tag} (${current} → ${next}, ${level} bump)`);
  console.log(`  Push with: git push --follow-tags`);
}

main().catch((err: unknown) => {
  console.error(`release: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
