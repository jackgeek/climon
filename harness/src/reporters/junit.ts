import type { CaseStatus } from "../types.js";
import type { ReportCaseResult, ResultsReport } from "./json.js";

const BLOCKING_STATUSES = new Set<CaseStatus>([
  "unexpected-failure",
  "unexpected-pass",
  "expired-expectation",
  "setup-failure",
  "cleanup-failure",
]);
const SKIPPED_STATUSES = new Set<CaseStatus>([
  "expected-failure",
  "expected-partial",
  "unsupported",
]);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableValue(entry));
  }

  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }

  return value;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function durationSeconds(durationMs: number): string {
  return (Math.max(0, durationMs) / 1_000).toFixed(3);
}

function systemOutPayload(result: ReportCaseResult): string {
  return xmlEscape(
    JSON.stringify(
      stableValue({
        artifactDir: result.artifactDir,
        failedSubchecks: result.failedSubchecks,
        message: result.message ?? null,
        subchecks: result.subchecks,
      })
    )
  );
}

function renderTestCase(result: ReportCaseResult): string[] {
  const lines = [
    `  <testcase classname="${xmlEscape(`${result.platform}.${result.darId}`)}" name="${xmlEscape(
      `${result.darId} ${result.title}`
    )}" time="${durationSeconds(result.durationMs)}">`,
  ];

  if (SKIPPED_STATUSES.has(result.status)) {
    lines.push(
      `    <skipped message="${xmlEscape(result.status)}">${xmlEscape(result.message ?? result.status)}</skipped>`
    );
  } else if (BLOCKING_STATUSES.has(result.status)) {
    lines.push(
      `    <failure message="${xmlEscape(result.status)}">${xmlEscape(result.message ?? result.status)}</failure>`
    );
  }

  lines.push(`    <system-out>${systemOutPayload(result)}</system-out>`);
  lines.push("  </testcase>");
  return lines;
}

export function renderJUnitReport(report: ResultsReport): string {
  const failures = report.results.filter((result) => BLOCKING_STATUSES.has(result.status)).length;
  const skipped = report.results.filter((result) => SKIPPED_STATUSES.has(result.status)).length;
  const totalDurationMs = report.results.reduce((sum, result) => sum + result.durationMs, 0);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="e2e-harness" tests="${report.results.length}" failures="${failures}" skipped="${skipped}" time="${durationSeconds(
      totalDurationMs
    )}">`,
    "  <properties>",
    `    <property name="revision" value="${xmlEscape(report.revision)}"/>`,
    `    <property name="generatedAt" value="${xmlEscape(report.generatedAt)}"/>`,
    "  </properties>",
  ];

  for (const result of report.results) {
    lines.push(...renderTestCase(result));
  }

  lines.push("</testsuite>");
  return `${lines.join("\n")}\n`;
}
