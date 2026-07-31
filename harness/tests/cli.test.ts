import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BuildArtifacts } from "../src/build-cache.js";
import { CaseArtifacts, caseArtifactDir } from "../src/artifacts.js";
import type { ReportCaseResult } from "../src/reporters/json.js";
import type { RuntimeContext, RuntimeSupervisorOptions } from "../src/runtime-supervisor.js";
import type { ScenarioDefinition } from "../src/scenario-registry.js";
import type { Dar02BrowserDriver } from "../src/scenarios/dar-02.js";
import type { CaseResult, HarnessPlatform, PlatformExpectation, SubcheckResult } from "../src/types.js";

const cliModule = await import("../src/cli.js").catch(() => null);
const runCli = (cliModule as { runCli?: (args: string[], options: Record<string, unknown>) => Promise<number> } | null)?.runCli;

const FIXED_NOW = new Date("2026-07-31T21:27:33.660Z");
const DEFAULT_REVISION = "d7fa2160cad31941dfb4480fdf07cce0c796dcee";

interface CapturedStream {
  text: string;
  write(chunk: string): void;
}

class MemoryStream implements CapturedStream {
  public text = "";

  public write(chunk: string): void {
    this.text += chunk;
  }
}

class FakeBrowserDriver implements Dar02BrowserDriver {
  public readonly terminalSnapshots: string[] = [];

  public async open(): Promise<void> {}

  public async waitForSessionStatus(): Promise<void> {}

  public async openTerminal(): Promise<void> {}

  public async waitForTerminalText(): Promise<void> {}

  public async sendTerminalLine(): Promise<void> {}

  public async closeViewer(): Promise<void> {}

  public async reopenViewer(): Promise<void> {}

  public async terminalText(): Promise<string> {
    return this.terminalSnapshots.at(-1) ?? "";
  }
}

function requireRunCli(): (args: string[], options: Record<string, unknown>) => Promise<number> {
  expect(runCli).toBeDefined();
  return runCli!;
}

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

function createDefinitions(
  expectations: Partial<Record<ScenarioDefinition["darId"], Record<HarnessPlatform, PlatformExpectation>>> = {}
): readonly ScenarioDefinition[] {
  return [
    {
      darId: "DAR-01",
      title: "Attached shell input, output, and terminal restoration",
      manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
      manualHeading:
        "## DAR-01 — Attached shell: input, output, and raw-mode restoration",
      suite: "dar",
      timeoutMs: 1_000,
      expectations: expectations["DAR-01"] ?? {
        linux: { expected: "pass" },
        macos: { expected: "pass" },
        windows: {
          expected: "unsupported",
          reason: "Windows coverage is intentionally skipped in this unit test.",
        },
      },
    },
    {
      darId: "DAR-02",
      title: "Headless session dashboard replay and live output",
      manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
      manualHeading:
        "## DAR-02 — Headless session and dashboard attach / replay",
      suite: "dar",
      timeoutMs: 1_000,
      expectations: expectations["DAR-02"] ?? {
        linux: {
          expected: "partial",
          reason: "Replay is still flaky on Linux in this unit test.",
          tracking: "docs/manual-tests/results/linux.md",
          reviewAfter: "2026-08-31",
          allowedFailedSubchecks: ["replay-visible"],
        },
        macos: { expected: "pass" },
        windows: {
          expected: "unsupported",
          reason: "Windows coverage is intentionally skipped in this unit test.",
        },
      },
    },
  ];
}

function passedSubcheck(name: string): SubcheckResult {
  return {
    name,
    status: "passed",
    durationMs: 12,
  };
}

function failedSubcheck(name: string, message = `${name} failed`): SubcheckResult {
  return {
    name,
    status: "failed",
    durationMs: 12,
    message,
  };
}

function createRuntimeFactory(record: { disposals: string[]; createCalls: string[] }) {
  return async function createRuntimeSupervisor(
    options: RuntimeSupervisorOptions
  ): Promise<{ context: RuntimeContext; dispose(): Promise<void> }> {
    record.createCalls.push(options.darId);
    const artifacts = new CaseArtifacts(caseArtifactDir(options.artifactRoot, options.darId));
    await artifacts.initialize();

    return {
      context: {
        root: options.root,
        home: join(options.artifactRoot, "homes", options.darId),
        baseUrl: "http://127.0.0.1:43123/",
        env: { CLIMON_HOME: join(options.artifactRoot, "homes", options.darId) },
        artifacts,
        processes: {
          register() {
            return Promise.resolve();
          },
        } as unknown as RuntimeContext["processes"],
        sessions: {
          track() {},
          waitForStatus() {
            return Promise.resolve({ id: "session-1", status: "running" });
          },
          waitForTerminalStatus() {
            return Promise.resolve({ id: "session-1", status: "completed" });
          },
          read() {
            return Promise.resolve({ id: "session-1", status: "completed", exitCode: 0 });
          },
        } as unknown as RuntimeContext["sessions"],
        browser: {} as RuntimeContext["browser"],
        context: {} as RuntimeContext["context"],
        page: {} as RuntimeContext["page"],
      },
      async dispose() {
        record.disposals.push(options.darId);
      },
    };
  };
}

