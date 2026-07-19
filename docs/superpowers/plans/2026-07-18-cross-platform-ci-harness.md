# Cross-platform Client/Server CI Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic Node.js/Playwright end-to-end harness that validates the source-built climon Rust client and Bun server together on GitHub-hosted macOS, Linux, and Windows runners.

**Architecture:** A Playwright Test worker builds host artifacts once, creates an isolated `CLIMON_HOME`, starts the compiled server, and dispatches reviewed scenario implementations selected by structured metadata in `docs/manual-tests/`. Shared drivers own process, PTY, dashboard, metadata, and artifact behavior; a narrow platform adapter contains OS differences.

**Tech Stack:** TypeScript, Node.js, Playwright Test, `node-pty`, YAML, Bun build tooling, Rust/Cargo, GitHub Actions.

---

## File structure

Create these focused harness files:

- `harness/playwright.config.ts` — Playwright timeouts, one-worker execution, traces, screenshots, and output paths.
- `harness/tsconfig.json` — Node-only strict TypeScript configuration for harness code.
- `harness/README.md` — local prerequisites, commands, suites, and artifact locations.
- `harness/fixtures/echo-session.mjs` — deterministic line-oriented command run inside climon sessions.
- `harness/src/types.ts` — shared plan, result, environment, and scenario types.
- `harness/src/catalog.ts` — parse and validate `yaml harness` blocks from manual-test Markdown.
- `harness/src/platform.ts` — platform name, executable suffix, environment, and process-tree behavior.
- `harness/src/command.ts` — typed child-process execution with captured logs and deadlines.
- `harness/src/build.ts` — build the Rust client and compiled Bun server for the host.
- `harness/src/environment.ts` — isolated home, server lifecycle, session tracking, metadata reads, and cleanup.
- `harness/src/pty.ts` — `node-pty` wrapper for attached-client interaction.
- `harness/src/dashboard.ts` — Playwright session-list and terminal operations.
- `harness/src/artifacts.ts` — structured results, redaction, logs, and serializable state snapshots.
- `harness/src/scenarios.ts` — registry for the two initial smoke scenarios.
- `harness/src/aggregate.ts` — merge per-OS results and fail the aggregate gate.
- `harness/tests/catalog.spec.ts` — catalogue validation tests.
- `harness/tests/fixture.spec.ts` — deterministic fixture protocol tests.
- `harness/tests/platform.spec.ts` — platform and process command tests.
- `harness/tests/artifacts.spec.ts` — result and state-snapshot tests.
- `harness/tests/build.spec.ts` — build-plan tests with an injected command runner.
- `harness/tests/environment.spec.ts` — server-state and cleanup tests with fakes.
- `harness/tests/aggregate.spec.ts` — cross-platform aggregation tests.
- `harness/tests/smoke.spec.ts` — dynamic CIH-01/CIH-02 Playwright tests.

Modify these existing files:

- `package.json` and `bun.lock` — harness dependencies and scripts.
- `scripts/server-build.ts` — new shared compiled-server argument helper.
- `scripts/compile.ts` — consume the shared server-build helper.
- `tests/server-build.test.ts` — guard embedded-server compile flags.
- `tests/server-binary-smoke.test.ts` — consume the shared helper.
- `src/web/components/SessionItem.tsx` — stable semantic session attributes.
- `src/web/components/TerminalView.tsx` — stable terminal automation hook.
- `tests/session-item.test.ts` — test session automation attributes.
- `docs/manual-tests/cross-platform-ci-harness.md` — CIH-01 and CIH-02 plans plus harness metadata.
- `docs/manual-tests/README.md` — index the harness cases and document metadata.
- `docs/features.md` — add the in-development dashboard harness entry.
- `.github/workflows/client-server-harness.yml` — three-OS matrix and aggregate job.

## Task 1: Add the harness toolchain and share compiled-server flags

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `harness/playwright.config.ts`
- Create: `harness/tsconfig.json`
- Create: `scripts/server-build.ts`
- Create: `tests/server-build.test.ts`
- Modify: `scripts/compile.ts:52-61`
- Modify: `tests/server-binary-smoke.test.ts:7,38-49`

- [ ] **Step 1: Write the failing shared-build-flags test**

Create `tests/server-build.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  EMBEDDED_DEFINE_ARGS,
  compiledServerBuildArgs,
} from "../scripts/server-build.js";

describe("compiledServerBuildArgs", () => {
  test("always enables embedded assets and writes the requested executable", () => {
    expect(compiledServerBuildArgs("/tmp/climon-server")).toEqual([
      "build",
      "src/server.ts",
      "--compile",
      ...EMBEDDED_DEFINE_ARGS,
      "--outfile",
      "/tmp/climon-server",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test tests/server-build.test.ts
```

Expected: FAIL because `scripts/server-build.ts` does not exist.

- [ ] **Step 3: Add dependencies and scripts using Bun**

Run:

```bash
bun add --dev @playwright/test node-pty tsx yaml
```

Add these scripts to `package.json`:

```json
{
  "scripts": {
    "test:harness:unit": "playwright test --config harness/playwright.config.ts --grep-invert @smoke",
    "test:harness": "playwright test --config harness/playwright.config.ts",
    "test:harness:smoke": "playwright test --config harness/playwright.config.ts --grep @smoke",
    "harness:install-browser": "playwright install chromium"
  },
  "trustedDependencies": [
    "node-pty"
  ]
}
```

Preserve every existing script and package field. Let `bun add` regenerate
`bun.lock`; do not create `package-lock.json`.

- [ ] **Step 4: Create the Node-only TypeScript and Playwright configuration**

Create `harness/tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "types": ["node", "@playwright/test"],
    "noEmit": true
  },
  "include": ["./**/*.ts"]
}
```

Create `harness/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const platform =
  process.platform === "darwin"
    ? "macos"
    : process.platform === "win32"
      ? "windows"
      : "linux";
const artifactRoot =
  process.env.CLIMON_HARNESS_ARTIFACT_DIR ??
  resolve(root, `.test-tmp/harness/${platform}`);

export default defineConfig({
  testDir: resolve(import.meta.dirname, "tests"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: resolve(artifactRoot, "playwright"),
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(artifactRoot, "playwright-results.json") }],
  ],
  use: {
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
});
```

