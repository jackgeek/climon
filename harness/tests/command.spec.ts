import { expect, test } from "@playwright/test";
import { createCommandRunner } from "../src/command.js";
import { HarnessError } from "../src/types.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("command runner: success exits with code 0 and resolves", async () => {
  const runner = createCommandRunner();
  const logDir = await mkdtemp(join(tmpdir(), "climon-cmd-"));
  const result = await runner.run({
    file: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 10_000,
    stdoutPath: join(logDir, "stdout.log"),
    stderrPath: join(logDir, "stderr.log"),
  });
  expect(result.code).toBe(0);
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
});

test("command runner: stdout content is captured in result", async () => {
  const runner = createCommandRunner();
  const logDir = await mkdtemp(join(tmpdir(), "climon-cmd-"));
  const result = await runner.run({
    file: process.execPath,
    args: ["-e", "process.stdout.write('hello-output\\n'); process.exit(0)"],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 10_000,
    stdoutPath: join(logDir, "stdout.log"),
    stderrPath: join(logDir, "stderr.log"),
  });
  expect(result.stdout).toContain("hello-output");
});

test("command runner: nonzero exit rejects with HarnessError of kind build", async () => {
  const runner = createCommandRunner();
  const logDir = await mkdtemp(join(tmpdir(), "climon-cmd-"));
  const err = await runner
    .run({
      file: process.execPath,
      args: ["-e", "process.exit(42)"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 10_000,
      stdoutPath: join(logDir, "stdout.log"),
      stderrPath: join(logDir, "stderr.log"),
    })
    .catch((e) => e);
  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("build");
  expect((err as HarnessError).message).toContain("42");
});

test("command runner: timeout rejects with HarnessError of kind timeout", async () => {
  const runner = createCommandRunner();
  const logDir = await mkdtemp(join(tmpdir(), "climon-cmd-"));
  const err = await runner
    .run({
      file: process.execPath,
      args: ["-e", "setInterval(()=>{},100)"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 400,
      stdoutPath: join(logDir, "stdout.log"),
      stderrPath: join(logDir, "stderr.log"),
      detached: true,
    })
    .catch((e) => e);
  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("timeout");
});