function createRunOptions(
  workspace: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const runtimeRecord = { disposals: [] as string[], createCalls: [] as string[] };

  return {
    root: workspace,
    platform: "linux",
    stdout,
    stderr,
    now: () => FIXED_NOW,
    definitions: createDefinitions(),
    validateScenarioDefinitions: async () => undefined,
    readToolVersions: async () => ({
      bun: "1.3.10",
      node: "v24.0.0",
      rustc: "rustc 1.89.0",
      cargo: "cargo 1.89.0",
      playwright: "1.62.1",
    }),
    chromiumExecutablePath: () => join(workspace, "bin", "chromium"),
    access,
    fs: { access, mkdir, readFile, readdir, rename, rm, stat, writeFile },
    resolveRevision: async () => DEFAULT_REVISION,
    buildArtifacts: async () =>
      ({
        clientPath: join(workspace, "dist", "climon"),
        serverPath: join(workspace, "dist", "climon-server"),
        fixturePath: join(workspace, "dist", "climon-harness-fixture"),
        revision: DEFAULT_REVISION,
        manifestPath: join(workspace, ".test-tmp", "e2e-harness", "build", "manifest.json"),
      }) satisfies BuildArtifacts,
    createRuntimeSupervisor: createRuntimeFactory(runtimeRecord),
    createBrowserDriver: () => new FakeBrowserDriver(),
    runDar01: async () => [passedSubcheck("attached-startup")],
    runDar02: async () => [failedSubcheck("replay-visible", "Replay was intentionally allowed to fail.")],
    runtimeRecord,
    ...overrides,
  };
}

function writeDoctorFixtureFiles(workspace: string): void {
  mkdirSync(join(workspace, "docs", "manual-tests"), { recursive: true });
  mkdirSync(join(workspace, "harness", "fixtures"), { recursive: true });
  mkdirSync(join(workspace, "bin"), { recursive: true });
  writeFileSync(
    join(workspace, "docs", "manual-tests", "daemon-actor-rewrite.md"),
    [
      "# Daemon actor rewrite",
      "",
      "## DAR-01 — Attached shell: input, output, and raw-mode restoration",
      "",
      "## DAR-02 — Headless session and dashboard attach / replay",
    ].join("\n")
  );
  writeFileSync(join(workspace, "harness", "fixtures", "Cargo.toml"), "[package]\nname = \"fixture\"\n");
  writeFileSync(join(workspace, "bin", "chromium"), "");
}