- [ ] **Step 5: Implement and reuse the shared server build arguments**

Create `scripts/server-build.ts`:

```ts
export const EMBEDDED_DEFINE_ARGS = [
  "--define",
  "__CLIMON_EMBEDDED__=true",
] as const;

export function compiledServerBuildArgs(outfile: string): string[] {
  return [
    "build",
    "src/server.ts",
    "--compile",
    ...EMBEDDED_DEFINE_ARGS,
    "--outfile",
    outfile,
  ];
}
```

In `scripts/compile.ts`, replace the local `EMBEDDED_DEFINE_ARGS` declaration
with:

```ts
import {
  EMBEDDED_DEFINE_ARGS,
} from "./server-build.js";

export { EMBEDDED_DEFINE_ARGS } from "./server-build.js";
```

Keep the release compiler's existing cross-target command unchanged apart from
using the imported `EMBEDDED_DEFINE_ARGS`; it must continue to include
`--target`, telemetry defines, and `--compile-executable-path`.

In `tests/server-binary-smoke.test.ts`, replace the import from
`scripts/compile.js` with:

```ts
import { compiledServerBuildArgs } from "../scripts/server-build.js";
```

Replace the manual server argument array with:

```ts
spawnSync("bun", compiledServerBuildArgs(out), {
  stdio: "inherit",
}).status
```

- [ ] **Step 6: Run focused checks**

Run:

```bash
bun test tests/server-build.test.ts tests/server-binary-smoke.test.ts
bun run typecheck
npx playwright --version
```

Expected: tests PASS, typecheck PASS, and Playwright prints a version.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock harness/playwright.config.ts harness/tsconfig.json \
  scripts/server-build.ts scripts/compile.ts tests/server-build.test.ts \
  tests/server-binary-smoke.test.ts
git commit -m "build: add client server harness toolchain"
```

## Task 2: Parse explicit harness metadata from manual-test Markdown

**Files:**
- Create: `harness/src/types.ts`
- Create: `harness/src/catalog.ts`
- Create: `harness/tests/catalog.spec.ts`
- Create: `docs/manual-tests/cross-platform-ci-harness.md`
- Modify: `docs/manual-tests/README.md:26-31,92-98`

- [ ] **Step 1: Write failing catalogue tests**

Create `harness/tests/catalog.spec.ts` with temporary Markdown fixtures covering
one valid case and the required validation failures:

```ts
import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHarnessCases } from "../src/catalog.js";

async function catalogue(markdown: string) {
  const dir = await mkdtemp(join(tmpdir(), "climon-catalog-"));
  await writeFile(join(dir, "cases.md"), markdown);
  return loadHarnessCases(dir);
}

test("loads an automated case from a yaml harness block", async () => {
  const cases = await catalogue(`
## CIH-01 — Headless lifecycle

- **ID:** CIH-01

\`\`\`yaml harness
status: automated
suite: smoke
scenario: client-server.headless-dashboard
platforms: [macos, linux, windows]
timeoutSeconds: 90
\`\`\`
`);

  expect(cases).toEqual([
    {
      id: "CIH-01",
      title: "Headless lifecycle",
      sourceFile: "cases.md",
      status: "automated",
      suite: "smoke",
      scenario: "client-server.headless-dashboard",
      platforms: ["macos", "linux", "windows"],
      timeoutSeconds: 90,
    },
  ]);
});

test("rejects an automated case with an unknown field", async () => {
  await expect(
    catalogue(`
## CIH-01 — Invalid
- **ID:** CIH-01
\`\`\`yaml harness
status: automated
suite: smoke
scenario: client-server.headless-dashboard
platforms: [linux]
timeoutSeconds: 90
command: rm -rf /
\`\`\`
`)
  ).rejects.toThrow("unsupported harness field: command");
});

