import { failedSubcheckLabels } from "../subchecks.js";
import type { PlatformExpectation } from "../types.js";
import type { ResultsReport } from "./json.js";

function failedLabel(reportResult: ResultsReport["results"][number]): string {
  return failedSubcheckLabels(reportResult.subchecks).join(", ") || "-";
}

function writeGovernanceLines(lines: string[], expectation: PlatformExpectation): void {
  if (expectation.expected === "pass") {
    return;
  }

  lines.push(`- reason: ${expectation.reason}`);

  if (expectation.expected === "unsupported") {
    return;
  }

  lines.push(`- tracking: ${expectation.tracking}`);
  lines.push(`- reviewAfter: ${expectation.reviewAfter}`);
  lines.push(`- allowedFailed: ${expectation.allowedFailedSubchecks.join(",") || "-"}`);
}

export function renderMarkdownReport(report: ResultsReport): string {
  const lines = [
    "# E2E harness summary",
    "",
    `- revision: ${report.revision}`,
    `- generatedAt: ${report.generatedAt}`,
    `- blocking: ${report.results.some((result) => result.blocking) ? "yes" : "no"}`,
    "",
    "| Platform | DAR | Title | Status | Blocking | Expected | Failed subchecks |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const result of report.results) {
    lines.push(
      `| ${result.platform} | ${result.darId} | ${result.title} | ${result.status} | ${
        result.blocking ? "yes" : "no"
      } | ${result.expectation.expected} | ${failedLabel(result)} |`
    );
  }

  for (const result of report.results) {
    lines.push(
      "",
      `## ${result.platform} / ${result.darId} — ${result.title}`,
      `- expected: ${result.expectation.expected}`,
      `- actual status: ${result.status}`,
      `- actual failed: ${failedLabel(result)}`,
      `- blocking: ${result.blocking ? "yes" : "no"}`
    );
    writeGovernanceLines(lines, result.expectation);
    lines.push(`- message: ${result.message ?? "-"}`);
  }

  return `${lines.join("\n")}\n`;
}