function expectedListOutput(): string {
  return [
    "DAR-01 Attached shell input, output, and terminal restoration",
    "  manual: docs/manual-tests/daemon-actor-rewrite.md#dar-01-attached-shell-input-output-and-raw-mode-restoration",
    "  linux: pass",
    "  macos: pass",
    "  windows: unsupported | reason=Windows coverage is intentionally skipped in this unit test.",
    "DAR-02 Headless session dashboard replay and live output",
    "  manual: docs/manual-tests/daemon-actor-rewrite.md#dar-02-headless-session-and-dashboard-attach-replay",
    "  linux: partial | reason=Replay is still flaky on Linux in this unit test. | tracking=docs/manual-tests/results/linux.md | reviewAfter=2026-08-31 | allowedFailedSubchecks=replay-visible",
    "  macos: pass",
    "  windows: unsupported | reason=Windows coverage is intentionally skipped in this unit test.",
  ].join("\n") + "\n";
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function expectationFor(
  definitions: readonly ScenarioDefinition[],
  darId: ScenarioDefinition["darId"],
  platform: HarnessPlatform
): PlatformExpectation {
  const definition = definitions.find((candidate) => candidate.darId === darId);
  expect(definition).toBeDefined();
  return definition!.expectations[platform];
}

function definitionFor(
  definitions: readonly ScenarioDefinition[],
  darId: ScenarioDefinition["darId"]
): ScenarioDefinition {
  const definition = definitions.find((candidate) => candidate.darId === darId);
  expect(definition).toBeDefined();
  return definition!;
}

function writeAggregateReport(
  root: string,
  reportRoot: string,
  platform: HarnessPlatform,
  definitions: readonly ScenarioDefinition[],
  darIds: readonly ScenarioDefinition["darId"][]
): void {
  mkdirSync(reportRoot, { recursive: true });
  writeFileSync(
    join(reportRoot, "results.json"),
    `${JSON.stringify(
      {
        revision: DEFAULT_REVISION,
        generatedAt: FIXED_NOW.toISOString(),
        results: darIds.map((darId) => ({
          artifactDir: join(root, platform, "cases", darId),
          blocking: false,
          darId,
          durationMs: 1,
          expectation: expectationFor(definitions, darId, platform),
          failedSubchecks: [],
          platform,
          status: "passed",
          subchecks: [],
          title: definitionFor(definitions, darId).title,
        })),
      },
      null,
      2
    )}\n`
  );
}

describe("runCli", () => {
  test("loads the harness CLI module", () => {
    expect(runCli).toBeDefined();
  });

  test("prints the deterministic scenario list with governance details", async () => {
    const workspace = makeWorkspace("cli-list");

    try {
      const options = createRunOptions(workspace);
      const cli = requireRunCli();

      await expect(cli(["list"], options)).resolves.toBe(0);

      expect((options.stdout as CapturedStream).text).toBe(expectedListOutput());
      expect((options.stderr as CapturedStream).text).toBe("");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects duplicate scenario ids, duplicate flags, and missing option values with usage exit code 2", async () => {
    const workspace = makeWorkspace("cli-usage");

    try {
      const cli = requireRunCli();

      for (const args of [
        ["run", "DAR-01", "DAR-01"],
        ["aggregate", "--results-root", "one", "--results-root", "two"],
        ["run", "--artifact-root"],
      ]) {
        const options = createRunOptions(workspace);
        await expect(cli(args, options)).resolves.toBe(2);
        expect((options.stderr as CapturedStream).text).toContain("Usage:");
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("fails doctor with exit code 2 when prerequisites are missing", async () => {
    const workspace = makeWorkspace("cli-doctor");

    try {
      writeDoctorFixtureFiles(workspace);
      const options = createRunOptions(workspace, {
        validateScenarioDefinitions: async () => {
          throw new Error("manual heading drift");
        },
        access: async (path: string) => {
          if (String(path).includes("chromium")) {
            throw new Error("chromium missing");
          }
        },
      });
      const cli = requireRunCli();

      await expect(cli(["doctor"], options)).resolves.toBe(2);

      expect((options.stdout as CapturedStream).text).toContain("Doctor failed");
      expect((options.stdout as CapturedStream).text).toContain("manual heading drift");
      expect((options.stdout as CapturedStream).text).toContain("chromium missing");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("runs only the selected scenario, disposes the runtime, and writes stable reports", async () => {
    const workspace = makeWorkspace("cli-run-selected");

    try {
      const options = createRunOptions(workspace);
      writeDoctorFixtureFiles(workspace);
      const cli = requireRunCli();

      await expect(
        cli(["run", "DAR-02", "--artifact-root", join(workspace, "artifacts")], options)
      ).resolves.toBe(0);

      expect((options.runtimeRecord as { createCalls: string[] }).createCalls).toEqual(["DAR-02"]);
      expect((options.runtimeRecord as { disposals: string[] }).disposals).toEqual(["DAR-02"]);

      const result = readJson(
        join(workspace, "artifacts", "cases", "DAR-02", "result.json")
      ) as CaseResult;
      expect(result).toMatchObject({
        darId: "DAR-02",
        platform: "linux",
        status: "expected-partial",
        blocking: false,
        failedSubchecks: ["replay-visible"],
      });

      expect(readJson(join(workspace, "artifacts", "results.json"))).toEqual({
        revision: DEFAULT_REVISION,
        generatedAt: FIXED_NOW.toISOString(),
        results: [
          {
            artifactDir: join(workspace, "artifacts", "cases", "DAR-02"),
            blocking: false,
            darId: "DAR-02",
            durationMs: 0,
            expectation: {
              allowedFailedSubchecks: ["replay-visible"],
              expected: "partial",
              reason: "Replay is still flaky on Linux in this unit test.",
              reviewAfter: "2026-08-31",
              tracking: "docs/manual-tests/results/linux.md",
            },
            failedSubchecks: ["replay-visible"],
            message:
              "Expected partial result: Replay is still flaky on Linux in this unit test. (tracking: docs/manual-tests/results/linux.md; review after: 2026-08-31)",
            platform: "linux",
            status: "expected-partial",
            subchecks: [
              {
                durationMs: 12,
                message: "Replay was intentionally allowed to fail.",
                name: "replay-visible",
                status: "failed",
              },
            ],
            title: "Headless session dashboard replay and live output",
          },
        ],
      });

      expect(readFileSync(join(workspace, "artifacts", "summary.md"), "utf8")).toContain(
        "| linux | DAR-02 | Headless session dashboard replay and live output | expected-partial | no | partial | replay-visible |"
      );
      expect(readFileSync(join(workspace, "artifacts", "junit.xml"), "utf8")).toContain(
        '<skipped message="expected-partial"'
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("returns exit code 1 for blocking unexpected failures", async () => {
    const workspace = makeWorkspace("cli-run-blocking");

    try {
      writeDoctorFixtureFiles(workspace);
      const options = createRunOptions(workspace, {
        definitions: createDefinitions({
          "DAR-01": {
            linux: { expected: "pass" },
            macos: { expected: "pass" },
            windows: { expected: "pass" },
          },
        }),
        buildArtifacts: async ({ cacheRoot }: { cacheRoot: string }) => {
          expect(cacheRoot).toBe(join(workspace, ".test-tmp", "e2e-harness", "build"));
          return {
            clientPath: join(workspace, "dist", "climon"),
            serverPath: join(workspace, "dist", "climon-server"),
            fixturePath: join(workspace, "dist", "climon-harness-fixture"),
            revision: DEFAULT_REVISION,
            manifestPath: join(workspace, ".test-tmp", "e2e-harness", "build", "manifest.json"),
          } satisfies BuildArtifacts;
        },
        runDar01: async () => [failedSubcheck("attached-startup")],
      });
      const cli = requireRunCli();

      await expect(cli(["run", "DAR-01"], options)).resolves.toBe(1);

      expect(readJson(join(workspace, ".test-tmp", "e2e-harness", "linux", "results.json"))).toEqual({
        revision: DEFAULT_REVISION,
        generatedAt: FIXED_NOW.toISOString(),
        results: [
          {
            artifactDir: join(
              workspace,
              ".test-tmp",
              "e2e-harness",
              "linux",
              "cases",
              "DAR-01"
            ),
            blocking: true,
            darId: "DAR-01",
            durationMs: 0,
            expectation: {
              expected: "pass",
            },
            failedSubchecks: ["attached-startup"],
            platform: "linux",
            status: "unexpected-failure",
            subchecks: [
              {
                durationMs: 12,
                message: "attached-startup failed",
                name: "attached-startup",
                status: "failed",
              },
            ],
            title: "Attached shell input, output, and terminal restoration",
          },
        ],
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("preserves cleanup failures even when the scenario itself already failed", async () => {
    const workspace = makeWorkspace("cli-run-cleanup");

    try {
      writeDoctorFixtureFiles(workspace);
      const runtimeRecord = { disposals: [] as string[], createCalls: [] as string[] };
      const options = createRunOptions(workspace, {
        createRuntimeSupervisor: async (runtimeOptions: RuntimeSupervisorOptions) => {
          const artifacts = new CaseArtifacts(caseArtifactDir(runtimeOptions.artifactRoot, runtimeOptions.darId));
          await artifacts.initialize();
          runtimeRecord.createCalls.push(runtimeOptions.darId);

          return {
            context: {
              root: runtimeOptions.root,
              home: join(runtimeOptions.artifactRoot, "homes", runtimeOptions.darId),
              baseUrl: "http://127.0.0.1:43123/",
              env: {},
              artifacts,
              processes: { register() { return Promise.resolve(); } } as unknown as RuntimeContext["processes"],
              sessions: {
                track() {},
                waitForStatus() {
                  return Promise.resolve({ id: "session-1", status: "running" });
                },
                waitForTerminalStatus() {
                  return Promise.resolve({ id: "session-1", status: "completed" });
                },
                read() {
                  return Promise.resolve({ id: "session-1", status: "completed", exitCode: 0 });
                },
              } as unknown as RuntimeContext["sessions"],
              browser: {} as RuntimeContext["browser"],
              context: {} as RuntimeContext["context"],
              page: {} as RuntimeContext["page"],
            },
            async dispose() {
              runtimeRecord.disposals.push(runtimeOptions.darId);
              throw new Error("runtime cleanup failed");
            },
          };
        },
        runDar01: async () => [failedSubcheck("attached-startup", "scenario failed first")],
      });
      const cli = requireRunCli();

      await expect(cli(["run", "DAR-01"], options)).resolves.toBe(1);

      const result = readJson(
        join(workspace, ".test-tmp", "e2e-harness", "linux", "cases", "DAR-01", "result.json")
      ) as CaseResult;
      expect(result.status).toBe("cleanup-failure");
      expect(result.blocking).toBe(true);
      expect(result.message).toContain("runtime cleanup failed");
      expect(result.message).toContain("unexpected-failure");
      expect(runtimeRecord.disposals).toEqual(["DAR-01"]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("preserves setup-failure logs when runtime creation initialized the case before throwing", async () => {
    const workspace = makeWorkspace("cli-run-setup-failure-artifacts");

    try {
      writeDoctorFixtureFiles(workspace);
      const options = createRunOptions(workspace, {
        createRuntimeSupervisor: async (runtimeOptions: RuntimeSupervisorOptions) => {
          const artifacts = new CaseArtifacts(caseArtifactDir(runtimeOptions.artifactRoot, runtimeOptions.darId));
          await artifacts.initialize();
          await artifacts.appendText("logs/server.stderr.log", "runtime boot stderr\n");
          throw new Error("runtime bootstrap exploded");
        },
      });
      const cli = requireRunCli();

      await expect(cli(["run", "DAR-01"], options)).resolves.toBe(1);

      const caseDir = join(
        workspace,
        ".test-tmp",
        "e2e-harness",
        "linux",
        "cases",
        "DAR-01"
      );
      const result = readJson(join(caseDir, "result.json")) as CaseResult;

      expect(result.status).toBe("setup-failure");
      expect(result.message).toContain("runtime bootstrap exploded");
      expect(readFileSync(join(caseDir, "logs", "server.stderr.log"), "utf8")).toBe(
        "runtime boot stderr\n"
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("reinitializes stale artifacts when setup fails before runtime creation starts", async () => {
    const workspace = makeWorkspace("cli-run-pre-runtime-failure");

    try {
      writeDoctorFixtureFiles(workspace);
      const caseDir = join(
        workspace,
        ".test-tmp",
        "e2e-harness",
        "linux",
        "cases",
        "DAR-01"
      );
      mkdirSync(join(caseDir, "logs"), { recursive: true });
      writeFileSync(join(caseDir, "logs", "stale.log"), "stale\n");

      const options = createRunOptions(workspace, {
        buildArtifacts: async () => undefined as unknown as BuildArtifacts,
      });
      const cli = requireRunCli();

      await expect(cli(["run", "DAR-01"], options)).resolves.toBe(1);

      const result = readJson(join(caseDir, "result.json")) as CaseResult;
      expect(result.status).toBe("setup-failure");
      expect(result.message).toContain("Build artifacts were not created");
      expect(existsSync(join(caseDir, "logs", "stale.log"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("aggregates nested platform reports, sorts by platform then DAR id, and exits 1 when any case is blocking", async () => {
    const workspace = makeWorkspace("cli-aggregate");

    try {
      const root = join(workspace, ".test-tmp", "e2e-harness");
      const cli = requireRunCli();
      const definitions = createDefinitions({
        "DAR-01": {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: { expected: "pass" },
        },
        "DAR-02": {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: { expected: "pass" },
        },
      });

      const platformResults: Record<HarnessPlatform, ReportCaseResult[]> = {
        linux: [
          {
            artifactDir: join(root, "linux", "cases", "DAR-01"),
            blocking: false,
            darId: "DAR-01",
            durationMs: 1,
            expectation: expectationFor(definitions, "DAR-01", "linux"),
            failedSubchecks: [],
            platform: "linux",
            status: "passed",
            subchecks: [passedSubcheck("attached-startup")],
            title: definitions[0]!.title,
          },
          {
            artifactDir: join(root, "linux", "cases", "DAR-02"),
            blocking: true,
            darId: "DAR-02",
            durationMs: 1,
            expectation: expectationFor(definitions, "DAR-02", "linux"),
            failedSubchecks: ["replay-visible"],
            message: "Replay broke",
            platform: "linux",
            status: "unexpected-failure",
            subchecks: [failedSubcheck("replay-visible", "Replay broke")],
            title: definitions[1]!.title,
          },
        ],
        macos: [
          {
            artifactDir: join(root, "macos", "cases", "DAR-01"),
            blocking: false,
            darId: "DAR-01",
            durationMs: 1,
            expectation: expectationFor(definitions, "DAR-01", "macos"),
            failedSubchecks: [],
            platform: "macos",
            status: "passed",
            subchecks: [passedSubcheck("attached-startup")],
            title: definitions[0]!.title,
          },
          {
            artifactDir: join(root, "macos", "cases", "DAR-02"),
            blocking: false,
            darId: "DAR-02",
            durationMs: 1,
            expectation: expectationFor(definitions, "DAR-02", "macos"),
            failedSubchecks: [],
            platform: "macos",
            status: "passed",
            subchecks: [passedSubcheck("replay-visible")],
            title: definitions[1]!.title,
          },
        ],
        windows: [
          {
            artifactDir: join(root, "windows", "cases", "DAR-01"),
            blocking: false,
            darId: "DAR-01",
            durationMs: 1,
            expectation: expectationFor(definitions, "DAR-01", "windows"),
            failedSubchecks: [],
            platform: "windows",
            status: "passed",
            subchecks: [passedSubcheck("attached-startup")],
            title: definitions[0]!.title,
          },
          {
            artifactDir: join(root, "windows", "cases", "DAR-02"),
            blocking: false,
            darId: "DAR-02",
            durationMs: 1,
            expectation: expectationFor(definitions, "DAR-02", "windows"),
            failedSubchecks: [],
            platform: "windows",
            status: "passed",
            subchecks: [passedSubcheck("replay-visible")],
            title: definitions[1]!.title,
          },
        ],
      };

      for (const [platform, results] of Object.entries(platformResults) as Array<
        [HarnessPlatform, CaseResult[]]
      >) {
        const platformDir = join(root, platform, "run-1");
        mkdirSync(platformDir, { recursive: true });
        writeFileSync(
          join(platformDir, "results.json"),
          `${JSON.stringify(
            {
              revision: DEFAULT_REVISION,
              generatedAt: FIXED_NOW.toISOString(),
              results,
            },
            null,
            2
          )}\n`
        );
      }

      const options = createRunOptions(workspace, {
        definitions,
      });
      await expect(
        cli(["aggregate", "--results-root", root], options)
      ).resolves.toBe(1);

      const aggregate = readJson(join(root, "results.json")) as {
        revision: string;
        generatedAt: string;
        results: Array<Pick<CaseResult, "platform" | "darId">>;
      };
      expect(aggregate.revision).toBe(DEFAULT_REVISION);
      expect(aggregate.generatedAt).toBe(FIXED_NOW.toISOString());
      expect(aggregate.results.map((result) => `${result.platform}:${result.darId}`)).toEqual([
        "linux:DAR-01",
        "linux:DAR-02",
        "macos:DAR-01",
        "macos:DAR-02",
        "windows:DAR-01",
        "windows:DAR-02",
      ]);
      expect(readFileSync(join(root, "summary.md"), "utf8")).toContain("Replay broke");
      expect(readFileSync(join(root, "junit.xml"), "utf8")).toContain(
        '<failure message="unexpected-failure"'
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("aggregates three platform passing reports and exits 0", async () => {
    const workspace = makeWorkspace("cli-aggregate-success");

    try {
      const root = join(workspace, ".test-tmp", "e2e-harness");
      const cli = requireRunCli();
      const definitions = createDefinitions({
        "DAR-01": {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: { expected: "pass" },
        },
        "DAR-02": {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: { expected: "pass" },
        },
      });

      for (const platform of ["linux", "macos", "windows"] as const) {
        const reportRoot = join(root, platform, "run-1");
        mkdirSync(reportRoot, { recursive: true });
        writeFileSync(
          join(reportRoot, "results.json"),
          `${JSON.stringify(
            {
              revision: DEFAULT_REVISION,
              generatedAt: FIXED_NOW.toISOString(),
              results: [
                {
                  artifactDir: join(root, platform, "cases", "DAR-02"),
                  blocking: false,
                  darId: "DAR-02",
                  durationMs: 1,
                  expectation: expectationFor(definitions, "DAR-02", platform),
                  failedSubchecks: [],
                  platform,
                  status: "passed",
                  subchecks: [passedSubcheck("replay-visible")],
                  title: definitions[1]!.title,
                },
                {
                  artifactDir: join(root, platform, "cases", "DAR-01"),
                  blocking: false,
                  darId: "DAR-01",
                  durationMs: 1,
                  expectation: expectationFor(definitions, "DAR-01", platform),
                  failedSubchecks: [],
                  platform,
                  status: "passed",
                  subchecks: [passedSubcheck("attached-startup")],
                  title: definitions[0]!.title,
                },
              ],
            },
            null,
            2
          )}\n`
        );
      }

      const options = createRunOptions(workspace, { definitions });

      await expect(cli(["aggregate"], options)).resolves.toBe(0);

      expect((options.stdout as CapturedStream).text).toBe(
        [
          "linux DAR-01 passed",
          "linux DAR-02 passed",
          "macos DAR-01 passed",
          "macos DAR-02 passed",
          "windows DAR-01 passed",
          "windows DAR-02 passed",
        ].join("\n") + "\n"
      );
      expect(readFileSync(join(root, "summary.md"), "utf8")).toContain("| windows | DAR-02 |");
      expect(readFileSync(join(root, "junit.xml"), "utf8")).toContain('failures="0" skipped="0"');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects malformed aggregate inputs with exit code 2", async () => {
    const workspace = makeWorkspace("cli-aggregate-invalid");

    try {
      const root = join(workspace, "artifacts");
      const definitions = createDefinitions({
        "DAR-01": {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: { expected: "pass" },
        },
        "DAR-02": {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: { expected: "pass" },
        },
      });
      mkdirSync(join(root, "linux"), { recursive: true });
      mkdirSync(join(root, "linux-duplicate"), { recursive: true });
      writeFileSync(
        join(root, "linux", "results.json"),
        `${JSON.stringify({
          revision: DEFAULT_REVISION,
          generatedAt: FIXED_NOW.toISOString(),
          results: [
            {
              artifactDir: join(root, "linux", "cases", "DAR-01"),
              blocking: false,
              darId: "DAR-01",
              durationMs: 1,
              expectation: { expected: "pass" },
              failedSubchecks: [],
              platform: "linux",
              status: "passed",
              subchecks: [],
              title: "Attached shell input, output, and terminal restoration",
            },
            {
              artifactDir: join(root, "linux", "cases", "DAR-02"),
              blocking: false,
              darId: "DAR-02",
              durationMs: 1,
              expectation: { expected: "pass" },
              failedSubchecks: [],
              platform: "linux",
              status: "passed",
              subchecks: [],
              title: "Headless session dashboard replay and live output",
            },
          ],
        })}\n`
      );
      writeFileSync(
        join(root, "linux-duplicate", "results.json"),
        `${JSON.stringify({
          revision: DEFAULT_REVISION,
          generatedAt: FIXED_NOW.toISOString(),
          results: [
            {
              artifactDir: join(root, "linux-duplicate", "cases", "DAR-01"),
              blocking: false,
              darId: "DAR-01",
              durationMs: 1,
              expectation: { expected: "pass" },
              failedSubchecks: [],
              platform: "linux",
              status: "passed",
              subchecks: [],
              title: "Attached shell input, output, and terminal restoration",
            },
            {
              artifactDir: join(root, "linux-duplicate", "cases", "DAR-02"),
              blocking: false,
              darId: "DAR-02",
              durationMs: 1,
              expectation: { expected: "pass" },
              failedSubchecks: [],
              platform: "linux",
              status: "passed",
              subchecks: [],
              title: "Headless session dashboard replay and live output",
            },
          ],
        })}\n`
      );

      const options = createRunOptions(workspace, { definitions });
      const cli = requireRunCli();

      await expect(cli(["aggregate", "--results-root", root], options)).resolves.toBe(2);
      expect((options.stdout as CapturedStream).text).toContain(
        "Duplicate platform results for linux"
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    {
      darIds: ["DAR-01", "DAR-01", "DAR-02"],
      duplicateDarId: "DAR-01",
    },
    {
      darIds: ["DAR-01", "DAR-02", "DAR-02"],
      duplicateDarId: "DAR-02",
    },
  ] as const)(
    "rejects duplicate aggregate DAR rows for $duplicateDarId with exit code 2 and no combined report output",
    async ({ darIds, duplicateDarId }) => {
      const workspace = makeWorkspace(`cli-aggregate-duplicate-${duplicateDarId.toLowerCase()}`);

      try {
        const root = join(workspace, "artifacts");
        const definitions = createDefinitions({
          "DAR-01": {
            linux: { expected: "pass" },
            macos: { expected: "pass" },
            windows: { expected: "pass" },
          },
          "DAR-02": {
            linux: { expected: "pass" },
            macos: { expected: "pass" },
            windows: { expected: "pass" },
          },
        });

        writeAggregateReport(root, join(root, "linux", "run-1"), "linux", definitions, darIds);
        writeAggregateReport(
          root,
          join(root, "macos", "run-1"),
          "macos",
          definitions,
          ["DAR-01", "DAR-02"]
        );
        writeAggregateReport(
          root,
          join(root, "windows", "run-1"),
          "windows",
          definitions,
          ["DAR-01", "DAR-02"]
        );

        const options = createRunOptions(workspace, { definitions });
        const cli = requireRunCli();

        await expect(cli(["aggregate", "--results-root", root], options)).resolves.toBe(2);
        expect((options.stdout as CapturedStream).text).toContain(
          `duplicate case row for linux ${duplicateDarId}`
        );
        expect(() => readFileSync(join(root, "results.json"), "utf8")).toThrow();
        expect(() => readFileSync(join(root, "summary.md"), "utf8")).toThrow();
        expect(() => readFileSync(join(root, "junit.xml"), "utf8")).toThrow();
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  test("rejects aggregate inputs with a missing platform report", async () => {
    const workspace = makeWorkspace("cli-aggregate-missing-platform");

    try {
      const root = join(workspace, "artifacts");
      const definitions = createDefinitions({
        "DAR-01": {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: { expected: "pass" },
        },
        "DAR-02": {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: { expected: "pass" },
        },
      });

      for (const platform of ["linux", "macos"] as const) {
        const reportRoot = join(root, platform, "run-1");
        mkdirSync(reportRoot, { recursive: true });
        writeFileSync(
          join(reportRoot, "results.json"),
          `${JSON.stringify(
            {
              revision: DEFAULT_REVISION,
              generatedAt: FIXED_NOW.toISOString(),
              results: [
                {
                  artifactDir: join(root, platform, "cases", "DAR-01"),
                  blocking: false,
                  darId: "DAR-01",
                  durationMs: 1,
                  expectation: expectationFor(definitions, "DAR-01", platform),
                  failedSubchecks: [],
                  platform,
                  status: "passed",
                  subchecks: [],
                  title: definitions[0]!.title,
                },
                {
                  artifactDir: join(root, platform, "cases", "DAR-02"),
                  blocking: false,
                  darId: "DAR-02",
                  durationMs: 1,
                  expectation: expectationFor(definitions, "DAR-02", platform),
                  failedSubchecks: [],
                  platform,
                  status: "passed",
                  subchecks: [],
                  title: definitions[1]!.title,
                },
              ],
            },
            null,
            2
          )}\n`
        );
      }

      const options = createRunOptions(workspace, { definitions });
      const cli = requireRunCli();

      await expect(cli(["aggregate", "--results-root", root], options)).resolves.toBe(2);
      expect((options.stdout as CapturedStream).text).toContain("Missing platform results for windows");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects aggregate inputs with inconsistent revisions", async () => {
    const workspace = makeWorkspace("cli-aggregate-revision");

    try {
      const root = join(workspace, "artifacts");
      const definitions = createDefinitions({
        "DAR-01": {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: { expected: "pass" },
        },
        "DAR-02": {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: { expected: "pass" },
        },
      });

      for (const [platform, revision] of [
        ["linux", DEFAULT_REVISION],
        ["macos", `${DEFAULT_REVISION}-other`],
        ["windows", DEFAULT_REVISION],
      ] as const) {
        const reportRoot = join(root, platform, "run-1");
        mkdirSync(reportRoot, { recursive: true });
        writeFileSync(
          join(reportRoot, "results.json"),
          `${JSON.stringify(
            {
              revision,
              generatedAt: FIXED_NOW.toISOString(),
              results: [
                {
                  artifactDir: join(root, platform, "cases", "DAR-01"),
                  blocking: false,
                  darId: "DAR-01",
                  durationMs: 1,
                  expectation: expectationFor(definitions, "DAR-01", platform),
                  failedSubchecks: [],
                  platform,
                  status: "passed",
                  subchecks: [],
                  title: definitions[0]!.title,
                },
                {
                  artifactDir: join(root, platform, "cases", "DAR-02"),
                  blocking: false,
                  darId: "DAR-02",
                  durationMs: 1,
                  expectation: expectationFor(definitions, "DAR-02", platform),
                  failedSubchecks: [],
                  platform,
                  status: "passed",
                  subchecks: [],
                  title: definitions[1]!.title,
                },
              ],
            },
            null,
            2
          )}\n`
        );
      }

      const options = createRunOptions(workspace, { definitions });
      const cli = requireRunCli();

      await expect(cli(["aggregate", "--results-root", root], options)).resolves.toBe(2);
      expect((options.stdout as CapturedStream).text).toContain("Inconsistent revision across reports");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects malformed aggregate inputs with invalid report shapes", async () => {
    const workspace = makeWorkspace("cli-aggregate-malformed");

    try {
      const root = join(workspace, "artifacts");
      for (const platform of ["linux", "macos", "windows"] as const) {
        const reportRoot = join(root, platform, "run-1");
        mkdirSync(reportRoot, { recursive: true });
        writeFileSync(
          join(reportRoot, "results.json"),
          platform === "linux"
            ? '{"revision":"bad","generatedAt":"2026-07-31T21:27:33.660Z","results":[{"darId":"DAR-01"}]}\n'
            : `${JSON.stringify(
                {
                  revision: DEFAULT_REVISION,
                  generatedAt: FIXED_NOW.toISOString(),
                  results: [
                    {
                      artifactDir: join(root, platform, "cases", "DAR-01"),
                      blocking: false,
                      darId: "DAR-01",
                      durationMs: 1,
                      expectation: { expected: "pass" },
                      failedSubchecks: [],
                      platform,
                      status: "passed",
                      subchecks: [],
                      title: "Attached shell input, output, and terminal restoration",
                    },
                    {
                      artifactDir: join(root, platform, "cases", "DAR-02"),
                      blocking: false,
                      darId: "DAR-02",
                      durationMs: 1,
                      expectation: { expected: "pass" },
                      failedSubchecks: [],
                      platform,
                      status: "passed",
                      subchecks: [],
                      title: "Headless session dashboard replay and live output",
                    },
                  ],
                },
                null,
                2
              )}\n`
        );
      }

      const options = createRunOptions(workspace);
      const cli = requireRunCli();

      await expect(cli(["aggregate", "--results-root", root], options)).resolves.toBe(2);
      expect((options.stdout as CapturedStream).text).toContain("invalid report shape");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
