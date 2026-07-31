import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path, { join, relative, resolve } from "node:path";
import { chromium } from "playwright";
import { CaseArtifacts, caseArtifactDir } from "./artifacts.js";
import { buildArtifacts as buildArtifactsImpl, type BuildArtifacts } from "./build-cache.js";
import { BunCommandRunner, type CommandRunner } from "./command.js";
import { BrowserDriver } from "./drivers/browser.js";
import { compareOutcome } from "./expectations.js";
import {
  RuntimeSupervisor,
  type RuntimeContext,
  type RuntimeSupervisorOptions,
} from "./runtime-supervisor.js";
import {
  SCENARIO_DEFINITIONS,
  validateScenarioDefinitions,
  type DarId,
  type ScenarioDefinition,
} from "./scenario-registry.js";
import { runDar01 as runDar01Impl } from "./scenarios/dar-01.js";
import {
  runDar02 as runDar02Impl,
  type Dar02BrowserDriver,
} from "./scenarios/dar-02.js";
import {
  HarnessError,
  type CaseResult,
  type CaseStatus,
  type HarnessPlatform,
  type PlatformExpectation,
  type SubcheckResult,
} from "./types.js";

const require = createRequire(import.meta.url);
const playwrightPackage = require("playwright/package.json") as { version: string };

const USAGE = [
  "Usage:",
  "  bun run harness doctor",
  "  bun run harness list",
  "  bun run harness run [DAR-01|DAR-02 ...] [--artifact-root <path>]",
  "  bun run harness aggregate [--results-root <path>]",
].join("\n");

const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;
const RESULT_JSON_NAME = "results.json";
const RESULT_MARKDOWN_NAME = "results.md";
const RESULT_JUNIT_NAME = "results.junit.xml";
const SUPPORTED_HOST_PLATFORMS = new Map<NodeJS.Platform | string, HarnessPlatform>([
  ["linux", "linux"],
  ["darwin", "macos"],
  ["win32", "windows"],
]);
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
const REPORT_PLATFORMS: readonly HarnessPlatform[] = ["linux", "macos", "windows"];
const BLOCKING_STATUSES = new Set<CaseStatus>([
  "unexpected-failure",
  "unexpected-pass",
  "expired-expectation",
  "setup-failure",
  "cleanup-failure",
]);

interface CliFs {
  access: typeof access;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  readdir: typeof readdir;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
  writeFile: typeof writeFile;
}

interface DoctorVersions {
  bun: string;
  node: string;
  rustc: string;
  cargo: string;
  playwright: string;
}

interface ResultsReport {
  revision: string;
  generatedAt: string;
  results: CaseResult[];
}

interface BrowserSnapshotDriver extends Dar02BrowserDriver {
  terminalText?(): Promise<string>;
  snapshotTerminalText?(): Promise<string>;
}

export interface RunCliOptions {
  root: string;
  stdout?: { write(chunk: string): void };
  stderr?: { write(chunk: string): void };
  platform?: NodeJS.Platform | string;
  now?: () => Date;
  access?: typeof access;
  fs?: Partial<CliFs>;
  definitions?: readonly ScenarioDefinition[];
  commandRunner?: CommandRunner;
  readToolVersions?: (root: string) => Promise<DoctorVersions>;
  chromiumExecutablePath?: () => string;
  validateScenarioDefinitions?: (
    rootDir: string,
    definitions?: readonly ScenarioDefinition[]
  ) => Promise<void>;
  resolveRevision?: (root: string, runner: CommandRunner, fs: CliFs) => Promise<string>;
  buildArtifacts?: (options: {
    root: string;
    cacheRoot: string;
    platform: HarnessPlatform;
    runner: CommandRunner;
  }) => Promise<BuildArtifacts>;
  createRuntimeSupervisor?: (
    options: RuntimeSupervisorOptions
  ) => Promise<{ context: RuntimeContext; dispose(): Promise<void> }>;
  createBrowserDriver?: (runtime: RuntimeContext) => BrowserSnapshotDriver;
  runDar01?: typeof runDar01Impl;
  runDar02?: typeof runDar02Impl;
}

