import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platformFromNode, executableName } from "../src/platform.js";
import type { CommandSpec, CommandResult, CommandRunner } from "../src/command.js";
import { planHostBuild, buildHostArtifacts } from "../src/build.js";
import { compiledServerBuildArgs } from "../../scripts/server-build.js";
import { HarnessError } from "../src/types.js";

const platform = platformFromNode(process.platform);
const root = resolve(import.meta.dirname, "../..");
const buildDir = resolve(root, ".test-tmp", "harness", platform, "build");

// ── Fake CommandRunner ───────────────────────────────────────────────────────

class RecordingRunner implements CommandRunner {
  readonly calls: CommandSpec[] = [];
  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    return { code: 0, signal: null, durationMs: 0, stdout: "", stderr: "" };
  }
}

// ── planHostBuild ────────────────────────────────────────────────────────────

test("planHostBuild: clientPath is <root>/rust/target/debug/climon[.exe]", () => {
  const plan = planHostBuild(root, buildDir, platform);
  const expected = join(root, "rust", "target", "debug", executableName("climon", platform));
  expect(plan.clientPath).toBe(expected);
});

test("planHostBuild: serverPath is <buildDir>/climon-server[.exe]", () => {
  const plan = planHostBuild(root, buildDir, platform);
  const expected = join(buildDir, executableName("climon-server", platform));
  expect(plan.serverPath).toBe(expected);
});

test("planHostBuild: fixturePath is <root>/harness/fixtures/echo-session.mjs", () => {
  const plan = planHostBuild(root, buildDir, platform);
  const expected = join(root, "harness", "fixtures", "echo-session.mjs");
  expect(plan.fixturePath).toBe(expected);
});

test("planHostBuild: produces exactly 3 commands", () => {
  const plan = planHostBuild(root, buildDir, platform);
  expect(plan.commands).toHaveLength(3);
});

test("planHostBuild: first command is cargo build -p climon-cli with cwd <root>/rust", () => {
  const plan = planHostBuild(root, buildDir, platform);
  const cmd = plan.commands[0];
  expect(cmd.file).toBe("cargo");
  expect(cmd.args).toEqual(["build", "-p", "climon-cli"]);
  expect(cmd.cwd).toBe(join(root, "rust"));
});

test("planHostBuild: second command is bun scripts/embed-assets.ts with cwd root", () => {
  const plan = planHostBuild(root, buildDir, platform);
  const cmd = plan.commands[1];
  expect(cmd.file).toBe("bun");
  expect(cmd.args).toEqual(["scripts/embed-assets.ts"]);
  expect(cmd.cwd).toBe(root);
});

test("planHostBuild: third command is bun with compiledServerBuildArgs(serverPath) and cwd root", () => {
  const plan = planHostBuild(root, buildDir, platform);
  const cmd = plan.commands[2];
  expect(cmd.file).toBe("bun");
  expect(cmd.args).toEqual(compiledServerBuildArgs(plan.serverPath));
  expect(cmd.cwd).toBe(root);
});

test("planHostBuild: all command envs omit APPLICATIONINSIGHTS_CONNECTION_STRING", () => {
  const plan = planHostBuild(root, buildDir, platform);
  for (const cmd of plan.commands) {
    expect(Object.keys(cmd.env)).not.toContain("APPLICATIONINSIGHTS_CONNECTION_STRING");
  }
});

test("planHostBuild: commands preserve PATH from process.env when present", () => {
  const envPath = process.env.PATH;
  if (envPath === undefined) return; // skip on platforms without PATH
  const plan = planHostBuild(root, buildDir, platform);
  for (const cmd of plan.commands) {
    expect(cmd.env.PATH).toBe(envPath);
  }
});

test("planHostBuild: all command log paths are under buildDir/logs", () => {
  const plan = planHostBuild(root, buildDir, platform);
  const logDir = join(buildDir, "logs");
  for (const cmd of plan.commands) {
    expect(cmd.stdoutPath.startsWith(logDir)).toBe(true);
    expect(cmd.stderrPath.startsWith(logDir)).toBe(true);
  }
});

test("planHostBuild: all command log paths are distinct", () => {
  const plan = planHostBuild(root, buildDir, platform);
  const allPaths = plan.commands.flatMap((c) => [c.stdoutPath, c.stderrPath]);
  const unique = new Set(allPaths);
  expect(unique.size).toBe(allPaths.length);
});

