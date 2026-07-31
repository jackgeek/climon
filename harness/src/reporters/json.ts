import path from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import {
  type CaseResult,
  type CaseStatus,
  type HarnessPlatform,
  type PlatformExpectation,
} from "../types.js";

const CASE_STATUSES = new Set<CaseStatus>([
  "passed",
  "expected-failure",
  "expected-partial",
  "unsupported",
  "unexpected-failure",
  "unexpected-pass",
  "expired-expectation",
  "setup-failure",
  "cleanup-failure",
]);
const PLATFORM_ORDER = new Map<HarnessPlatform, number>([
  ["linux", 0],
  ["macos", 1],
  ["windows", 2],
]);

export interface ReportCaseResult extends CaseResult {
  expectation: PlatformExpectation;
}

export interface ResultsReport {
  revision: string;
  generatedAt: string;
  results: ReportCaseResult[];
}

interface ReportFs {
  mkdir: typeof mkdir;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
}

function defaultFs(): ReportFs {
  return {
    mkdir,
    rename,
    rm,
    writeFile,
  };
}

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

function resultSorter(left: ReportCaseResult, right: ReportCaseResult): number {
  return (
    (PLATFORM_ORDER.get(left.platform) ?? Number.MAX_SAFE_INTEGER) -
      (PLATFORM_ORDER.get(right.platform) ?? Number.MAX_SAFE_INTEGER) ||
    left.darId.localeCompare(right.darId)
  );
}

function isPlatformExpectation(value: unknown): value is PlatformExpectation {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.expected === "pass") {
    return true;
  }

  if (candidate.expected === "unsupported") {
    return typeof candidate.reason === "string";
  }

  return (
    (candidate.expected === "known-failure" || candidate.expected === "partial") &&
    typeof candidate.reason === "string" &&
    typeof candidate.tracking === "string" &&
    typeof candidate.reviewAfter === "string" &&
    Array.isArray(candidate.allowedFailedSubchecks) &&
    candidate.allowedFailedSubchecks.every((entry) => typeof entry === "string")
  );
}

function isReportCaseResult(value: unknown): value is ReportCaseResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.darId !== "string" ||
    typeof candidate.title !== "string" ||
    (candidate.platform !== "linux" &&
      candidate.platform !== "macos" &&
      candidate.platform !== "windows") ||
    typeof candidate.durationMs !== "number" ||
    typeof candidate.artifactDir !== "string" ||
    typeof candidate.blocking !== "boolean" ||
    typeof candidate.status !== "string" ||
    !CASE_STATUSES.has(candidate.status as CaseStatus) ||
    !Array.isArray(candidate.failedSubchecks) ||
    !Array.isArray(candidate.subchecks) ||
    !isPlatformExpectation(candidate.expectation)
  ) {
    return false;
  }

  return (
    candidate.failedSubchecks.every((entry) => typeof entry === "string") &&
    candidate.subchecks.every((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return false;
      }

      const subcheck = entry as Record<string, unknown>;
      return (
        typeof subcheck.name === "string" &&
        (subcheck.status === "passed" || subcheck.status === "failed") &&
        typeof subcheck.durationMs === "number" &&
        (subcheck.message === undefined || typeof subcheck.message === "string") &&
        (subcheck.evidence === undefined ||
          (Array.isArray(subcheck.evidence) &&
            subcheck.evidence.every((evidence) => typeof evidence === "string")))
      );
    })
  );
}

export function createResultsReport(
  revision: string,
  generatedAt: string,
  results: readonly ReportCaseResult[]
): ResultsReport {
  return {
    revision,
    generatedAt,
    results: [...results].sort(resultSorter),
  };
}

export function stringifyResultsReport(report: ResultsReport): string {
  return `${JSON.stringify(stableValue(createResultsReport(report.revision, report.generatedAt, report.results)), null, 2)}\n`;
}

export async function writeJsonReport(
  filePath: string,
  report: ResultsReport,
  fs: Partial<ReportFs> = {}
): Promise<void> {
  const resolvedFs = { ...defaultFs(), ...fs };
  await resolvedFs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await resolvedFs.writeFile(temporaryPath, stringifyResultsReport(report), "utf8");
    await resolvedFs.rename(temporaryPath, filePath);
  } catch (error) {
    await resolvedFs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function parseResultsReport(raw: string, sourcePath: string): ResultsReport {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Malformed report JSON in ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Malformed report JSON in ${sourcePath}: expected object`);
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.revision !== "string" ||
    typeof candidate.generatedAt !== "string" ||
    !Array.isArray(candidate.results) ||
    !candidate.results.every((entry) => isReportCaseResult(entry))
  ) {
    throw new Error(`Malformed report JSON in ${sourcePath}: invalid report shape`);
  }

  const seenCaseRows = new Set<string>();
  for (const result of candidate.results as ReportCaseResult[]) {
    const caseKey = `${result.platform}\u0000${result.darId}`;
    if (seenCaseRows.has(caseKey)) {
      throw new Error(
        `Malformed report JSON in ${sourcePath}: duplicate case row for ${result.platform} ${result.darId}`
      );
    }
    seenCaseRows.add(caseKey);
  }

  return createResultsReport(
    candidate.revision,
    candidate.generatedAt,
    candidate.results as ReportCaseResult[]
  );
}
