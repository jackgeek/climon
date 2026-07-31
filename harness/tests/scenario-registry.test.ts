import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  scenarioDefinitions,
  validateScenarioDefinitions,
} from "../src/scenario-registry.js";
import type { ScenarioDefinition } from "../src/scenario-registry.js";
import type {
  HarnessPlatform,
  PlatformExpectation,
} from "../src/types.js";

function makeWorkspace(name: string): string {
  const workspace = resolve(
    import.meta.dir,
    "..",
    ".test-workspace",
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

describe("scenarioDefinitions", () => {
  test("registers DAR-01 and DAR-02 in order with typed per-platform expectations", () => {
    const expectedDefinitions: readonly ScenarioDefinition[] = [
      {
        darId: "DAR-01",
        title: "Attached shell input, output, and terminal restoration",
        manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
        manualHeading:
          "## DAR-01 — Attached shell: input, output, and raw-mode restoration",
        suite: "dar",
        timeoutMs: 180_000,
        expectations: {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: {
            expected: "known-failure",
            reason:
              "The latest Windows manual run could not verify attached console fidelity or mode restoration.",
            tracking: "docs/manual-tests/results/windows.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: [
              "attached-startup",
              "text-input-output",
              "control-and-key-input",
              "mouse-input",
              "alternate-screen-render",
              "resize-repaint",
              "terminal-mode-restoration",
            ],
          },
        } satisfies Record<HarnessPlatform, PlatformExpectation>,
      },
      {
        darId: "DAR-02",
        title: "Headless session dashboard replay and live output",
        manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
        manualHeading:
          "## DAR-02 — Headless session and dashboard attach / replay",
        suite: "dar",
        timeoutMs: 180_000,
        expectations: {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: {
            expected: "partial",
            reason:
              "The latest Windows manual run showed the session but did not verify rendered replay plus continued live output.",
            tracking: "docs/manual-tests/results/windows.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: [
              "replay-visible",
              "browser-input",
              "live-output",
            ],
          },
        } satisfies Record<HarnessPlatform, PlatformExpectation>,
      },
    ];

    expect(scenarioDefinitions.map(({ darId }) => darId)).toEqual([
      "DAR-01",
      "DAR-02",
    ]);
    expect(scenarioDefinitions).toEqual(expectedDefinitions);
  });
});

describe("validateScenarioDefinitions", () => {
  test("succeeds against the repository root", async () => {
    const repositoryRoot = resolve(import.meta.dir, "..", "..");

    await expect(
      validateScenarioDefinitions(repositoryRoot)
    ).resolves.toBeUndefined();
  });

  test("rejects when a referenced manual heading is missing", async () => {
    const workspace = makeWorkspace("missing-heading");
    const manualPath = join(
      workspace,
      "docs",
      "manual-tests",
      "daemon-actor-rewrite.md"
    );

    try {
      mkdirSync(join(workspace, "docs", "manual-tests"), { recursive: true });
      writeFileSync(
        manualPath,
        [
          "# Daemon actor rewrite",
          "",
          "## DAR-01 — Attached shell: input, output, and raw-mode restoration",
        ].join("\n")
      );

      await expect(validateScenarioDefinitions(workspace)).rejects.toThrow(
        'Missing manual heading "## DAR-02 — Headless session and dashboard attach / replay" in docs/manual-tests/daemon-actor-rewrite.md for DAR-02'
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
