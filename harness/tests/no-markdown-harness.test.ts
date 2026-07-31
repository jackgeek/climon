import { expect, test } from "bun:test";
import { access, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..");
const MANUAL_TESTS_ROOT = join(REPOSITORY_ROOT, "docs", "manual-tests");
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".test-workspace",
  ".worktrees",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".json",
  ".js",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const ALLOWED_REFERENCE_PATHS = new Set([
  "docs/superpowers/plans/2026-07-31-cross-platform-dar-e2e-harness.md",
  "docs/superpowers/specs/2026-07-31-cross-platform-dar-e2e-harness-design.md",
  "harness/tests/no-markdown-harness.test.ts",
]);
const FORBIDDEN_REPOSITORY_PATTERNS = [
  {
    label: "yaml harness metadata",
    pattern: /```yaml harness/g,
  },
  {
    label: "CIH identifiers",
    pattern: /\bCIH-\d+\b/g,
  },
  {
    label: "client-server harness workflow name",
    pattern: /\bclient-server-harness\b/g,
  },
  {
    label: "old markdown catalogue module path",
    pattern: /\bharness\/src\/catalog\b/g,
  },
];
const OBSOLETE_PATHS = [
  ".github/workflows/client-server-harness.yml",
  "docs/manual-tests/cross-platform-ci-harness.md",
  "docs/superpowers/handoffs/2026-07-19-cross-platform-ci-harness.md",
  "docs/superpowers/plans/2026-07-18-cross-platform-ci-harness.md",
  "docs/superpowers/specs/2026-07-18-cross-platform-ci-harness-design.md",
  "harness/README.md",
  "harness/fixtures/echo-session.mjs",
  "harness/playwright.config.ts",
  "harness/scripts/prepare-node-pty.d.mts",
  "harness/scripts/prepare-node-pty.mjs",
  "harness/src/aggregate.ts",
  "harness/src/build.ts",
  "harness/src/catalog.ts",
  "harness/src/dashboard.ts",
  "harness/src/environment.ts",
  "harness/src/platform.ts",
  "harness/src/pty.ts",
  "harness/src/scenarios.ts",
  "harness/tests/aggregate.spec.ts",
  "harness/tests/artifacts.spec.ts",
  "harness/tests/build.spec.ts",
  "harness/tests/catalog.spec.ts",
  "harness/tests/command.spec.ts",
  "harness/tests/dashboard.spec.ts",
  "harness/tests/environment.spec.ts",
  "harness/tests/fixture.spec.ts",
  "harness/tests/native-prep.spec.ts",
  "harness/tests/platform.spec.ts",
  "harness/tests/pty.spec.ts",
  "harness/tests/scenarios.spec.ts",
  "harness/tests/smoke.spec.ts",
  "harness/tests/workflow.spec.ts",
] as const;

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      files.push(...(await walkFiles(join(root, entry.name))));
      continue;
    }

    if (entry.isFile()) {
      files.push(join(root, entry.name));
    }
  }

  return files;
}

function isScannableTextFile(path: string): boolean {
  for (const extension of TEXT_FILE_EXTENSIONS) {
    if (path.endsWith(extension)) {
      return true;
    }
  }

  return false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("manual Markdown never contains executable harness metadata or CIH ids", async () => {
  const files = (await walkFiles(MANUAL_TESTS_ROOT)).filter((file) =>
    file.endsWith(".md")
  );

  for (const file of files) {
    const text = await readFile(file, "utf8");
    expect(text).not.toContain("```yaml harness");
    expect(text).not.toMatch(/\bCIH-\d+\b/);
  }
});

test("repository source tree no longer carries markdown-driven CI harness remnants", async () => {
  for (const relativePath of OBSOLETE_PATHS) {
    await expect(pathExists(join(REPOSITORY_ROOT, relativePath))).resolves.toBe(
      false
    );
  }

  const forbiddenMatches: string[] = [];
  const files = await walkFiles(REPOSITORY_ROOT);

  for (const file of files) {
    if (!isScannableTextFile(file)) {
      continue;
    }

    const relativePath = relative(REPOSITORY_ROOT, file).replaceAll("\\", "/");
    if (ALLOWED_REFERENCE_PATHS.has(relativePath)) {
      continue;
    }

    const text = await readFile(file, "utf8");

    for (const { label, pattern } of FORBIDDEN_REPOSITORY_PATTERNS) {
      pattern.lastIndex = 0;
      if (!pattern.test(text)) {
        continue;
      }

      forbiddenMatches.push(`${relativePath}: ${label}`);
    }
  }

  expect(forbiddenMatches).toEqual([]);
});
