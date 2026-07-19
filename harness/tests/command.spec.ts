import { expect, test } from "@playwright/test";
import { createCommandRunner } from "../src/command.js";
import { HarnessError } from "../src/types.js";
import { mkdtemp, readFile } from "node:fs/promises";
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

test("command runner: timed-out child is dead and rejection is bounded", async () => {
  const runner = createCommandRunner();
  const logDir = await mkdtemp(join(tmpdir(), "climon-cmd-dead-"));
  const pidFile = join(logDir, "child.pid");

  // Child writes its PID then loops indefinitely
  const script = [
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `setInterval(() => {}, 100);`,
  ].join(" ");

  const start = Date.now();
  const err = await runner
    .run({
      file: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 400,
      stdoutPath: join(logDir, "stdout.log"),
      stderrPath: join(logDir, "stderr.log"),
      detached: true,
    })
    .catch((e) => e);
  const elapsed = Date.now() - start;

  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("timeout");
  // Rejection must arrive within 5 s of the timeout (cleanup is bounded)
  expect(elapsed).toBeLessThan(5_000);

  // The timed-out child must be dead at the point of rejection
  const rawPid = await readFile(pidFile, "utf8").catch(() => "0");
  const pid = parseInt(rawPid, 10);
  expect(pid).toBeGreaterThan(0);
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    // ESRCH — process not found, as expected
  }
  expect(alive).toBe(false);
});
