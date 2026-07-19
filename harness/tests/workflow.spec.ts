import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import yaml from "yaml";

const workflowPath = resolve(
  import.meta.dirname,
  "../../.github/workflows/client-server-harness.yml"
);

// ── Helpers ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YamlDoc = Record<string, any>;

async function loadWorkflow(): Promise<YamlDoc> {
  const raw = await readFile(workflowPath, "utf8");
  return yaml.parse(raw) as YamlDoc;
}

function smokeSteps(wf: YamlDoc): YamlDoc[] {
  return (wf.jobs?.smoke?.steps ?? []) as YamlDoc[];
}

function aggregateSteps(wf: YamlDoc): YamlDoc[] {
  return (wf.jobs?.aggregate?.steps ?? []) as YamlDoc[];
}

function hasStep(
  steps: YamlDoc[],
  predicate: (s: YamlDoc) => boolean
): boolean {
  return steps.some(predicate);
}

// ── Triggers ─────────────────────────────────────────────────────────────────

test("workflow: has a non-empty name", async () => {
  const wf = await loadWorkflow();
  expect(typeof wf.name).toBe("string");
  expect((wf.name as string).length).toBeGreaterThan(0);
});

test("workflow: triggers include workflow_dispatch", async () => {
  const wf = await loadWorkflow();
  expect(wf.on).toBeDefined();
  expect(wf.on.workflow_dispatch !== undefined).toBe(true);
});

test("workflow: triggers include pull_request", async () => {
  const wf = await loadWorkflow();
  expect(wf.on.pull_request).toBeDefined();
});

test("workflow: pull_request has path filters", async () => {
  const wf = await loadWorkflow();
  const paths: string[] = wf.on.pull_request?.paths ?? [];
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.some((p) => p.startsWith("harness/"))).toBe(true);
  expect(paths.some((p) => p.startsWith("rust/"))).toBe(true);
  expect(paths.some((p) => p === "package.json")).toBe(true);
  // workflow watches itself
  expect(
    paths.some((p) => p.includes("client-server-harness"))
  ).toBe(true);
});

// ── Smoke job ─────────────────────────────────────────────────────────────────

test("workflow: smoke matrix has exactly three platforms (linux/macos/windows)", async () => {
  const wf = await loadWorkflow();
  const include: YamlDoc[] = wf.jobs?.smoke?.strategy?.matrix?.include ?? [];
  expect(include).toHaveLength(3);
  const platforms = include.map((r: YamlDoc) => r.platform as string).sort();
  expect(platforms).toEqual(["linux", "macos", "windows"]);
});

test("workflow: smoke matrix os values are ubuntu-latest / macos-latest / windows-latest", async () => {
  const wf = await loadWorkflow();
  const include: YamlDoc[] = wf.jobs?.smoke?.strategy?.matrix?.include ?? [];
  const byPlatform = Object.fromEntries(
    include.map((r: YamlDoc) => [r.platform as string, r.os as string])
  );
  expect(byPlatform["linux"]).toBe("ubuntu-latest");
  expect(byPlatform["macos"]).toBe("macos-latest");
  expect(byPlatform["windows"]).toBe("windows-latest");
});

test("workflow: smoke strategy fail-fast is false", async () => {
  const wf = await loadWorkflow();
  expect(wf.jobs?.smoke?.strategy?.["fail-fast"]).toBe(false);
});

test("workflow: smoke timeout-minutes is 25", async () => {
  const wf = await loadWorkflow();
  expect(wf.jobs?.smoke?.["timeout-minutes"]).toBe(25);
});

test("workflow: smoke has Bun 1.3.10 setup step", async () => {
  const wf = await loadWorkflow();
  const steps = smokeSteps(wf);
  const bunStep = steps.find(
    (s) =>
      typeof s.uses === "string" && s.uses.startsWith("oven-sh/setup-bun")
  );
  expect(bunStep).toBeDefined();
  expect(bunStep?.with?.["bun-version"]).toBe("1.3.10");
});

test("workflow: smoke has Node 24 setup step", async () => {
  const wf = await loadWorkflow();
  const steps = smokeSteps(wf);
  const nodeStep = steps.find(
    (s) =>
      typeof s.uses === "string" && s.uses.startsWith("actions/setup-node")
  );
  expect(nodeStep).toBeDefined();
  expect(String(nodeStep?.with?.["node-version"])).toBe("24");
});

test("workflow: smoke has frozen bun install step", async () => {
  const wf = await loadWorkflow();
  const steps = smokeSteps(wf);
  expect(
    hasStep(steps, (s) =>
      typeof s.run === "string" && s.run.includes("--frozen-lockfile")
    )
  ).toBe(true);
});

test("workflow: smoke browser install uses --with-deps on Linux", async () => {
  const wf = await loadWorkflow();
  const steps = smokeSteps(wf);
  const linuxBrowserStep = steps.find(
    (s) =>
      typeof s.run === "string" &&
      s.run.includes("playwright install") &&
      s.run.includes("--with-deps")
  );
  expect(linuxBrowserStep).toBeDefined();
  expect(String(linuxBrowserStep?.if ?? "")).toContain("linux");
});

