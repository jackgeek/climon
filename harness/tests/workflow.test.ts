import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..");
const WORKFLOW_PATH = join(
  REPOSITORY_ROOT,
  ".github",
  "workflows",
  "e2e-harness.yml"
);

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, "utf8");
}

describe("E2E harness workflow", () => {
  test("pins the three-OS matrix toolchains, trigger paths, and avoids retries", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("name: e2e-harness");
    expect(workflow).toContain('- ".github/workflows/e2e-harness.yml"');
    expect(workflow).toContain('- "scripts/server-build.ts"');
    expect(workflow).toContain('- "scripts/compile.ts"');
    expect(workflow).toContain('- "docs/manual-tests/**"');
    expect(workflow).toContain("- os: ubuntu-latest");
    expect(workflow).toContain("- os: macos-latest");
    expect(workflow).toContain("- os: windows-latest");
    expect(workflow).toContain("node-version: \"24\"");
    expect(workflow).toContain("uses: dtolnay/rust-toolchain@stable");
    expect(workflow).toContain("bun-version: 1.3.10");
    expect(workflow).not.toMatch(/\bretry\b/i);
    expect(workflow).not.toMatch(/run:\s+.*catalog(?:ue)?/i);
    expect(workflow).not.toContain("bun run harness list");
  });

  test("installs chromium with Linux deps only on Ubuntu", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("if: ${{ matrix.os == 'ubuntu-latest' }}");
    expect(workflow).toContain("run: bunx playwright install --with-deps chromium");
    expect(workflow).toContain("if: ${{ matrix.os != 'ubuntu-latest' }}");
    expect(workflow).toContain("run: bun run harness:install-browser");
  });

  test("runs doctor and the DAR suite with exact package-script commands", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("run: bun run harness -- doctor");
    expect(workflow).toContain(
      "run: bun run harness -- run DAR-01 DAR-02 --artifact-root .test-tmp/e2e-harness/${{ matrix.platform }}"
    );
    expect(workflow).toContain(
      "CLIMON_DISABLE_SETSID: ${{ matrix.os == 'ubuntu-latest' && '1' || '' }}"
    );
  });

  test("uses exact artifact roots, always uploads them, and aggregates from the download root", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("if: ${{ always() }}");
    expect(workflow).toContain("name: e2e-harness-${{ matrix.platform }}");
    expect(workflow).toContain("path: .test-tmp/e2e-harness/${{ matrix.platform }}");
    expect(workflow).toContain("pattern: e2e-harness-*");
    expect(workflow).toContain("path: .test-tmp/e2e-harness-results");
    expect(workflow).toContain(
      "run: bun run harness -- aggregate --results-root .test-tmp/e2e-harness-results"
    );
    expect(workflow).toContain("name: e2e-harness-results");
    expect(workflow).toContain(
      "cat .test-tmp/e2e-harness-results/summary.md >> \"$GITHUB_STEP_SUMMARY\""
    );
  });
});