test("rejects duplicate ids and timeout values outside 1 through 600", async () => {
  await expect(
    catalogue(`
## CIH-01 — First
- **ID:** CIH-01
\`\`\`yaml harness
status: automated
suite: smoke
scenario: client-server.headless-dashboard
platforms: [linux]
timeoutSeconds: 0
\`\`\`
## CIH-01 — Second
- **ID:** CIH-01
\`\`\`yaml harness
status: manual
suite: smoke
scenario: client-server.attached-pty
platforms: [linux]
timeoutSeconds: 90
\`\`\`
`)
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npx playwright test --config harness/playwright.config.ts harness/tests/catalog.spec.ts
```

Expected: FAIL because the catalogue modules do not exist.

- [ ] **Step 3: Define the shared plan and result types**

Create `harness/src/types.ts`:

```ts
export type HarnessPlatform = "macos" | "linux" | "windows";
export type HarnessStatus = "automated" | "manual";
export type ScenarioKey =
  | "client-server.headless-dashboard"
  | "client-server.attached-pty";

export interface HarnessCase {
  id: string;
  title: string;
  sourceFile: string;
  status: HarnessStatus;
  suite: string;
  scenario: ScenarioKey;
  platforms: HarnessPlatform[];
  timeoutSeconds: number;
}

export type FailureKind =
  | "catalogue"
  | "build"
  | "server-startup"
  | "client-startup"
  | "pty"
  | "browser"
  | "assertion"
  | "timeout"
  | "cleanup";

export interface CaseResult {
  id: string;
  platform: HarnessPlatform;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  failureKind?: FailureKind;
  message?: string;
  artifactDir: string;
}

export class HarnessError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "HarnessError";
  }
}
```

- [ ] **Step 4: Implement strict Markdown/YAML parsing**

Create `harness/src/catalog.ts`. Implement `loadHarnessCases(manualTestsDir)` by:

1. reading only top-level `*.md` files;
2. tracking headings matching `^## ([A-Z0-9-]+) [—-] (.+)$`;
3. requiring the standard `- **ID:** <id>` before a harness block;
4. parsing only fenced blocks opened by ```` ```yaml harness ````;
5. validating the exact field set with `yaml.parse`;
6. validating status, known scenario keys, unique platforms, timeout 1–600, one
   block per case, and globally unique IDs;
7. returning cases sorted by ID.

Use these exact allowed-field and scenario sets:

```ts
const ALLOWED_FIELDS = new Set([
  "status",
  "suite",
  "scenario",
  "platforms",
  "timeoutSeconds",
]);

const SCENARIOS = new Set<ScenarioKey>([
  "client-server.headless-dashboard",
  "client-server.attached-pty",
]);
```

Error messages must include the source filename and case ID where known.

- [ ] **Step 5: Add the two source-of-truth manual cases**

Create `docs/manual-tests/cross-platform-ci-harness.md` using the repository
manual-test shape. Include common preconditions and these blocks:

```yaml harness
status: automated
suite: smoke
scenario: client-server.headless-dashboard
platforms: [macos, linux, windows]
timeoutSeconds: 120
```

for CIH-01, and:

```yaml harness
status: automated
suite: smoke
scenario: client-server.attached-pty
platforms: [macos, linux, windows]
timeoutSeconds: 120
```

for CIH-02. Use the approved design’s exact steps and expected results. Add an
empty result-tracking table to each case.

Update `docs/manual-tests/README.md`:

- document the optional `yaml harness` block after the standard case shape;
- state that metadata selects reviewed scenarios and cannot contain commands;
- add the new file to the cases index.

- [ ] **Step 6: Run catalogue tests and validate the real docs**

Add a test that loads `docs/manual-tests/` and expects CIH-01 and CIH-02. Then
run:

```bash
npx playwright test --config harness/playwright.config.ts harness/tests/catalog.spec.ts
```

Expected: all catalogue tests PASS.

- [ ] **Step 7: Commit**

```bash
git add harness/src/types.ts harness/src/catalog.ts harness/tests/catalog.spec.ts \
  docs/manual-tests/cross-platform-ci-harness.md docs/manual-tests/README.md
git commit -m "test: define harness manual test catalogue"
```

## Task 3: Add the deterministic cross-platform session fixture

**Files:**
- Create: `harness/fixtures/echo-session.mjs`
- Create: `harness/tests/fixture.spec.ts`

- [ ] **Step 1: Write the failing fixture protocol test**

Create `harness/tests/fixture.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

test("fixture announces readiness, echoes tokens, and exits on request", async () => {
  const child = spawn(process.execPath, [
    resolve(import.meta.dirname, "../fixtures/echo-session.mjs"),
  ], { stdio: ["pipe", "pipe", "pipe"] });

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });

  await expect.poll(() => output).toContain("CIH_READY");
  child.stdin.write("PING token-123\n");
  await expect.poll(() => output).toContain("CIH_ECHO token-123");
  child.stdin.write("EXIT 0\n");

  const [code] = await once(child, "exit");
  expect(code).toBe(0);
  expect(output).toContain("CIH_EXIT 0");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx playwright test --config harness/playwright.config.ts harness/tests/fixture.spec.ts
```

Expected: FAIL because the fixture file does not exist.

- [ ] **Step 3: Implement the fixture**

Create `harness/fixtures/echo-session.mjs`:

```js
import { createInterface } from "node:readline";

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

process.stdout.write("CIH_READY\n");

lines.on("line", (line) => {
  const ping = /^PING (.+)$/.exec(line);
  if (ping) {
    process.stdout.write(`CIH_ECHO ${ping[1]}\n`);
    return;
  }

  const exit = /^EXIT (-?\d+)$/.exec(line);
  if (exit) {
    const code = Number(exit[1]);
    process.stdout.write(`CIH_EXIT ${code}\n`, () => {
      lines.close();
      process.exit(code);
    });
    return;
  }

  process.stdout.write(`CIH_UNKNOWN ${line}\n`);
});
```

- [ ] **Step 4: Run the fixture test**

Run:

```bash
npx playwright test --config harness/playwright.config.ts harness/tests/fixture.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add harness/fixtures/echo-session.mjs harness/tests/fixture.spec.ts
git commit -m "test: add deterministic session fixture"
```

## Task 4: Add platform, command, artifact, and aggregation primitives

**Files:**
- Create: `harness/src/platform.ts`
- Create: `harness/src/command.ts`
- Create: `harness/src/artifacts.ts`
- Create: `harness/src/aggregate.ts`
- Create: `harness/tests/platform.spec.ts`
- Create: `harness/tests/artifacts.spec.ts`
- Create: `harness/tests/aggregate.spec.ts`

- [ ] **Step 1: Write failing platform and process-tree tests**

Create `harness/tests/platform.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import {
  platformFromNode,
  processTreeTermination,
} from "../src/platform.js";

test("maps Node platforms to harness platforms", () => {
  expect(platformFromNode("darwin")).toBe("macos");
  expect(platformFromNode("linux")).toBe("linux");
  expect(platformFromNode("win32")).toBe("windows");
  expect(() => platformFromNode("aix")).toThrow("unsupported platform");
});

test("uses pid-scoped process-tree termination", () => {
  expect(processTreeTermination("windows", 1234, true)).toEqual({
    file: "taskkill",
    args: ["/PID", "1234", "/T", "/F"],
  });
  expect(processTreeTermination("linux", 1234, false)).toEqual({
    signal: "SIGTERM",
    pid: -1234,
  });
});
```

- [ ] **Step 2: Write failing artifact and aggregation tests**

Create `harness/tests/artifacts.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  redactEnvironment,
  shouldSnapshotFileType,
  snapshotHome,
  writeCaseResult,
} from "../src/artifacts.js";

test("redacts secret-shaped environment values", () => {
  expect(
    redactEnvironment({
      PATH: "/bin",
      API_TOKEN: "secret",
      APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=value",
    })
  ).toEqual({
    PATH: "/bin",
    API_TOKEN: "[REDACTED]",
    APPLICATIONINSIGHTS_CONNECTION_STRING: "[REDACTED]",
  });
});

test("copies regular state and excludes non-serializable file types", async () => {
  const root = await mkdtemp(join(tmpdir(), "climon-artifacts-"));
  const home = join(root, "home");
  const snapshot = join(root, "snapshot");
  await mkdir(join(home, "sessions"), { recursive: true });
  await writeFile(join(home, "sessions", "case.json"), "{}\n");

  expect(shouldSnapshotFileType("file")).toBe(true);
  expect(shouldSnapshotFileType("directory")).toBe(true);
  expect(shouldSnapshotFileType("socket")).toBe(false);
  expect(shouldSnapshotFileType("fifo")).toBe(false);

  await snapshotHome(home, snapshot);
  expect(
    await readFile(join(snapshot, "sessions", "case.json"), "utf8")
  ).toBe("{}\n");
});