test("planHostBuild: all commands have timeoutMs of 600000", () => {
  const plan = planHostBuild(root, buildDir, platform);
  for (const cmd of plan.commands) {
    expect(cmd.timeoutMs).toBe(600_000);
  }
});

// ── buildHostArtifacts ───────────────────────────────────────────────────────

test("buildHostArtifacts: invokes runner for each of the 3 commands in order", async () => {
  const plan = planHostBuild(root, buildDir, platform);
  const runner = new RecordingRunner();
  const fakeStat = async (_p: string) => ({ isFile: () => true });

  await buildHostArtifacts(plan, runner, fakeStat);

  expect(runner.calls).toHaveLength(3);
  expect(runner.calls[0].file).toBe("cargo");
  expect(runner.calls[1].file).toBe("bun");
  expect(runner.calls[2].file).toBe("bun");
});

test("buildHostArtifacts: returns artifacts with correct paths", async () => {
  const plan = planHostBuild(root, buildDir, platform);
  const runner = new RecordingRunner();
  const fakeStat = async (_p: string) => ({ isFile: () => true });

  const artifacts = await buildHostArtifacts(plan, runner, fakeStat);

  expect(artifacts.clientPath).toBe(plan.clientPath);
  expect(artifacts.serverPath).toBe(plan.serverPath);
  expect(artifacts.fixturePath).toBe(plan.fixturePath);
});

test("buildHostArtifacts: rejects with HarnessError build when clientPath is not a regular file", async () => {
  const plan = planHostBuild(root, buildDir, platform);
  const runner = new RecordingRunner();
  const fakeStat = async (p: string) => ({ isFile: () => p !== plan.clientPath });

  await expect(buildHostArtifacts(plan, runner, fakeStat)).rejects.toMatchObject({
    kind: "build",
  });
});

test("buildHostArtifacts: rejects with HarnessError build when serverPath is not a regular file", async () => {
  const plan = planHostBuild(root, buildDir, platform);
  const runner = new RecordingRunner();
  const fakeStat = async (p: string) => ({ isFile: () => p !== plan.serverPath });

  await expect(buildHostArtifacts(plan, runner, fakeStat)).rejects.toMatchObject({
    kind: "build",
  });
});

test("buildHostArtifacts: rejects with HarnessError build when fixturePath is not a regular file", async () => {
  const plan = planHostBuild(root, buildDir, platform);
  const runner = new RecordingRunner();
  const fakeStat = async (p: string) => ({ isFile: () => p !== plan.fixturePath });

  await expect(buildHostArtifacts(plan, runner, fakeStat)).rejects.toMatchObject({
    kind: "build",
  });
});

test("buildHostArtifacts: checks stat for all three expected output paths", async () => {
  const plan = planHostBuild(root, buildDir, platform);
  const runner = new RecordingRunner();
  const checkedPaths: string[] = [];
  const fakeStat = async (p: string) => {
    checkedPaths.push(p);
    return { isFile: () => true };
  };

  await buildHostArtifacts(plan, runner, fakeStat);

  expect(checkedPaths).toContain(plan.clientPath);
  expect(checkedPaths).toContain(plan.serverPath);
  expect(checkedPaths).toContain(plan.fixturePath);
});

test("buildHostArtifacts: rejects with HarnessError build wrapping stat ENOENT for clientPath, including path in message and original cause", async () => {
  const plan = planHostBuild(root, buildDir, platform);
  const runner = new RecordingRunner();
  const enoentError = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  const fakeStat = async (p: string) => {
    if (p === plan.clientPath) throw enoentError;
    return { isFile: () => true };
  };

  const err = await buildHostArtifacts(plan, runner, fakeStat).catch((e) => e);
  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("build");
  expect((err as HarnessError).message).toContain(plan.clientPath);
  expect((err as HarnessError).cause).toBe(enoentError);
});

test("headless session host primes ConPTY before sharing the PTY writer", async () => {
  const source = await readFile(join(root, "rust", "climon-session", "src", "host.rs"), "utf8");
  expect(source).toMatch(
    /let mut writer = pty\.take_writer\(\)\?;\s+climon_pty::prime_headless_conpty\(&mut \*writer, headless\)\?;\s+let resizer = pty\.resizer\(\);/,
  );
});
