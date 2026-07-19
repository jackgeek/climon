import { expect, test } from "@playwright/test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { aggregateResults, runAggregateCli } from "../src/aggregate.js";
import type { CaseResult, HarnessCase } from "../src/types.js";

const automatedCase: HarnessCase = {
  id: "CIH-01",
  title: "Headless lifecycle",
  sourceFile: "cases.md",
  status: "automated",
  suite: "smoke",
  scenario: "client-server.headless-dashboard",
  platforms: ["macos", "linux", "windows"],
  timeoutSeconds: 120,
};

const manualCase: HarnessCase = {
  id: "CIH-MANUAL",
  title: "Manual inspection",
  sourceFile: "manual.md",
  status: "manual",
  suite: "smoke",
  scenario: "client-server.headless-dashboard",
  platforms: ["macos"],
  timeoutSeconds: 60,
};

function passed(id: string, platform: CaseResult["platform"]): CaseResult {
  return {
    id,
    platform,
    status: "passed",
    durationMs: 1000,
    artifactDir: `/artifacts/${id}/${platform}`,
  };
}

// ── aggregateResults: passing scenarios ──────────────────────────────────────

test("aggregateResults: ok when all required automated cells are present and passing", () => {
  const results = [
    passed("CIH-01", "macos"),
    passed("CIH-01", "linux"),
    passed("CIH-01", "windows"),
  ];
  const report = aggregateResults(results, [automatedCase]);
  expect(report.ok).toBe(true);
  expect(report.errors).toHaveLength(0);
});

test("aggregateResults: manual cases are not required", () => {
  const results = [
    passed("CIH-01", "macos"),
    passed("CIH-01", "linux"),
    passed("CIH-01", "windows"),
  ];
  const report = aggregateResults(results, [automatedCase, manualCase]);
  expect(report.ok).toBe(true);
});

test("aggregateResults: platforms not listed in metadata are not required", () => {
  const macLinuxCase: HarnessCase = {
    ...automatedCase,
    platforms: ["macos", "linux"],
  };
  const results = [passed("CIH-01", "macos"), passed("CIH-01", "linux")];
  const report = aggregateResults(results, [macLinuxCase]);
  expect(report.ok).toBe(true);
});

// ── aggregateResults: error scenarios ────────────────────────────────────────

test("aggregateResults: missing required platform cell produces clear error", () => {
  const results = [
    passed("CIH-01", "macos"),
    passed("CIH-01", "linux"),
    // windows missing
  ];
  const report = aggregateResults(results, [automatedCase]);
  expect(report.ok).toBe(false);
  expect(report.errors.some((e) => e.includes("windows"))).toBe(true);
});

test("aggregateResults: failed required cell makes ok false with an error message", () => {
  const results = [
    passed("CIH-01", "macos"),
    passed("CIH-01", "linux"),
    {
      ...passed("CIH-01", "windows"),
      status: "failed" as const,
      failureKind: "assertion" as const,
    },
  ];
  const report = aggregateResults(results, [automatedCase]);
  expect(report.ok).toBe(false);
  expect(
    report.errors.some(
      (e) => e.includes("windows") || e.includes("failed") || e.includes("CIH-01")
    )
  ).toBe(true);
});

test("aggregateResults: skipped required cell makes ok false", () => {
  const results = [
    passed("CIH-01", "macos"),
    passed("CIH-01", "linux"),
    { ...passed("CIH-01", "windows"), status: "skipped" as const },
  ];
  const report = aggregateResults(results, [automatedCase]);
  expect(report.ok).toBe(false);
});

test("aggregateResults: duplicate results for same id+platform produce an error", () => {
  const results = [
    passed("CIH-01", "macos"),
    passed("CIH-01", "macos"), // duplicate
    passed("CIH-01", "linux"),
    passed("CIH-01", "windows"),
  ];
  const report = aggregateResults(results, [automatedCase]);
  expect(report.ok).toBe(false);
  expect(
    report.errors.some(
      (e) => e.includes("duplicate") || e.includes("CIH-01")
    )
  ).toBe(true);
});

// ── aggregateResults: result ordering ────────────────────────────────────────

test("aggregateResults: returned results are sorted by id then platform", () => {
  const results = [
    passed("CIH-01", "windows"),
    passed("CIH-01", "linux"),
    passed("CIH-01", "macos"),
  ];
  const report = aggregateResults(results, [automatedCase]);
  const platforms = report.results.map((r) => r.platform);
  expect(platforms).toEqual(["linux", "macos", "windows"]);
});

// ── runAggregateCli: CLI integration ──────────────────────────────────────────

const cliTmp = resolve(
  import.meta.dirname,
  "../../.test-tmp/aggregate-cli-test"
);

test.afterAll(async () => {
  await rm(cliTmp, { recursive: true, force: true });
});

test("runAggregateCli: returns 1 with missing cell messages for empty results dir", async () => {
  await rm(cliTmp, { recursive: true, force: true });
  await mkdir(cliTmp, { recursive: true });

  const manualTestsDir = resolve(import.meta.dirname, "../../docs/manual-tests");

  const code = await runAggregateCli([cliTmp, manualTestsDir, "smoke"]);

  expect(code).toBe(1);

  const summary = await readFile(join(cliTmp, "summary.md"), "utf8");
  expect(summary).toContain("FAIL");
  expect(summary).toContain("missing");
});