type ParsedCommand =
  | { kind: "doctor" }
  | { kind: "list" }
  | { kind: "run"; darIds?: DarId[]; artifactRoot?: string }
  | { kind: "aggregate"; resultsRoot?: string }
  | { kind: "help" };

class UsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function defaultFs(): CliFs {
  return {
    access,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
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

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function writeLine(stream: { write(chunk: string): void }, text = ""): void {
  stream.write(`${text}\n`);
}

function assertDarId(value: string): asserts value is DarId {
  if (!SCENARIO_DEFINITIONS.some((definition) => definition.darId === value)) {
    throw new UsageError(`Unknown DAR id: ${value}`);
  }
}

function parseCommand(args: string[]): ParsedCommand {
  const [command, ...rest] = args;

  if (command === undefined || command === "--help" || command === "help") {
    return { kind: "help" };
  }

  if (command === "doctor" || command === "list") {
    if (rest.length > 0) {
      throw new UsageError(`${command} does not accept positional arguments`);
    }
    return { kind: command };
  }

  if (command === "run") {
    let artifactRoot: string | undefined;
    const darIds: DarId[] = [];

    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;
      if (token === "--artifact-root") {
        if (artifactRoot !== undefined) {
          throw new UsageError("Duplicate --artifact-root flag");
        }
        const next = rest[index + 1];
        if (next === undefined) {
          throw new UsageError("Missing value for --artifact-root");
        }
        artifactRoot = next;
        index += 1;
        continue;
      }
      if (token.startsWith("--")) {
        throw new UsageError(`Unknown run flag: ${token}`);
      }
      assertDarId(token);
      if (darIds.includes(token)) {
        throw new UsageError(`Duplicate DAR id: ${token}`);
      }
      darIds.push(token);
    }

    return {
      kind: "run",
      darIds: darIds.length > 0 ? darIds : undefined,
      artifactRoot,
    };
  }

  if (command === "aggregate") {
    let resultsRoot: string | undefined;

    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;
      if (token === "--results-root") {
        if (resultsRoot !== undefined) {
          throw new UsageError("Duplicate --results-root flag");
        }
        const next = rest[index + 1];
        if (next === undefined) {
          throw new UsageError("Missing value for --results-root");
        }
        resultsRoot = next;
        index += 1;
        continue;
      }
      throw new UsageError(`aggregate does not accept positional argument: ${token}`);
    }

    return { kind: "aggregate", resultsRoot };
  }

  throw new UsageError(`Unknown command: ${command}`);
}

function resolvePlatform(platform: NodeJS.Platform | string): HarnessPlatform {
  const resolved = SUPPORTED_HOST_PLATFORMS.get(platform);
  if (resolved === undefined) {
    throw new HarnessError(
      "prerequisite",
      `Unsupported host platform: ${platform}. Expected one of linux, darwin, or win32.`
    );
  }
  return resolved;
}

function resultsSorter(left: CaseResult, right: CaseResult): number {
  return left.platform.localeCompare(right.platform) || left.darId.localeCompare(right.darId);
}

function slugifyHeading(heading: string): string {
  return heading
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}\s-]+/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function formatExpectation(expectation: PlatformExpectation): string {
  if (expectation.expected === "pass") {
    return "pass";
  }
  if (expectation.expected === "unsupported") {
    return `unsupported | reason=${expectation.reason}`;
  }
  return [
    expectation.expected,
    `reason=${expectation.reason}`,
    `tracking=${expectation.tracking}`,
    `reviewAfter=${expectation.reviewAfter}`,
    `allowedFailedSubchecks=${expectation.allowedFailedSubchecks.join(",") || "-"}`,
  ].join(" | ");
}

function usageText(message: string): string {
  return `${message}\n\n${USAGE}\n`;
}

function caseResult(
  definition: ScenarioDefinition,
  platform: HarnessPlatform,
  artifactDir: string,
  durationMs: number,
  subchecks: SubcheckResult[],
  outcome: {
    status: CaseStatus;
    blocking: boolean;
    failedSubchecks: string[];
    message?: string;
  }
): CaseResult {
  return {
    darId: definition.darId,
    title: definition.title,
    platform,
    durationMs,
    subchecks,
    artifactDir,
    status: outcome.status,
    blocking: outcome.blocking,
    failedSubchecks: outcome.failedSubchecks,
    message: outcome.message,
  };
}