test("writes a valid case result", async () => {
  const root = await mkdtemp(join(tmpdir(), "climon-result-"));
  await writeCaseResult(root, {
    id: "CIH-01",
    platform: "linux",
    status: "passed",
    durationMs: 25,
    artifactDir: root,
  });
  expect(JSON.parse(await readFile(join(root, "result.json"), "utf8"))).toMatchObject({
    id: "CIH-01",
    status: "passed",
  });
});
```

Create `harness/tests/aggregate.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { aggregateResults } from "../src/aggregate.js";

test("passes only when all three platforms ran every automated case", () => {
  const summary = aggregateResults([
    { id: "CIH-01", platform: "macos", status: "passed", durationMs: 1, artifactDir: "a" },
    { id: "CIH-01", platform: "linux", status: "passed", durationMs: 1, artifactDir: "b" },
    { id: "CIH-01", platform: "windows", status: "passed", durationMs: 1, artifactDir: "c" },
  ], [{
    id: "CIH-01",
    title: "Headless",
    sourceFile: "cases.md",
    status: "automated",
    suite: "smoke",
    scenario: "client-server.headless-dashboard",
    platforms: ["macos", "linux", "windows"],
    timeoutSeconds: 90,
  }]);
  expect(summary.ok).toBe(true);
});

test("fails when a required platform result is absent", () => {
  const summary = aggregateResults([
    { id: "CIH-01", platform: "linux", status: "passed", durationMs: 1, artifactDir: "b" },
  ], [{
    id: "CIH-01",
    title: "Headless",
    sourceFile: "cases.md",
    status: "automated",
    suite: "smoke",
    scenario: "client-server.headless-dashboard",
    platforms: ["macos", "linux", "windows"],
    timeoutSeconds: 90,
  }]);
  expect(summary.ok).toBe(false);
  expect(summary.errors).toContain("CIH-01 did not run on macos");
  expect(summary.errors).toContain("CIH-01 did not run on windows");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:

```bash
npx playwright test --config harness/playwright.config.ts \
  harness/tests/platform.spec.ts harness/tests/artifacts.spec.ts \
  harness/tests/aggregate.spec.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement platform and command primitives**

In `harness/src/platform.ts`, export:

```ts
export function platformFromNode(
  platform: NodeJS.Platform
): HarnessPlatform;

export function executableName(
  base: string,
  platform: HarnessPlatform
): string;

export function processTreeTermination(
  platform: HarnessPlatform,
  pid: number,
  force: boolean
):
  | { file: "taskkill"; args: string[] }
  | { signal: NodeJS.Signals; pid: number };
```

Unix children that the harness owns must be spawned with `detached: true`, so a
negative PID targets only that child’s process group. Windows termination must
use `taskkill /PID <pid> /T` and append `/F` only for forced cleanup.

In `harness/src/command.ts`, define a `CommandRunner` interface and a real
implementation:

```ts
export interface CommandSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
  detached?: boolean;
}

export interface CommandResult {
  code: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}
```

Reject non-zero exits with the executable, arguments, exit code, and log paths.
On timeout, terminate the owned tree, wait two seconds, force it, then reject
with failure kind `timeout`. Write complete output to the requested log files
while retaining at most the latest 1 MiB per stream in `CommandResult`.

- [ ] **Step 5: Implement artifacts and aggregation**

In `harness/src/artifacts.ts`:

- create `cases/<case-id>/` beneath the current run's OS-specific artifact root;
- write `result.json`;
- copy only regular files and directories from `CLIMON_HOME`;
- skip sockets, FIFOs, and device entries using `lstat`;
- redact keys matching `/token|secret|password|connection|string|key/i`;
- write a Markdown case summary.

Also export:

```ts
export function redactEnvironment(
  env: NodeJS.ProcessEnv
): Record<string, string>;

export function shouldSnapshotFileType(
  type: "file" | "directory" | "socket" | "fifo" | "other"
): boolean;

export function snapshotHome(home: string, destination: string): Promise<void>;

export function writeCaseResult(
  artifactDir: string,
  result: CaseResult
): Promise<void>;

export function caseArtifactDir(
  artifactRoot: string,
  caseId: string
): string;

export function failureResult(
  definition: HarnessCase,
  platform: HarnessPlatform,
  error: unknown,
  startedAt: number,
  artifactDir: string
): CaseResult;
```

`failureResult` preserves a `HarnessError.kind`; unknown assertion errors use
`assertion`.

In `harness/src/aggregate.ts`, export
`aggregateResults(results, caseDefinitions)`. Require each automated case only
on the platforms listed in its metadata; manual cases and unlisted platforms
are not required. Any failed or skipped result for a required case/platform
makes `ok` false. Add a CLI entrypoint guarded by:

```ts
if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await runAggregateCli(process.argv.slice(2));
  process.exitCode = code;
}
```

Use `pathToFileURL(process.argv[1]).href` rather than string interpolation in
the real guard so Windows paths are converted to valid file URLs.

The CLI accepts `<results-dir> <manual-tests-dir> <suite>`, loads the catalogue,
reads `result.json` files recursively, writes `summary.json` and `summary.md`,
prints the Markdown summary, and exits 1 when `ok` is false.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npx playwright test --config harness/playwright.config.ts \
  harness/tests/platform.spec.ts harness/tests/artifacts.spec.ts \
  harness/tests/aggregate.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add harness/src/platform.ts harness/src/command.ts harness/src/artifacts.ts \
  harness/src/aggregate.ts harness/tests/platform.spec.ts \
  harness/tests/artifacts.spec.ts harness/tests/aggregate.spec.ts
git commit -m "test: add harness runtime primitives"
```

## Task 5: Build host artifacts and supervise the isolated climon environment

**Files:**
- Create: `harness/src/build.ts`
- Create: `harness/src/environment.ts`
- Create: `harness/tests/build.spec.ts`
- Create: `harness/tests/environment.spec.ts`