test("workflow: smoke browser install on non-Linux omits --with-deps", async () => {
  const wf = await loadWorkflow();
  const steps = smokeSteps(wf);
  const nonLinuxBrowserStep = steps.find(
    (s) =>
      typeof s.run === "string" &&
      s.run.includes("playwright install") &&
      !s.run.includes("--with-deps")
  );
  expect(nonLinuxBrowserStep).toBeDefined();
  // The step's if condition should exclude Linux
  const ifExpr = String(nonLinuxBrowserStep?.if ?? "");
  expect(ifExpr.length).toBeGreaterThan(0);
});

test("workflow: smoke has test:harness:smoke step with CLIMON_HARNESS_ARTIFACT_DIR", async () => {
  const wf = await loadWorkflow();
  const steps = smokeSteps(wf);
  const testStep = steps.find(
    (s) =>
      typeof s.run === "string" && s.run.includes("test:harness:smoke")
  );
  expect(testStep).toBeDefined();
  expect(
    testStep?.env?.CLIMON_HARNESS_ARTIFACT_DIR !== undefined
  ).toBe(true);
  // artifact dir uses matrix.platform
  expect(
    String(testStep?.env?.CLIMON_HARNESS_ARTIFACT_DIR)
  ).toContain("matrix.platform");
});

test("workflow: smoke uploads artifacts always with if-no-files-found error", async () => {
  const wf = await loadWorkflow();
  const steps = smokeSteps(wf);
  const uploadStep = steps.find(
    (s) =>
      typeof s.uses === "string" &&
      s.uses.startsWith("actions/upload-artifact")
  );
  expect(uploadStep).toBeDefined();
  expect(String(uploadStep?.if ?? "")).toContain("always");
  expect(uploadStep?.with?.["if-no-files-found"]).toBe("error");
  expect(String(uploadStep?.with?.name ?? "")).toContain("matrix.platform");
});

// ── Aggregate job ─────────────────────────────────────────────────────────────

test("workflow: aggregate job needs smoke", async () => {
  const wf = await loadWorkflow();
  const needs = wf.jobs?.aggregate?.needs;
  // needs can be a string or array
  const needsArray = Array.isArray(needs) ? needs : [needs];
  expect(needsArray).toContain("smoke");
});

test("workflow: aggregate job has if always()", async () => {
  const wf = await loadWorkflow();
  const ifExpr = String(wf.jobs?.aggregate?.if ?? "");
  expect(ifExpr).toContain("always");
});

test("workflow: aggregate runs on ubuntu-latest", async () => {
  const wf = await loadWorkflow();
  expect(wf.jobs?.aggregate?.["runs-on"]).toBe("ubuntu-latest");
});

test("workflow: aggregate has Bun 1.3.10 setup", async () => {
  const wf = await loadWorkflow();
  const steps = aggregateSteps(wf);
  const bunStep = steps.find(
    (s) =>
      typeof s.uses === "string" && s.uses.startsWith("oven-sh/setup-bun")
  );
  expect(bunStep).toBeDefined();
  expect(bunStep?.with?.["bun-version"]).toBe("1.3.10");
});

test("workflow: aggregate downloads artifacts with pattern client-server-harness-*", async () => {
  const wf = await loadWorkflow();
  const steps = aggregateSteps(wf);
  const downloadStep = steps.find(
    (s) =>
      typeof s.uses === "string" &&
      s.uses.startsWith("actions/download-artifact")
  );
  expect(downloadStep).toBeDefined();
  expect(downloadStep?.with?.pattern).toBe("client-server-harness-*");
  expect(downloadStep?.with?.path).toContain("harness-results");
});

test("workflow: aggregate runs harness:aggregate with results dir docs/manual-tests smoke", async () => {
  const wf = await loadWorkflow();
  const steps = aggregateSteps(wf);
  const aggregateStep = steps.find(
    (s) =>
      typeof s.run === "string" &&
      s.run.includes("harness:aggregate")
  );
  expect(aggregateStep).toBeDefined();
  const run = String(aggregateStep?.run ?? "");
  expect(run).toContain("docs/manual-tests");
  expect(run).toContain("smoke");
  expect(run).toContain("harness-results");
});

test("workflow: aggregate appends summary.md to GITHUB_STEP_SUMMARY", async () => {
  const wf = await loadWorkflow();
  const steps = aggregateSteps(wf);
  const summaryStep = steps.find(
    (s) =>
      typeof s.run === "string" &&
      s.run.includes("GITHUB_STEP_SUMMARY") &&
      s.run.includes("summary.md")
  );
  expect(summaryStep).toBeDefined();
});

test("workflow: aggregate uploads summary files always", async () => {
  const wf = await loadWorkflow();
  const steps = aggregateSteps(wf);
  const uploadStep = steps.find(
    (s) =>
      typeof s.uses === "string" &&
      s.uses.startsWith("actions/upload-artifact") &&
      typeof s.with?.path === "string" &&
      s.with.path.includes("summary")
  );
  expect(uploadStep).toBeDefined();
  expect(String(uploadStep?.if ?? "")).toContain("always");
});
