import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  CaseArtifacts,
  caseArtifactDir,
  redactRecord,
} from "../src/artifacts.js";

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

describe("redactRecord", () => {
  test("redacts secret-like keys and omits undefined values", () => {
    expect(
      redactRecord({
        TOKEN: "abc123",
        user: "alice",
        connectionString: "postgres://secret",
        undefinedValue: undefined,
        api_key: "top-secret",
      })
    ).toEqual({
      TOKEN: "[redacted]",
      user: "alice",
      connectionString: "[redacted]",
      api_key: "[redacted]",
    });
  });
});

describe("CaseArtifacts", () => {
  test("uses cases/<DAR-ID> directories and creates the case directory on initialize", async () => {
    const workspace = makeWorkspace("artifacts-case-dir");
    const dir = caseArtifactDir(join(workspace, "artifacts"), "DAR-01");

    try {
      const artifacts = new CaseArtifacts(dir);
      await artifacts.initialize();

      expect(dir).toBe(join(workspace, "artifacts", "cases", "DAR-01"));
      expect(statSync(dir).isDirectory()).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("recreates the case directory without stale files or symlinks", async () => {
    const workspace = makeWorkspace("artifacts-fresh-case");
    const dir = join(workspace, "case");
    const outside = join(workspace, "outside");
    mkdirSync(dir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(dir, "stale.log"), "old");

    try {
      symlinkSync(outside, join(dir, "linked"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP") {
        throw error;
      }
    }

    try {
      await new CaseArtifacts(dir).initialize();

      expect(existsSync(join(dir, "stale.log"))).toBe(false);
      expect(existsSync(join(dir, "linked"))).toBe(false);
      expect(statSync(dir).isDirectory()).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("appends text incrementally and writes stable JSON with a trailing newline", async () => {
    const workspace = makeWorkspace("artifacts-write");
    const artifacts = new CaseArtifacts(join(workspace, "case"));

    try {
      await artifacts.initialize();
      await artifacts.appendText("logs/stdout.log", "first\n");
      await artifacts.appendText("logs/stdout.log", "second\n");
      await artifacts.writeJson("result.json", {
        zebra: 1,
        alpha: { delta: 4, beta: 2 },
      });

      expect(readFileSync(join(workspace, "case", "logs", "stdout.log"), "utf8")).toBe(
        "first\nsecond\n"
      );
      expect(readFileSync(join(workspace, "case", "result.json"), "utf8")).toBe(
        [
          "{",
          '  "alpha": {',
          '    "beta": 2,',
          '    "delta": 4',
          "  },",
          '  "zebra": 1',
          "}",
          "",
        ].join("\n")
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("copies only regular files and directories into snapshots", async () => {
    const workspace = makeWorkspace("artifacts-snapshot");
    const source = join(workspace, "source");
    const artifacts = new CaseArtifacts(join(workspace, "case"));

    try {
      mkdirSync(join(source, "nested"), { recursive: true });
      writeFileSync(join(source, "root.txt"), "root");
      writeFileSync(join(source, "nested", "child.txt"), "child");

      try {
        symlinkSync(join(source, "root.txt"), join(source, "root-link.txt"));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP") {
          throw error;
        }
      }

      await artifacts.initialize();
      await artifacts.snapshotTree(source, "home");

      expect(readFileSync(join(workspace, "case", "home", "root.txt"), "utf8")).toBe(
        "root"
      );
      expect(
        readFileSync(join(workspace, "case", "home", "nested", "child.txt"), "utf8")
      ).toBe("child");
      expect(existsSync(join(workspace, "case", "home", "root-link.txt"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects artifact path traversal attempts", async () => {
    const workspace = makeWorkspace("artifacts-traversal");
    const artifacts = new CaseArtifacts(join(workspace, "case"));
    mkdirSync(join(workspace, "source"), { recursive: true });

    try {
      await artifacts.initialize();

      await expect(artifacts.appendText("../escape.txt", "nope")).rejects.toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "prerequisite",
        })
      );
      await expect(artifacts.snapshotTree(join(workspace, "source"), "../escape")).rejects.toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "prerequisite",
        })
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
