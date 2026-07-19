import { expect, test } from "@playwright/test";
import {
  caseArtifactDir,
  failureResult,
  redactEnvironment,
  shouldSnapshotFileType,
  snapshotHome,
  writeCaseResult,
} from "../src/artifacts.js";
import { HarnessError } from "../src/types.js";
import type { CaseResult, HarnessCase } from "../src/types.js";
import {
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── redactEnvironment ────────────────────────────────────────────────────────

test("redactEnvironment: redacts API_TOKEN to [REDACTED]", () => {
  const result = redactEnvironment({ API_TOKEN: "secret123", PATH: "/usr/bin" });
  expect(result["API_TOKEN"]).toBe("[REDACTED]");
});

test("redactEnvironment: redacts APPLICATIONINSIGHTS_CONNECTION_STRING to [REDACTED]", () => {
  const result = redactEnvironment({
    APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=abc",
  });
  expect(result["APPLICATIONINSIGHTS_CONNECTION_STRING"]).toBe("[REDACTED]");
});

test("redactEnvironment: preserves PATH", () => {
  const result = redactEnvironment({
    PATH: "/usr/bin:/usr/local/bin",
    API_TOKEN: "secret",
  });
  expect(result["PATH"]).toBe("/usr/bin:/usr/local/bin");
});

test("redactEnvironment: omits entries with undefined values", () => {
  const env: Record<string, string | undefined> = {
    DEFINED: "value",
    MISSING: undefined,
  };
  const result = redactEnvironment(env as Record<string, string>);
  expect(Object.keys(result)).not.toContain("MISSING");
  expect(result["DEFINED"]).toBe("value");
});

// ── shouldSnapshotFileType ───────────────────────────────────────────────────

test("shouldSnapshotFileType: returns true for file", () => {
  expect(shouldSnapshotFileType("file")).toBe(true);
});

test("shouldSnapshotFileType: returns true for directory", () => {
  expect(shouldSnapshotFileType("directory")).toBe(true);
});

test("shouldSnapshotFileType: returns false for socket", () => {
  expect(shouldSnapshotFileType("socket")).toBe(false);
});

test("shouldSnapshotFileType: returns false for fifo", () => {
  expect(shouldSnapshotFileType("fifo")).toBe(false);
});

test("shouldSnapshotFileType: returns false for other", () => {
  expect(shouldSnapshotFileType("other")).toBe(false);
});

// ── snapshotHome ─────────────────────────────────────────────────────────────

test("snapshotHome: copies nested regular files from fake home", async () => {
  const homeDir = join(tmpdir(), `climon-snap-src-${Date.now()}`);
  const dstDir = join(tmpdir(), `climon-snap-dst-${Date.now()}`);
  await mkdir(homeDir, { recursive: true });
  await mkdir(dstDir, { recursive: true });
  await mkdir(join(homeDir, "subdir"), { recursive: true });
  await writeFile(join(homeDir, "a.txt"), "hello");
  await writeFile(join(homeDir, "subdir", "b.txt"), "world");

  await snapshotHome(homeDir, dstDir);

  expect(await readFile(join(dstDir, "a.txt"), "utf8")).toBe("hello");
  expect(await readFile(join(dstDir, "subdir", "b.txt"), "utf8")).toBe("world");
});

test("snapshotHome: does not follow or copy symlinks", async () => {
  const homeDir = join(tmpdir(), `climon-snap-sym-src-${Date.now()}`);
  const dstDir = join(tmpdir(), `climon-snap-sym-dst-${Date.now()}`);
  await mkdir(homeDir, { recursive: true });
  await mkdir(dstDir, { recursive: true });
  await writeFile(join(homeDir, "real.txt"), "real content");
  await symlink(join(homeDir, "real.txt"), join(homeDir, "link.txt"));

  await snapshotHome(homeDir, dstDir);

  const files = await readdir(dstDir);
  expect(files).not.toContain("link.txt");
  expect(files).toContain("real.txt");
});

// ── writeCaseResult ──────────────────────────────────────────────────────────

test("writeCaseResult: writes valid result.json with all fields", async () => {
  const dir = join(tmpdir(), `climon-result-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const result: CaseResult = {
    id: "CIH-01",
    platform: "linux",
    status: "passed",
    durationMs: 1234,
    artifactDir: dir,
  };
  await writeCaseResult(dir, result);
  const content = await readFile(join(dir, "result.json"), "utf8");
  const parsed = JSON.parse(content) as CaseResult;
  expect(parsed.id).toBe("CIH-01");
  expect(parsed.platform).toBe("linux");
  expect(parsed.status).toBe("passed");
  expect(parsed.durationMs).toBe(1234);
});

test("writeCaseResult: result.json ends with a newline", async () => {
  const dir = join(tmpdir(), `climon-result-nl-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const result: CaseResult = {
    id: "CIH-02",
    platform: "macos",
    status: "failed",
    durationMs: 500,
    failureKind: "assertion",
    artifactDir: dir,
  };
  await writeCaseResult(dir, result);
  const raw = await readFile(join(dir, "result.json"), "utf8");
  expect(raw.endsWith("\n")).toBe(true);
});

// ── caseArtifactDir ──────────────────────────────────────────────────────────

test("caseArtifactDir: produces <artifactRoot>/cases/<caseId>", () => {
  const dir = caseArtifactDir("/artifacts", "CIH-01");
  expect(dir).toBe("/artifacts/cases/CIH-01");
});

test("caseArtifactDir: allows dots and hyphens in caseId", () => {
  expect(() => caseArtifactDir("/artifacts", "CIH-01.v2")).not.toThrow();
});

test("caseArtifactDir: rejects path traversal with ../ ", () => {
  expect(() => caseArtifactDir("/artifacts", "../evil")).toThrow();
});

test("caseArtifactDir: rejects slash in caseId", () => {
  expect(() => caseArtifactDir("/artifacts", "a/b")).toThrow();
});

test("caseArtifactDir: throws HarnessError with kind catalogue on invalid id", () => {
  const err = (() => {
    try {
      caseArtifactDir("/artifacts", "bad id!");
    } catch (e) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("catalogue");
});

test("caseArtifactDir: rejects bare . as caseId with HarnessError catalogue", () => {
  const err = (() => {
    try {
      caseArtifactDir("/artifacts", ".");
    } catch (e) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("catalogue");
});

test("caseArtifactDir: rejects bare .. as caseId with HarnessError catalogue", () => {
  const err = (() => {
    try {
      caseArtifactDir("/artifacts", "..");
    } catch (e) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("catalogue");
});

// ── failureResult ────────────────────────────────────────────────────────────

const definition: HarnessCase = {
  id: "CIH-01",
  title: "Test case",
  sourceFile: "cases.md",
  status: "automated",
  suite: "smoke",
  scenario: "client-server.headless-dashboard",
  platforms: ["linux"],
  timeoutSeconds: 60,
};

test("failureResult: status is failed", () => {
  const result = failureResult(
    definition,
    "linux",
    new Error("boom"),
    Date.now() - 100,
    "/artifacts/CIH-01"
  );
  expect(result.status).toBe("failed");
});

test("failureResult: preserves HarnessError kind", () => {
  const err = new HarnessError("timeout", "timed out after 60s");
  const result = failureResult(
    definition,
    "linux",
    err,
    Date.now() - 200,
    "/artifacts/CIH-01"
  );
  expect(result.failureKind).toBe("timeout");
});

test("failureResult: maps unknown Error to assertion kind", () => {
  const err = new Error("something unexpected");
  const result = failureResult(
    definition,
    "linux",
    err,
    Date.now() - 50,
    "/artifacts/CIH-01"
  );
  expect(result.failureKind).toBe("assertion");
});

test("failureResult: elapsed durationMs is >= 0", () => {
  const result = failureResult(
    definition,
    "linux",
    new HarnessError("build", "build failed"),
    Date.now() - 300,
    "/artifacts/CIH-01"
  );
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
});

test("failureResult: message includes error text", () => {
  const err = new HarnessError("build", "compilation failed: missing symbol");
  const result = failureResult(
    definition,
    "linux",
    err,
    Date.now() - 10,
    "/artifacts/CIH-01"
  );
  expect(result.message).toContain("compilation failed");
});

test("failureResult: sets id and platform from definition and argument", () => {
  const result = failureResult(
    definition,
    "windows",
    new Error("x"),
    Date.now(),
    "/artifacts/CIH-01"
  );
  expect(result.id).toBe("CIH-01");
  expect(result.platform).toBe("windows");
});