async function writeAtomicText(
  filePath: string,
  contents: string,
  fs: CliFs
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await fs.writeFile(temporaryPath, contents, "utf8");
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeAtomicJson(
  filePath: string,
  value: unknown,
  fs: CliFs
): Promise<void> {
  await writeAtomicText(
    filePath,
    `${JSON.stringify(stableValue(value), null, 2)}\n`,
    fs
  );
}

async function readOptionalText(filePath: string, fs: CliFs): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function safeJoinWithin(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ...segments);
  const rel = relative(resolvedRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new HarnessError("prerequisite", `Path escapes harness root: ${segments.join("/")}`);
  }
  return target;
}

function assertSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new HarnessError("prerequisite", `Invalid session id: ${id}`);
  }
}

async function readAuthoritativeSessionText(
  sessionId: string,
  home: string,
  fs: CliFs,
  candidates: string[][]
): Promise<string | undefined> {
  assertSessionId(sessionId);
  const values: string[] = [];

  for (const segments of candidates) {
    const text = await readOptionalText(safeJoinWithin(home, ...segments), fs);
    if (text !== undefined && text.length > 0) {
      values.push(text);
    }
  }

  return values.length > 0 ? values.join("\n") : undefined;
}

async function readLiveSessionArtifacts(
  sessionId: string,
  home: string,
  fs: CliFs
): Promise<string | undefined> {
  return readAuthoritativeSessionText(sessionId, home, fs, [
    ["sessions", `${sessionId}.scrollback`],
    ["sessions", `${sessionId}.log`],
    ["logs", "daemon", `${sessionId}.log`],
  ]);
}

async function readDaemonLogArtifacts(
  sessionId: string,
  home: string,
  fs: CliFs
): Promise<string | undefined> {
  return readAuthoritativeSessionText(sessionId, home, fs, [
    ["logs", "daemon", `${sessionId}.log`],
    ["sessions", `${sessionId}.log`],
  ]);
}

async function defaultReadToolVersions(
  root: string,
  runner: CommandRunner
): Promise<DoctorVersions> {
  const logsRoot = join(root, ".test-tmp", "dar-harness", "doctor", "logs");

  async function commandVersion(
    label: string,
    file: string,
    args: string[]
  ): Promise<string> {
    const result = await runner.run({
      file,
      args,
      cwd: root,
      env: { ...process.env },
      timeoutMs: 30_000,
      stdoutPath: join(logsRoot, `${label}.stdout.log`),
      stderrPath: join(logsRoot, `${label}.stderr.log`),
    });

    if (result.code !== 0) {
      throw new HarnessError(
        "prerequisite",
        `Failed to read ${label} version: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`}`
      );
    }

    return result.stdout.trim();
  }

  return {
    bun: Bun.version,
    node: process.version,
    rustc: await commandVersion("rustc-version", "rustc", ["--version"]),
    cargo: await commandVersion("cargo-version", "cargo", ["--version"]),
    playwright: playwrightPackage.version,
  };
}

async function defaultResolveRevision(
  root: string,
  runner: CommandRunner
): Promise<string> {
  const result = await runner.run({
    file: "git",
    args: ["rev-parse", "HEAD"],
    cwd: root,
    env: { ...process.env },
    timeoutMs: 30_000,
    stdoutPath: join(root, ".test-tmp", "dar-harness", "run", "git.stdout.log"),
    stderrPath: join(root, ".test-tmp", "dar-harness", "run", "git.stderr.log"),
  });

  if (result.code !== 0) {
    throw new HarnessError(
      "prerequisite",
      `Failed to resolve git revision: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`}`
    );
  }

  return result.stdout.trim();
}

function createReport(
  revision: string,
  generatedAt: string,
  results: readonly CaseResult[]
): ResultsReport {
  return {
    revision,
    generatedAt,
    results: [...results].sort(resultsSorter),
  };
}

function expectedLabel(expectation: PlatformExpectation): string {
  return expectation.expected;
}

