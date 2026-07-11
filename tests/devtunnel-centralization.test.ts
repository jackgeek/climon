import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";

// Guards devtunnel-execution centralization: the devtunnel CLI may only be
// spawned from the two gateway modules. Any other maintained source file that
// constructs a `devtunnel` child process (Bun `spawn("devtunnel"`, Rust
// `Command::new("devtunnel"`) or a raw `tokio::process::Command` builder is a
// policy drift and fails this test. Docs, tests, and fixtures are exempt.

const repoRoot = join(import.meta.dir, "..");

// The only directories permitted to spawn the devtunnel CLI directly.
const ALLOWED_DIRS = [
  join("src", "devtunnel"),
  join("rust", "climon-remote", "src", "devtunnel")
];

// Roots of maintained source that the guard scans.
const SCAN_GLOBS = ["src/**/*.ts", "rust/**/*.rs"];

// Forbidden constructions, evaluated per non-comment source line.
const FORBIDDEN: { label: string; pattern: RegExp }[] = [
  { label: 'spawn("devtunnel"', pattern: /\bspawn\s*\(\s*["'`]devtunnel["'`]/ },
  { label: 'Command::new("devtunnel"', pattern: /Command::new\s*\(\s*"devtunnel"/ },
  { label: "tokio::process::Command", pattern: /tokio::process::Command/ }
];

function isAllowed(relPath: string): boolean {
  const normalized = relPath.split(/[\\/]/).join(sep);
  return ALLOWED_DIRS.some((dir) => normalized.startsWith(dir + sep));
}

function stripComment(line: string): string {
  // Drop `//` line comments so a documented reference to the forbidden pattern
  // in a comment does not trip the guard.
  const idx = line.indexOf("//");
  return idx >= 0 ? line.slice(0, idx) : line;
}

function scanFile(absPath: string, relPath: string): string[] {
  const lines = readFileSync(absPath, "utf8").split("\n");
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const code = stripComment(lines[i]);
    for (const { label, pattern } of FORBIDDEN) {
      if (pattern.test(code)) {
        hits.push(`${relPath}:${i + 1} uses ${label}`);
      }
    }
  }
  return hits;
}

async function collectViolations(): Promise<string[]> {
  const violations: string[] = [];
  for (const globPattern of SCAN_GLOBS) {
    const glob = new Bun.Glob(globPattern);
    for await (const relPath of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
      if (isAllowed(relPath)) continue;
      violations.push(...scanFile(join(repoRoot, relPath), relPath));
    }
  }
  return violations.sort();
}

describe("devtunnel execution is centralized", () => {
  test("no maintained source spawns the devtunnel CLI outside the gateway modules", async () => {
    const violations = await collectViolations();
    expect(
      violations,
      `Direct devtunnel execution must live in src/devtunnel/ or ` +
        `rust/climon-remote/src/devtunnel/. Offending sites:\n${violations.join("\n")}`
    ).toEqual([]);
  });
});
