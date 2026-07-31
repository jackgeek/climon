import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..");
const WORKFLOW_PATH = join(
  REPOSITORY_ROOT,
  ".github",
  "workflows",
  "dar-e2e-harness.yml"
);

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, "utf8");
}

describe("DAR harness workflow", () => {
  test("pins the three-OS matrix toolchains and avoids retries", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("name: dar-e2e-harness");
    expect(workflow).toContain("- os: ubuntu-latest");
    expect(workflow).toContain("- os: macos-latest");
    expect(workflow).toContain("- os: windows-latest");
    expect(workflow).toContain("node-version: \"24\"");
    expect(workflow).toContain("uses: dtolnay/rust-toolchain@stable");
    expect(workflow).toContain("bun-version: 1.3.10");
    expect(workflow).not.toMatch(/\bretry\b/i);
  });

  test("installs chromium with Linux deps only on Ubuntu", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("if: ${{ matrix.os == 'ubuntu-latest' }}");
    expect(workflow).toContain("run: bunx playwright install --with-deps chromium");
    expect(workflow).toContain("if: ${{ matrix.os != 'ubuntu-latest' }}");
    expect(workflow).toContain("run: bun run harness:install-browser");
  });

  test("runs doctor and the DAR suite with Linux-only setsid disablement", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("run: bun run harness doctor");
    expect(workflow).toContain(
      "run: bun run harness run --artifact-root harness-artifacts/${{ matrix.platform }}/run-1"
    );
    expect(workflow).toContain(
      "CLIMON_DISABLE_SETSID: ${{ matrix.os == 'ubuntu-latest' && '1' || '' }}"
    );
  });

  test("downloads platform artifacts into the aggregate scan root and uploads outputs", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("name: dar-e2e-harness-${{ matrix.platform }}");
    expect(workflow).toContain("path: harness-artifacts/${{ matrix.platform }}");
    expect(workflow).toContain("path: harness-artifacts/results");
    expect(workflow).toContain(
      "run: bun run harness aggregate --results-root harness-artifacts/results"
    );
    expect(workflow).toContain("cat harness-artifacts/results/summary.md >> \"$GITHUB_STEP_SUMMARY\"");
    expect(workflow).toContain("if: ${{ always() }}");
  });
});