function renderMarkdown(report: ResultsReport, definitions: Map<string, ScenarioDefinition>): string {
  const lines = [
    "# DAR harness results",
    "",
    `- revision: ${report.revision}`,
    `- generatedAt: ${report.generatedAt}`,
    `- blocking: ${report.results.some((result) => result.blocking) ? "yes" : "no"}`,
    "",
    "| Platform | DAR | Title | Status | Blocking | Expected | Failed subchecks |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const result of report.results) {
    const definition = definitions.get(result.darId)!;
    lines.push(
      `| ${result.platform} | ${result.darId} | ${result.title} | ${result.status} | ${
        result.blocking ? "yes" : "no"
      } | ${expectedLabel(definition.expectations[result.platform])} | ${
        result.failedSubchecks.join(",") || "-"
      } |`
    );
  }

  for (const result of report.results) {
    const definition = definitions.get(result.darId)!;
    const expectation = definition.expectations[result.platform];
    lines.push(
      "",
      `## ${result.platform} / ${result.darId} — ${result.title}`,
      `- manual: ${definition.manualPath}#${slugifyHeading(definition.manualHeading)}`,
      `- artifactDir: ${result.artifactDir}`,
      `- expected: ${expectation.expected}`,
      `- actual status: ${result.status}`,
      `- actual failed subchecks: ${result.failedSubchecks.join(",") || "-"}`,
      `- message: ${result.message ?? "-"}`,
      `- subchecks: ${result.subchecks.map((subcheck) => `${subcheck.name}:${subcheck.status}`).join(",") || "-"}`
    );

    if (expectation.expected === "unsupported") {
      lines.push(`- governance: reason=${expectation.reason}`);
      continue;
    }

    if (expectation.expected !== "pass") {
      lines.push(
        `- governance: reason=${expectation.reason} | tracking=${expectation.tracking} | reviewAfter=${expectation.reviewAfter} | allowedFailedSubchecks=${
          expectation.allowedFailedSubchecks.join(",") || "-"
        }`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function junitElementForCase(result: CaseResult): string {
  const commonBody = [
    `<system-out>${xmlEscape(
      JSON.stringify(
        stableValue({
          artifactDir: result.artifactDir,
          failedSubchecks: result.failedSubchecks,
          message: result.message,
          subchecks: result.subchecks,
        })
      )
    )}</system-out>`,
  ];

  if (result.status === "unsupported" || result.status === "expected-failure" || result.status === "expected-partial") {
    return [
      `<testcase classname="${xmlEscape(`${result.platform}.${result.darId}`)}" name="${xmlEscape(
        `${result.darId} ${result.title}`
      )}" time="${durationSeconds(result.durationMs)}">`,
      `<skipped message="${xmlEscape(result.status)}">${xmlEscape(result.message ?? result.status)}</skipped>`,
      ...commonBody,
      "</testcase>",
    ].join("");
  }

  if (BLOCKING_STATUSES.has(result.status)) {
    return [
      `<testcase classname="${xmlEscape(`${result.platform}.${result.darId}`)}" name="${xmlEscape(
        `${result.darId} ${result.title}`
      )}" time="${durationSeconds(result.durationMs)}">`,
      `<failure message="${xmlEscape(result.status)}">${xmlEscape(result.message ?? result.status)}</failure>`,
      ...commonBody,
      "</testcase>",
    ].join("");
  }

  return [
    `<testcase classname="${xmlEscape(`${result.platform}.${result.darId}`)}" name="${xmlEscape(
      `${result.darId} ${result.title}`
    )}" time="${durationSeconds(result.durationMs)}">`,
    ...commonBody,
    "</testcase>",
  ].join("");
}

function renderJUnit(report: ResultsReport): string {
  const failures = report.results.filter((result) => BLOCKING_STATUSES.has(result.status)).length;
  const skipped = report.results.filter(
    (result) =>
      result.status === "unsupported" ||
      result.status === "expected-failure" ||
      result.status === "expected-partial"
  ).length;
  const testcases = report.results.map((result) => junitElementForCase(result)).join("");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="dar-harness" tests="${report.results.length}" failures="${failures}" skipped="${skipped}" time="${durationSeconds(
      report.results.reduce((sum, result) => sum + result.durationMs, 0)
    )}">`,
    `<properties><property name="revision" value="${xmlEscape(report.revision)}"/><property name="generatedAt" value="${xmlEscape(
      report.generatedAt
    )}"/></properties>`,
    testcases,
    "</testsuite>",
    "",
  ].join("");
}

async function writeReportSet(
  resultsRoot: string,
  report: ResultsReport,
  definitions: Map<string, ScenarioDefinition>,
  fs: CliFs
): Promise<void> {
  await writeAtomicJson(join(resultsRoot, RESULT_JSON_NAME), report, fs);
  await writeAtomicText(join(resultsRoot, RESULT_MARKDOWN_NAME), renderMarkdown(report, definitions), fs);
  await writeAtomicText(join(resultsRoot, RESULT_JUNIT_NAME), renderJUnit(report), fs);
}

function isCaseResult(value: unknown): value is CaseResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.darId !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.platform !== "string" ||
    typeof candidate.durationMs !== "number" ||
    typeof candidate.artifactDir !== "string" ||
    typeof candidate.blocking !== "boolean" ||
    typeof candidate.status !== "string" ||
    !CASE_STATUSES.has(candidate.status as CaseStatus) ||
    !Array.isArray(candidate.failedSubchecks) ||
    !Array.isArray(candidate.subchecks)
  ) {
    return false;
  }

  return candidate.failedSubchecks.every((entry) => typeof entry === "string") && candidate.subchecks.every((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const subcheck = entry as Record<string, unknown>;
    return (
      typeof subcheck.name === "string" &&
      (subcheck.status === "passed" || subcheck.status === "failed") &&
      typeof subcheck.durationMs === "number" &&
      (subcheck.message === undefined || typeof subcheck.message === "string")
    );
  });
}

