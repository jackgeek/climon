import { test as baseTest, expect, type TestInfo } from "@playwright/test";
import { join, resolve } from "node:path";
import { lstat, mkdir } from "node:fs/promises";
import { loadHarnessCases } from "../src/catalog.js";
import { platformFromNode } from "../src/platform.js";
import { HarnessEnvironment } from "../src/environment.js";
import { DashboardDriver } from "../src/dashboard.js";
import { createCommandRunner } from "../src/command.js";
import {
  caseArtifactDir,
  writeCaseResult,
  failureResult,
} from "../src/artifacts.js";
import { SCENARIOS, type ScenarioContext } from "../src/scenarios.js";
import type { CaseResult, HarnessPlatform } from "../src/types.js";
import { HarnessError } from "../src/types.js";

// ── Configuration ───────────────────────────────────────────────────────────

const root = resolve(import.meta.dirname, "../..");
const platform: HarnessPlatform = platformFromNode(process.platform);
const artifactRoot =
  process.env.CLIMON_HARNESS_ARTIFACT_DIR ??
  resolve(root, ".test-tmp", "harness", platform);

// ── Catalogue ───────────────────────────────────────────────────────────────

const allCases = await loadHarnessCases(resolve(root, "docs/manual-tests"));
const smokeCases = allCases.filter((c) => c.suite === "smoke");
const selected = smokeCases.filter(
  (c) => c.status === "automated" && c.platforms.includes(platform)
);
const skipped = smokeCases.filter(
  (c) => c.status === "manual" || !c.platforms.includes(platform)
);

// ── Non-smoke test: SCENARIOS coverage ──────────────────────────────────────

baseTest("every selected smoke scenario has SCENARIOS entry", () => {
  for (const c of selected) {
    expect(
      SCENARIOS[c.scenario],
      `missing SCENARIOS entry for ${c.scenario} (case ${c.id})`
    ).toBeDefined();
    expect(typeof SCENARIOS[c.scenario]).toBe("function");
  }
});

// ── Worker-scoped HarnessEnvironment ────────────────────────────────────────

const test = baseTest.extend<{}, { environment: HarnessEnvironment }>({
  environment: [
    async ({}, use) => {
      // Write skip results for manual / platform-unsupported cases
      for (const c of skipped) {
        const dir = caseArtifactDir(artifactRoot, c.id);
        const message =
          c.status === "manual"
            ? "manual case"
            : `not supported on ${platform}`;
        const result: CaseResult = {
          id: c.id,
          platform,
          status: "skipped",
          durationMs: 0,
          message,
          artifactDir: dir,
        };
        await writeCaseResult(dir, result);
      }

      // Create environment — builds client/server once per worker
      const runner = createCommandRunner();
      const env = await HarnessEnvironment.create({
        root,
        platform,
        artifactRoot,
        runner,
      });

      await use(env);

      // Teardown — always attempt dispose, surface cleanup failures
      try {
        await env.dispose();
      } catch (err) {
        console.error(
          `HarnessEnvironment cleanup failure: ${err instanceof Error ? err.message : String(err)}`
        );
        throw err;
      }
    },
    { scope: "worker", timeout: 600_000 },
  ],
});

// ── Attachment helper ───────────────────────────────────────────────────────

async function attachIfExists(
  testInfo: TestInfo,
  name: string,
  filePath: string
): Promise<void> {
  try {
    const s = await lstat(filePath);
    if (s.isFile()) {
      await testInfo.attach(name, { path: filePath });
    }
  } catch {
    // file doesn't exist — skip
  }
}

// ── Dynamic smoke tests ────────────────────────────────────────────────────

for (const c of selected) {
  test(
    `${c.id} ${c.title} @smoke`,
    async ({ environment, page }, testInfo) => {
      testInfo.setTimeout(c.timeoutSeconds * 1000);

      const dir = caseArtifactDir(environment.artifactRoot, c.id);
      await mkdir(dir, { recursive: true });

      const dashboard = new DashboardDriver(page);
      const scenario = SCENARIOS[c.scenario];

      const ctx: ScenarioContext = {
        caseDefinition: c,
        environment,
        dashboard,
        page,
        artifactDir: dir,
      };

      const startedAt = Date.now();

      try {
        await scenario(ctx);

        // Snapshot state to case artifact dir
        await environment.snapshotState(join(dir, "climon-home"));

        // Write passed result
        const result: CaseResult = {
          id: c.id,
          platform,
          status: "passed",
          durationMs: Date.now() - startedAt,
          artifactDir: dir,
        };
        await writeCaseResult(dir, result);
      } catch (error) {
        // Attempt snapshot on failure
        try {
          await environment.snapshotState(join(dir, "climon-home"));
        } catch (snapErr) {
          const wrapped = new HarnessError(
            "cleanup",
            `snapshot failed during error handling: ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`,
            snapErr
          );
          console.error(wrapped.message);
        }

        // Write failure result
        const result = failureResult(c, platform, error, startedAt, dir);
        await writeCaseResult(dir, result);

        // Attach result and logs where they exist
        await attachIfExists(
          testInfo,
          "result.json",
          join(dir, "result.json")
        );
        for (const logName of [
          "headless-stdout.log",
          "headless-stderr.log",
          "pty.log",
        ]) {
          await attachIfExists(testInfo, logName, join(dir, logName));
        }
        // Playwright trace and screenshot retained on failure via config

        throw error;
      }
    }
  );
}
