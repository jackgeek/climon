import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HarnessError, type HarnessPlatform, type PlatformExpectation } from "./types.js";

export type DarId = "DAR-01" | "DAR-02";

export interface ScenarioDefinition {
  darId: DarId;
  title: string;
  manualPath: string;
  manualHeading: string;
  suite: "dar";
  timeoutMs: number;
  expectations: Record<HarnessPlatform, PlatformExpectation>;
}

export const scenarioDefinitions: readonly ScenarioDefinition[] = [
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
    },
  },
  {
    darId: "DAR-02",
    title: "Headless session dashboard replay and live output",
    manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
    manualHeading: "## DAR-02 — Headless session and dashboard attach / replay",
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
    },
  },
];

export async function validateScenarioDefinitions(rootDir: string): Promise<void> {
  const seenIds = new Set<DarId>();
  const manualContents = new Map<string, string>();

  for (const definition of scenarioDefinitions) {
    if (seenIds.has(definition.darId)) {
      throw new HarnessError(
        "prerequisite",
        `Duplicate DAR id: ${definition.darId}`
      );
    }
    seenIds.add(definition.darId);

    let contents = manualContents.get(definition.manualPath);
    if (contents === undefined) {
      contents = await readFile(resolve(rootDir, definition.manualPath), "utf8");
      manualContents.set(definition.manualPath, contents);
    }

    const manualLines = contents.split(/\r?\n/);

    if (!manualLines.includes(definition.manualHeading)) {
      throw new HarnessError(
        "prerequisite",
        `Missing manual heading "${definition.manualHeading}" in ${definition.manualPath} for ${definition.darId}`
      );
    }
  }
}