function parseResultsReport(raw: string, sourcePath: string): ResultsReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Malformed report JSON in ${sourcePath}: ${formatError(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Malformed report JSON in ${sourcePath}: expected object`);
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.revision !== "string" ||
    typeof candidate.generatedAt !== "string" ||
    !Array.isArray(candidate.results) ||
    !candidate.results.every((entry) => isCaseResult(entry))
  ) {
    throw new Error(`Malformed report JSON in ${sourcePath}: invalid report shape`);
  }

  return {
    revision: candidate.revision,
    generatedAt: candidate.generatedAt,
    results: candidate.results as CaseResult[],
  };
}

async function collectResultReportPaths(
  root: string,
  fs: CliFs
): Promise<string[]> {
  const aggregateOutputPath = resolve(root, RESULT_JSON_NAME);
  const queue = [resolve(root)];
  const matches: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === RESULT_JSON_NAME && resolve(entryPath) !== aggregateOutputPath) {
        matches.push(entryPath);
      }
    }
  }

  return matches.sort();
}

function definitionsMap(definitions: readonly ScenarioDefinition[]): Map<string, ScenarioDefinition> {
  return new Map(definitions.map((definition) => [definition.darId, definition]));
}

function validateAggregateReports(
  reports: Array<{ path: string; report: ResultsReport }>,
  definitions: readonly ScenarioDefinition[]
): ResultsReport {
  if (reports.length === 0) {
    throw new Error("No nested results.json files found to aggregate");
  }

  const expectedDarIds = new Set<string>(definitions.map((definition) => definition.darId));
  const revision = reports[0]!.report.revision;
  const platformReports = new Map<HarnessPlatform, ResultsReport>();
  const combinedResults: CaseResult[] = [];

  for (const { path: sourcePath, report } of reports) {
    if (report.revision !== revision) {
      throw new Error(
        `Inconsistent revision across reports: expected ${revision}, found ${report.revision} in ${sourcePath}`
      );
    }

    const platforms = new Set(report.results.map((result) => result.platform));
    if (platforms.size !== 1) {
      throw new Error(`Malformed report ${sourcePath}: expected exactly one platform per report`);
    }
    const [platform] = [...platforms] as HarnessPlatform[];
    if (!REPORT_PLATFORMS.includes(platform)) {
      throw new Error(`Malformed report ${sourcePath}: unsupported platform ${platform}`);
    }
    if (platformReports.has(platform)) {
      throw new Error(`Duplicate platform results for ${platform}`);
    }

    const darIds = new Set(report.results.map((result) => result.darId));
    if (darIds.size !== expectedDarIds.size) {
      throw new Error(`Malformed report ${sourcePath}: expected ${expectedDarIds.size} DAR results`);
    }

    for (const darId of expectedDarIds) {
      if (!darIds.has(darId)) {
        throw new Error(`Malformed report ${sourcePath}: missing ${darId}`);
      }
    }

    platformReports.set(platform, report);
    combinedResults.push(...report.results);
  }

  for (const platform of REPORT_PLATFORMS) {
    if (!platformReports.has(platform)) {
      throw new Error(`Missing platform results for ${platform}`);
    }
  }

  for (const result of combinedResults) {
    if (!expectedDarIds.has(result.darId)) {
      throw new Error(`Malformed aggregate input: unexpected DAR id ${result.darId}`);
    }
  }

  return createReport(
    revision,
    reports.map(({ report }) => report.generatedAt).sort().at(-1) ?? new Date().toISOString(),
    combinedResults
  );
}

async function executeRun(
  parsed: Extract<ParsedCommand, { kind: "run" }>,
  options: Required<Pick<RunCliOptions, "root">> & RunCliOptions,
  fs: CliFs,
  stdout: { write(chunk: string): void },
  definitions: readonly ScenarioDefinition[]
): Promise<number> {
  const runner = options.commandRunner ?? new BunCommandRunner();
  const platform = resolvePlatform(options.platform ?? process.platform);
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const artifactRoot =
    parsed.artifactRoot !== undefined
      ? resolve(options.root, parsed.artifactRoot)
      : join(options.root, ".test-tmp", "dar-harness", platform);
  const selectedDefinitions = parsed.darIds
    ? definitions.filter((definition) => parsed.darIds!.includes(definition.darId))
    : [...definitions];

  await (options.validateScenarioDefinitions ?? validateScenarioDefinitions)(options.root, definitions);

  const supportedDefinitions = selectedDefinitions.filter(
    (definition) => definition.expectations[platform].expected !== "unsupported"
  );
  const revision = options.resolveRevision
    ? await options.resolveRevision(options.root, runner, fs)
    : await defaultResolveRevision(options.root, runner);

  let build: BuildArtifacts | undefined;
  if (supportedDefinitions.length > 0) {
    build = await (options.buildArtifacts ?? buildArtifactsImpl)({
      root: options.root,
      cacheRoot: join(options.root, ".test-tmp", "dar-harness", "build"),
      platform,
      runner,
    });
  }

  const createRuntimeSupervisor = options.createRuntimeSupervisor ?? RuntimeSupervisor.create;
  const createBrowserDriver = options.createBrowserDriver ?? ((runtime: RuntimeContext) => new BrowserDriver(runtime));
  const runDar01 = options.runDar01 ?? runDar01Impl;
  const runDar02 = options.runDar02 ?? runDar02Impl;
  const lookup = definitionsMap(definitions);
  const results: CaseResult[] = [];

  for (const definition of selectedDefinitions) {
    const expectation = definition.expectations[platform];
    const artifactDir = caseArtifactDir(artifactRoot, definition.darId);
    const startedAt = now().getTime();
    const artifacts = new CaseArtifacts(artifactDir);
    let result: CaseResult;
    let runtime: Awaited<ReturnType<typeof createRuntimeSupervisor>> | undefined;

    if (expectation.expected === "unsupported") {
      await artifacts.initialize();
      result = caseResult(
        definition,
        platform,
        artifactDir,
        Math.max(0, now().getTime() - startedAt),
        [],
        compareOutcome(expectation, [], now())
      );
    } else {
      try {
        if (!build) {
          throw new HarnessError("build", "Build artifacts were not created");
        }

        runtime = await createRuntimeSupervisor({
          root: options.root,
          darId: definition.darId,
          artifactRoot,
          platform,
          build,
          runner,
        });

        let subchecks: SubcheckResult[];
        if (definition.darId === "DAR-01") {
          subchecks = await runDar01(
            {
              platform,
              overallDeadline: startedAt + definition.timeoutMs,
              build,
              runtime: {
                root: runtime.context.root,
                env: runtime.context.env,
                artifacts: runtime.context.artifacts,
              },
            },
            {}
          );
        } else {
          const browser = createBrowserDriver(runtime.context) as BrowserSnapshotDriver;
          const snapshotTerminalText = async () => {
            if (typeof browser.snapshotTerminalText === "function") {
              return browser.snapshotTerminalText();
            }
            if (typeof browser.terminalText === "function") {
              return browser.terminalText();
            }
            throw new HarnessError(
              "browser",
              "Browser driver does not expose terminalText() or snapshotTerminalText()"
            );
          };

          subchecks = await runDar02(
            {
              platform,
              overallDeadline: startedAt + definition.timeoutMs,
              build,
              browser,
              runtime: {
                root: runtime.context.root,
                home: runtime.context.home,
                baseUrl: runtime.context.baseUrl,
                env: runtime.context.env,
                artifacts: runtime.context.artifacts,
                processes: runtime.context.processes,
                sessions: runtime.context.sessions,
              },
            },
            {
              readLiveScrollback: (sessionId, home) =>
                readLiveSessionArtifacts(sessionId, home, fs),
              readDaemonLog: (sessionId, home) =>
                readDaemonLogArtifacts(sessionId, home, fs),
              snapshotTerminalText,
            }
          );
        }

        result = caseResult(
          definition,
          platform,
          artifactDir,
          Math.max(0, now().getTime() - startedAt),
          subchecks,
          compareOutcome(expectation, subchecks, now())
        );
      } catch (error) {
        result = caseResult(
          definition,
          platform,
          artifactDir,
          Math.max(0, now().getTime() - startedAt),
          [],
          {
            status: "setup-failure",
            blocking: true,
            failedSubchecks: [],
            message: formatError(error),
          }
        );
      }
    }

    if (runtime) {
      try {
        await runtime.dispose();
      } catch (error) {
        result = {
          ...result,
          status: "cleanup-failure",
          blocking: true,
          message: `cleanup-failure after ${result.status}: ${formatError(error)}${
            result.message ? `; prior message: ${result.message}` : ""
          }`,
        };
      }
    }

    if (!runtime) {
      await artifacts.initialize();
      await artifacts.writeJson("result.json", result);
    } else {
      await runtime.context.artifacts.writeJson("result.json", result);
    }

    results.push(result);
    await writeReportSet(artifactRoot, createReport(revision, generatedAt, results), lookup, fs);
  }

  const finalReport = createReport(revision, generatedAt, results);
  await writeReportSet(artifactRoot, finalReport, lookup, fs);

  for (const result of finalReport.results) {
    writeLine(
      stdout,
      `${result.platform} ${result.darId} ${result.status}${result.message ? ` — ${result.message}` : ""}`
    );
  }

  return finalReport.results.some((result) => result.blocking) ? 1 : 0;
}

async function executeDoctor(
  options: Required<Pick<RunCliOptions, "root">> & RunCliOptions,
  fs: CliFs,
  stdout: { write(chunk: string): void },
  definitions: readonly ScenarioDefinition[]
): Promise<number> {
  const runner = options.commandRunner ?? new BunCommandRunner();
  const checks: string[] = [];
  const failures: string[] = [];

  try {
    const platform = resolvePlatform(options.platform ?? process.platform);
    checks.push(`host-platform: ${platform}`);
  } catch (error) {
    failures.push(formatError(error));
  }

  try {
    await (options.validateScenarioDefinitions ?? validateScenarioDefinitions)(options.root, definitions);
    checks.push(`scenario-definitions: ok (${definitions.length} scenarios)`);
  } catch (error) {
    failures.push(formatError(error));
  }

  try {
    const versions = await (options.readToolVersions ?? ((root: string) => defaultReadToolVersions(root, runner)))(
      options.root
    );
    checks.push(`bun: ${versions.bun}`);
    checks.push(`node: ${versions.node}`);
    checks.push(`rustc: ${versions.rustc}`);
    checks.push(`cargo: ${versions.cargo}`);
    checks.push(`playwright: ${versions.playwright}`);
  } catch (error) {
    failures.push(formatError(error));
  }

  try {
    const chromiumPath = (options.chromiumExecutablePath ?? (() => chromium.executablePath()))();
    await (options.access ?? fs.access)(chromiumPath, constants.F_OK);
    checks.push(`chromium: ${chromiumPath}`);
  } catch (error) {
    failures.push(formatError(error));
  }

  try {
    const fixtureManifest = join(options.root, "harness", "fixtures", "Cargo.toml");
    await fs.access(fixtureManifest, constants.F_OK);
    checks.push(`fixture-manifest: ${fixtureManifest}`);
  } catch (error) {
    failures.push(formatError(error));
  }

  if (failures.length > 0) {
    writeLine(stdout, "Doctor failed");
    for (const failure of failures) {
      writeLine(stdout, `- ${failure}`);
    }
    return 2;
  }

  writeLine(stdout, "Doctor OK");
  for (const check of checks) {
    writeLine(stdout, `- ${check}`);
  }
  return 0;
}

async function executeList(
  stdout: { write(chunk: string): void },
  definitions: readonly ScenarioDefinition[]
): Promise<number> {
  for (const definition of definitions) {
    writeLine(stdout, `${definition.darId} ${definition.title}`);
    writeLine(
      stdout,
      `  manual: ${definition.manualPath}#${slugifyHeading(definition.manualHeading)}`
    );
    for (const platform of REPORT_PLATFORMS) {
      writeLine(stdout, `  ${platform}: ${formatExpectation(definition.expectations[platform])}`);
    }
  }
  return 0;
}