- [ ] **Step 1: Write the failing build-plan test**

Create `harness/tests/build.spec.ts` with a recording `CommandRunner` and assert
the exact build sequence:

```ts
import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { planHostBuild } from "../src/build.js";
import {
  executableName,
  platformFromNode,
} from "../src/platform.js";

test("builds the Rust client and embedded Bun server for the host", () => {
  const platform = platformFromNode(process.platform);
  const plan = planHostBuild({
    root: "/repo",
    platform,
    buildDir: "/artifacts",
    env: { PATH: "test" },
  });

  expect(plan.clientPath).toBe(
    resolve("/repo/rust/target/debug", executableName("climon", platform))
  );
  expect(plan.serverPath).toBe(
    resolve("/artifacts", executableName("climon-server", platform))
  );
  expect(plan.commands.map(({ file, args }) => ({ file, args }))).toEqual([
    {
      file: "cargo",
      args: ["build", "-p", "climon-cli"],
    },
    {
      file: "bun",
      args: ["scripts/embed-assets.ts"],
    },
    {
      file: "bun",
      args: [
        "build",
        "src/server.ts",
        "--compile",
        "--define",
        "__CLIMON_EMBEDDED__=true",
        "--outfile",
        resolve("/artifacts", executableName("climon-server", platform)),
      ],
    },
  ]);
});
```

- [ ] **Step 2: Write failing environment tests**

Create `harness/tests/environment.spec.ts` with fakes that prove:

- `server.json` must contain positive integer `pid` and `port`;
- readiness requires both valid state and `{ ok: true }` from `/health`;
- tracked session cleanup calls the built client as
  `climon kill <session-id>`;
- server cleanup targets the recorded server PID only;
- metadata reads `CLIMON_HOME/sessions/<id>.json` and validates
  `status`/`exitCode`.

- [ ] **Step 3: Run the tests to verify they fail**

Run:

```bash
npx playwright test --config harness/playwright.config.ts \
  harness/tests/build.spec.ts harness/tests/environment.spec.ts
```

Expected: FAIL because build and environment modules do not exist.

- [ ] **Step 4: Implement host build planning and execution**

In `harness/src/build.ts`, define:

```ts
export interface BuildArtifacts {
  clientPath: string;
  serverPath: string;
  fixturePath: string;
}

export interface BuildPlan {
  clientPath: string;
  serverPath: string;
  commands: CommandSpec[];
}

export function planHostBuild(input: {
  root: string;
  platform: HarnessPlatform;
  buildDir: string;
  env: NodeJS.ProcessEnv;
}): BuildPlan;

export async function buildHostArtifacts(
  input: Parameters<typeof planHostBuild>[0],
  runner: CommandRunner
): Promise<BuildArtifacts>;
```

Use:

- Cargo cwd: `<root>/rust`;
- client output: `<root>/rust/target/debug/climon[.exe]`;
- server output: `<buildDir>/climon-server[.exe]`;
- fixture path: `<root>/harness/fixtures/echo-session.mjs`;
- server arguments from `compiledServerBuildArgs(serverPath)`.

The Node harness cannot import Bun-only `scripts/compile.ts`; it may import the
runtime-neutral `scripts/server-build.ts`.

- [ ] **Step 5: Implement the environment supervisor**

In `harness/src/environment.ts`, define `HarnessEnvironment` with:

```ts
export class HarnessEnvironment {
  readonly root: string;
  readonly platform: HarnessPlatform;
  readonly home: string;
  readonly artifactRoot: string;
  readonly artifacts: BuildArtifacts;
  readonly baseUrl: string;

  static async create(options: {
    root: string;
    platform: HarnessPlatform;
    artifactRoot: string;
    runner: CommandRunner;
  }): Promise<HarnessEnvironment>;

  trackSession(id: string): void;
  sessionMetaPath(id: string): string;
  readSessionMeta(id: string): Promise<{
    id: string;
    status: string;
    exitCode?: number;
    name?: string;
  }>;
  waitForSessionStatus(
    id: string,
    status: string,
    timeoutMs: number
  ): Promise<void>;
  findSessionIdByName(name: string, timeoutMs: number): Promise<string>;
  snapshotState(destination: string): Promise<void>;
  dispose(): Promise<void>;
}
```

`create` must:

1. make `<artifactRoot>/runtime/home`, `<artifactRoot>/runtime/logs`, and
   `<artifactRoot>/runtime/build`;
2. write `<home>/config.jsonc` with telemetry, automatic updates, remotes, and
   WSL auto-link disabled:

   ```json
   {
     "telemetry": { "enabled": false },
     "update": { "auto": false },
     "remote": { "enabled": false, "autoLink": false }
   }
   ```

3. set `CLIMON_HOME`, `CLIMON_CLIENT_BIN`, `CLIMON_COLS=100`,
   `CLIMON_ROWS=30`, `CI=true`, and `NO_COLOR=1` for every runtime child;
4. remove `APPLICATIONINSIGHTS_CONNECTION_STRING` from the server build
   environment so a developer or CI secret is never embedded in a test binary;
5. build artifacts;
6. start `climon-server[.exe] server --no-takeover --port 0` with
   `CLIMON_HOME` and `CLIMON_CLIENT_BIN` set;
7. poll `<home>/server.json`;
8. poll `http://127.0.0.1:<port>/health` until it returns JSON with `ok: true`;
9. expose that URL as `baseUrl`.

`dispose` must:

1. call `<client> kill <id>` for every tracked live session;
2. wait for session metadata to become terminal;
3. terminate only the recorded server process tree;
4. snapshot regular files from the isolated home;
5. report cleanup failures instead of swallowing them.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npx playwright test --config harness/playwright.config.ts \
  harness/tests/build.spec.ts harness/tests/environment.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add harness/src/build.ts harness/src/environment.ts \
  harness/tests/build.spec.ts harness/tests/environment.spec.ts
git commit -m "test: build and supervise climon harness environment"
```

## Task 6: Add stable dashboard automation hooks

**Files:**
- Modify: `src/web/components/SessionItem.tsx:272-284,305-330`
- Modify: `src/web/components/TerminalView.tsx:1247-1261`
- Create: `tests/session-item.test.ts`

- [ ] **Step 1: Write the failing helper test**

Create `tests/session-item.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  sessionAutomationAttributes,
} from "../src/web/components/SessionItem.js";