async function executeAggregate(
  parsed: Extract<ParsedCommand, { kind: "aggregate" }>,
  options: Required<Pick<RunCliOptions, "root">> & RunCliOptions,
  fs: CliFs,
  stdout: { write(chunk: string): void },
  definitions: readonly ScenarioDefinition[]
): Promise<number> {
  const resultsRoot =
    parsed.resultsRoot !== undefined
      ? resolve(options.root, parsed.resultsRoot)
      : join(options.root, ".test-tmp", "dar-harness");
  const lookup = definitionsMap(definitions);

  try {
    const reportPaths = await collectResultReportPaths(resultsRoot, fs);
    const reports = await Promise.all(
      reportPaths.map(async (reportPath) => ({
        path: reportPath,
        report: parseResultsReport(await fs.readFile(reportPath, "utf8"), reportPath),
      }))
    );
    const aggregate = validateAggregateReports(reports, definitions);
    await writeReportSet(resultsRoot, aggregate, lookup, fs);

    for (const result of aggregate.results) {
      writeLine(
        stdout,
        `${result.platform} ${result.darId} ${result.status}${result.message ? ` — ${result.message}` : ""}`
      );
    }

    return aggregate.results.some((result) => result.blocking) ? 1 : 0;
  } catch (error) {
    writeLine(stdout, formatError(error));
    return 2;
  }
}

export async function runCli(args: string[], options: RunCliOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const fs = { ...defaultFs(), ...(options.fs ?? {}) };
  const definitions = options.definitions ?? SCENARIO_DEFINITIONS;

  let parsed: ParsedCommand;
  try {
    parsed = parseCommand(args);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(usageText(error.message));
      return 2;
    }
    throw error;
  }

  if (parsed.kind === "help") {
    stderr.write(`${USAGE}\n`);
    return 2;
  }

  if (parsed.kind === "doctor") {
    return executeDoctor(options as Required<Pick<RunCliOptions, "root">> & RunCliOptions, fs, stdout, definitions);
  }

  if (parsed.kind === "list") {
    return executeList(stdout, definitions);
  }

  if (parsed.kind === "run") {
    return executeRun(parsed, options as Required<Pick<RunCliOptions, "root">> & RunCliOptions, fs, stdout, definitions);
  }

  return executeAggregate(
    parsed,
    options as Required<Pick<RunCliOptions, "root">> & RunCliOptions,
    fs,
    stdout,
    definitions
  );
}