describe("sessionAutomationAttributes", () => {
  test("exposes stable semantic id and status values", () => {
    expect(
      sessionAutomationAttributes({
        id: "quiet-otters-run",
        status: "running",
      })
    ).toEqual({
      "data-testid": "session-item",
      "data-session-id": "quiet-otters-run",
      "data-session-status": "running",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test tests/session-item.test.ts
```

Expected: FAIL because `sessionAutomationAttributes` does not exist.

- [ ] **Step 3: Add semantic session attributes**

In `src/web/components/SessionItem.tsx`, add:

```ts
export function sessionAutomationAttributes(
  session: Pick<SessionMeta, "id" | "status">
) {
  return {
    "data-testid": "session-item",
    "data-session-id": session.id,
    "data-session-status": session.status,
  } as const;
}
```

Spread `...sessionAutomationAttributes(session)` onto the root session `<div>`.
Do not alter click, keyboard, compact, or styling behavior.

- [ ] **Step 4: Add a semantic terminal hook**

On the terminal container `<div ref={containerRef}>` in
`TerminalView.tsx`, add:

```tsx
data-testid="session-terminal"
aria-label="Session terminal"
```

This identifies the semantic terminal surface while keeping xterm’s helper
textarea and rendered rows internal to that surface.

- [ ] **Step 5: Run focused UI checks**

Run:

```bash
bun test tests/session-item.test.ts tests/web-api.test.ts
bun run typecheck
```

Expected: tests PASS and typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/SessionItem.tsx \
  src/web/components/TerminalView.tsx tests/session-item.test.ts
git commit -m "test(web): add stable harness selectors"
```

## Task 7: Implement PTY and dashboard drivers

**Files:**
- Create: `harness/src/pty.ts`
- Create: `harness/src/dashboard.ts`
- Create: `harness/tests/pty.spec.ts`

- [ ] **Step 1: Write a failing PTY wrapper test**

Create `harness/tests/pty.spec.ts` using `process.execPath` and the deterministic
fixture. Assert that the wrapper:

- waits for `CIH_READY`;
- writes `PING token`;
- waits for `CIH_ECHO token`;
- writes `EXIT 0`;
- resolves with exit code zero;
- includes recent output in a timeout error.

Use a 5-second test timeout and normalize `\r\n` to `\n` only for marker
matching.

- [ ] **Step 2: Run the PTY test to verify it fails**

Run:

```bash
npx playwright test --config harness/playwright.config.ts harness/tests/pty.spec.ts
```

Expected: FAIL because the PTY driver does not exist.

- [ ] **Step 3: Implement the PTY driver**

Create `harness/src/pty.ts`:

```ts
export interface PtySession {
  readonly output: string;
  writeLine(line: string): void;
  waitFor(marker: string, timeoutMs: number): Promise<void>;
  waitForExit(timeoutMs: number): Promise<number>;
  kill(): void;
}

export function spawnPtySession(options: {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  logPath: string;
}): PtySession;
```

Use `node-pty` with `name` set to `xterm-256color`, default 100×30, and the
provided argument array. Append every data chunk to the log before resolving
waiters. `writeLine` writes `${line}\r`; `waitFor` checks accumulated output
before registering a waiter.

- [ ] **Step 4: Implement the dashboard driver**

Create `harness/src/dashboard.ts` with:

```ts
export class DashboardDriver {
  constructor(private readonly page: Page) {}

  async open(baseUrl: string): Promise<void>;
  session(id: string): Locator;
  async waitForSessionStatus(
    id: string,
    status: string,
    timeoutMs: number
  ): Promise<void>;
  async openTerminal(id: string): Promise<void>;
  async waitForTerminalText(
    text: string,
    timeoutMs: number
  ): Promise<void>;
  async sendTerminalLine(line: string): Promise<void>;
}
```

Use these selectors:

```ts
const quotedId = JSON.stringify(id);
this.page.locator(
  `[data-testid="session-item"][data-session-id=${quotedId}]`
);
```

for sessions, `[data-testid="session-terminal"]` for the terminal surface, and
`.xterm-rows` scoped beneath that surface for rendered terminal text.

`openTerminal` clicks the session item, then clicks the `Open terminal` button
when present, and waits for the terminal surface. `sendTerminalLine` clicks the
surface and uses `page.keyboard.type(line)` followed by `Enter`; it must not
reach into React component internals.

- [ ] **Step 5: Run the PTY test and typecheck**

Run:

```bash
npx playwright test --config harness/playwright.config.ts harness/tests/pty.spec.ts
npx tsc -p harness/tsconfig.json
```

Expected: PTY test PASS and harness typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add harness/src/pty.ts harness/src/dashboard.ts harness/tests/pty.spec.ts
git commit -m "test: add terminal and dashboard harness drivers"
```

## Task 8: Implement CIH-01 and CIH-02 as catalogue-driven Playwright tests

**Files:**
- Create: `harness/src/scenarios.ts`
- Create: `harness/tests/smoke.spec.ts`

- [ ] **Step 1: Write the failing scenario-registry test**

At the top of `harness/tests/smoke.spec.ts`, load the real catalogue and assert
that every automated smoke case for the current platform has a registry entry:

```ts
const cases = await loadHarnessCases(
  resolve(import.meta.dirname, "../../docs/manual-tests")
);
const platform = platformFromNode(process.platform);
const selected = cases.filter(
  (entry) =>
    entry.status === "automated" &&
    entry.suite === "smoke" &&
    entry.platforms.includes(platform)
);
const skipped = cases.filter(
  (entry) =>
    entry.suite === "smoke" &&
    (entry.status === "manual" || !entry.platforms.includes(platform))
);

test("every selected case has a scenario implementation", () => {
  for (const entry of selected) {
    expect(SCENARIOS[entry.scenario], entry.id).toBeDefined();
  }
});
```

Before defining scenario tests, write one `status: "skipped"` result for every
entry in `skipped`, with message `manual case` or
`not supported on <platform>`. This makes selection decisions explicit in each
OS artifact while the aggregator requires only automated, listed cells.

- [ ] **Step 2: Run the smoke file to verify it fails**

Run:

```bash
npx playwright test --config harness/playwright.config.ts harness/tests/smoke.spec.ts
```

Expected: FAIL because `SCENARIOS` and the worker environment do not exist.

- [ ] **Step 3: Implement the scenario registry**

Create `harness/src/scenarios.ts`:

```ts
export interface ScenarioContext {
  caseDefinition: HarnessCase;
  environment: HarnessEnvironment;
  dashboard: DashboardDriver;
  page: Page;
  artifactDir: string;
}

export type Scenario = (context: ScenarioContext) => Promise<void>;

export const SCENARIOS: Record<ScenarioKey, Scenario> = {
  "client-server.headless-dashboard": runHeadlessDashboard,
  "client-server.attached-pty": runAttachedPty,
};
```

Implement `runHeadlessDashboard` with this exact flow:

1. spawn `<client> run --headless --name CIH-01 <node> <fixture>`;
2. require exit code zero and parse stdout as one non-empty session ID line;
3. call `environment.trackSession(id)`;
4. open the dashboard and wait for `data-session-status="running"`;
5. open the terminal and wait for `CIH_READY`;
6. send `PING <randomUUID()>` and wait for the matching `CIH_ECHO`;
7. send `EXIT 0`;
8. wait for dashboard and metadata status `completed`;
9. assert metadata `exitCode === 0`.

Implement `runAttachedPty` with this exact flow:

1. spawn `<client> run --name CIH-02 <node> <fixture>` through `node-pty`;
2. wait for `CIH_READY`;
3. discover the session ID with `environment.findSessionIdByName("CIH-02",
   timeoutMs)`, which polls `CLIMON_HOME/sessions/*.json` for that unique name;
4. track the ID;
5. open the dashboard after the session exists, let the isolated dashboard
   auto-select its only session, and verify `CIH_READY` is visible without
   clicking the session item or taking control;
6. write `PING <randomUUID()>` through the attached PTY and wait for `CIH_ECHO`;
7. write `EXIT 0` through the attached PTY and require exit code zero;
8. wait for dashboard and metadata status `completed`;
9. assert metadata `exitCode === 0`.

Do not parse `climon ls`; metadata is the stable cross-process contract.

- [ ] **Step 4: Add the worker-scoped environment and dynamic tests**

In `harness/tests/smoke.spec.ts`, extend Playwright’s base test with one
worker-scoped `HarnessEnvironment`. Give the worker fixture a 600-second setup
timeout so cold Cargo/Bun builds do not consume an individual case's
`timeoutSeconds`. For each selected case:

```ts
test(`${entry.id} ${entry.title} @smoke`, async ({
  page,
  harnessEnvironment,
}, testInfo) => {
  test.setTimeout(entry.timeoutSeconds * 1000);
  const started = Date.now();
  const artifactDir = caseArtifactDir(
    harnessEnvironment.artifactRoot,
    entry.id
  );

  try {
    await SCENARIOS[entry.scenario]({
      caseDefinition: entry,
      environment: harnessEnvironment,
      dashboard: new DashboardDriver(page),
      page,
      artifactDir,
    });
    await harnessEnvironment.snapshotState(
      resolve(artifactDir, "climon-home")
    );
    await writeCaseResult(artifactDir, {
      id: entry.id,
      platform: harnessEnvironment.platform,
      status: "passed",
      durationMs: Date.now() - started,
      artifactDir,
    });
  } catch (caught) {
    let error = caught;
    try {
      await harnessEnvironment.snapshotState(
        resolve(artifactDir, "climon-home")
      );
    } catch (snapshotError) {
      error = new HarnessError(
        "cleanup",
        `failed to snapshot state: ${String(snapshotError)}`,
        caught
      );
    }
    await writeCaseResult(
      artifactDir,
      failureResult(
        entry,
        harnessEnvironment.platform,
        error,
        started,
        artifactDir
      )
    );
    throw error;
  }
});
```

The worker fixture must call `dispose()` in `finally` and write a final
run-level state snapshot after process cleanup. Attach each case’s `result.json`,
logs, and case state snapshot to `testInfo`.

- [ ] **Step 5: Run the smoke suite locally**

Install Chromium once:

```bash
bun run harness:install-browser
```

Run:

```bash
bun run test:harness:smoke
```

Expected: CIH-01 and CIH-02 PASS on the current OS, with results under
`.test-tmp/harness/<platform>/`.

- [ ] **Step 6: Run a deliberate failure evidence check**

Temporarily change the expected headless echo prefix in the local working tree
from `CIH_ECHO` to `CIH_WRONG`, run:

```bash
bun run test:harness:smoke --grep CIH-01
```

Expected: FAIL with a case `result.json`, Playwright trace, screenshot, logs,
and state snapshot. Restore the temporary expectation immediately and rerun the
test successfully. Do not commit the deliberate failure.

- [ ] **Step 7: Commit**

```bash
git add harness/src/scenarios.ts harness/tests/smoke.spec.ts
git commit -m "test: exercise client and server end to end"
```

## Task 9: Add the three-OS GitHub Actions gate and result aggregation

**Files:**
- Create: `.github/workflows/client-server-harness.yml`
- Modify: `package.json`

- [ ] **Step 1: Add a local aggregate script and verify its failure mode**

Add to `package.json`:

```json
{
  "scripts": {
    "harness:aggregate": "tsx harness/src/aggregate.ts"
  }
}
```

Run the aggregator against an empty temporary directory:

```bash
bun run harness:aggregate -- \
  .test-tmp/harness-empty docs/manual-tests smoke
```

Expected: exit 1 and messages saying both cases did not run on all three
platforms.

- [ ] **Step 2: Create the workflow**

Create `.github/workflows/client-server-harness.yml`:

```yaml
name: Client/server harness

on:
  workflow_dispatch:
  pull_request:
    paths:
      - "harness/**"
      - "docs/manual-tests/**"
      - "rust/**"
      - "src/server.ts"
      - "src/server/**"
      - "src/web/**"
      - "scripts/server-build.ts"
      - "scripts/compile.ts"
      - "package.json"
      - "bun.lock"
      - ".github/workflows/client-server-harness.yml"

jobs:
  smoke:
    name: smoke (${{ matrix.platform }})
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: linux
            os: ubuntu-latest
          - platform: macos
            os: macos-latest
          - platform: windows
            os: windows-latest
    runs-on: ${{ matrix.os }}
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.10
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: bun install --frozen-lockfile
      - name: Install Chromium and Linux browser dependencies
        if: runner.os == 'Linux'
        run: npx playwright install --with-deps chromium
      - name: Install Chromium
        if: runner.os != 'Linux'
        run: npx playwright install chromium
      - name: Run harness
        run: bun run test:harness:smoke
        env:
          CLIMON_HARNESS_ARTIFACT_DIR: .test-tmp/harness/${{ matrix.platform }}
      - name: Upload harness evidence
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: client-server-harness-${{ matrix.platform }}
          path: .test-tmp/harness/${{ matrix.platform }}
          if-no-files-found: error

  aggregate:
    if: always()
    needs: smoke
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.10
      - run: bun install --frozen-lockfile
      - uses: actions/download-artifact@v4
        with:
          pattern: client-server-harness-*
          path: .test-tmp/harness-results
      - name: Aggregate cross-platform results
        run: >-
          bun run harness:aggregate --
          .test-tmp/harness-results docs/manual-tests smoke
      - name: Publish aggregate summary
        if: always()
        run: cat .test-tmp/harness-results/summary.md >> "$GITHUB_STEP_SUMMARY"
      - name: Upload aggregate summary
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: client-server-harness-summary
          path: |
            .test-tmp/harness-results/summary.json
            .test-tmp/harness-results/summary.md
```

- [ ] **Step 3: Validate workflow syntax and local scripts**

Run:

```bash
bun run typecheck
npx tsc -p harness/tsconfig.json
bun run test:harness:unit
```

Expected: all commands PASS.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/client-server-harness.yml package.json bun.lock
git commit -m "ci: run client server harness on three operating systems"
```

## Task 10: Document operation and catalogue the feature

**Files:**
- Create: `harness/README.md`
- Modify: `docs/features.md:126-138`

- [ ] **Step 1: Write the harness README**

Create `harness/README.md` with these exact sections:

- **Purpose** — source-built Rust client plus Bun server end-to-end gate.
- **Prerequisites** — Bun 1.3.10, stable Rust, Node 24, installed Chromium.
- **Install** — `bun install` and `bun run harness:install-browser`.
- **Run** — `bun run test:harness:unit`, `bun run test:harness:smoke`, and
  `bun run test:harness`.
- **Test selection** — cases come only from validated `yaml harness` blocks.
- **Artifacts** — `.test-tmp/harness/<platform>/` contents and failure evidence.
- **Adding a scenario** — add a registry key, implementation, tests, Markdown
  metadata, and update the `ScenarioKey` union.
- **Safety** — isolated `CLIMON_HOME`, fixture-only commands, PID/session-scoped
  cleanup, no broad process-name killing.

- [ ] **Step 2: Add the feature-catalogue row**

Under `## Dashboard — in development`, assign the next unused dashboard ID
after the current highest ID and add:

| ID | Feature | What it does | Value add | Identified by |
|---|---|---|---|---|
| `dash-25` | Cross-platform client/server CI harness | Builds the Rust client and compiled Bun server from one checkout, runs headless and attached PTY sessions, and drives the real dashboard in headless Chromium on macOS, Linux, and Windows CI. | Catches integration regressions across the client, daemon, server, WebSocket bridge, xterm UI, and OS PTY backends before release. | [manual-tests/cross-platform-ci-harness.md](manual-tests/cross-platform-ci-harness.md); `harness/`; `.github/workflows/client-server-harness.yml`; **feature branch** |

- [ ] **Step 3: Run the complete local verification**

Run:

```bash
bun run typecheck
npx tsc -p harness/tsconfig.json
bun test tests/server-build.test.ts tests/server-binary-smoke.test.ts \
  tests/session-item.test.ts
bun run test:harness:unit
bun run test:harness:smoke
cargo test -p climon-cli -p climon-session
```

Run the Cargo command from `rust/`. Expected: all commands PASS.

- [ ] **Step 4: Inspect the final change set**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intended harness, workflow, dependency,
UI-hook, documentation, and shared-build-helper changes.

- [ ] **Step 5: Commit**

```bash
git add harness/README.md docs/features.md
git commit -m "docs: document cross-platform client server harness"
```

## Task 11: Run the hosted matrix and resolve platform-specific failures

**Files:**
- Modify only files directly implicated by real matrix failures.

- [ ] **Step 1: Push the branch and open a PR against `dev`**

Use the repository workflow:

```bash
git push -u origin HEAD
gh pr create --base dev --fill
```

Do not target `main`.

- [ ] **Step 2: Wait for the client/server harness workflow**

Run:

```bash
gh pr checks --watch
```

Expected: Linux, macOS, Windows, and aggregate jobs all complete.

- [ ] **Step 3: Diagnose failures from preserved artifacts**

For any failed matrix leg:

```bash
gh run list --workflow client-server-harness.yml --limit 5
run_id="$(gh run list --workflow client-server-harness.yml --limit 1 \
  --json databaseId --jq '.[0].databaseId')"
gh run download "$run_id" --dir .test-tmp/downloaded-harness
```

Use the case `result.json`, trace, screenshot, logs, and state snapshot to fix
the root cause. Keep behavior shared; add an OS-adapter branch only for a real
OS difference. Add a focused regression test before each fix.

- [ ] **Step 4: Re-run targeted local checks and push fixes**

Run the smallest test covering the failure, stage the exact files changed for
that verified condition, then commit with a subject that names the condition
and push:

```bash
git diff --check
git commit -m "fix(harness): handle platform-specific process behavior"
git push
```

Replace the example commit subject with the verified root cause when it is more
specific; do not commit unrelated files.

- [ ] **Step 5: Confirm the release gate**

Run:

```bash
gh pr checks --watch
```

Expected: all three smoke jobs and the aggregate job PASS. Stop before merge and
request explicit user approval; do not merge autonomously.
