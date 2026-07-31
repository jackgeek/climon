import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { BunCommandRunner } from "../src/command.js";
import { HarnessError } from "../src/types.js";

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

describe("BunCommandRunner", () => {
  test("runs a command without shell interpolation and captures stdout", async () => {
    const workspace = makeWorkspace("command-success");
    const runner = new BunCommandRunner();
    const stdoutPath = join(workspace, "logs", "stdout.log");
    const stderrPath = join(workspace, "logs", "stderr.log");
    const unsafeArgument = "hello; echo not-run && $(printf nope)";

    try {
      const result = await runner.run({
        file: process.execPath,
        args: [
          "-e",
          `if (process.argv.at(-1) !== ${JSON.stringify(unsafeArgument)}) { process.exit(9); } process.stdout.write("ok");`,
          unsafeArgument,
        ],
        cwd: workspace,
        env: {},
        timeoutMs: 5_000,
        stdoutPath,
        stderrPath,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("ok");
      expect(result.stderr).toBe("");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(readFileSync(stdoutPath, "utf8")).toBe("ok");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("kills the spawned process on timeout and preserves streamed output", async () => {
    const workspace = makeWorkspace("command-timeout");
    const runner = new BunCommandRunner();
    const stdoutPath = join(workspace, "logs", "stdout.log");
    const stderrPath = join(workspace, "logs", "stderr.log");

    try {
      const timeoutError = await runner
        .run({
          file: process.execPath,
          args: [
            "-e",
            [
              "process.stdout.write('starting');",
              "setInterval(() => {}, 1_000);",
            ].join(""),
          ],
          cwd: workspace,
          env: {},
          timeoutMs: 100,
          stdoutPath,
          stderrPath,
        })
        .catch((error: unknown) => error);

      expect(timeoutError).toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "timeout",
          message: expect.stringContaining(process.execPath),
        })
      );
      expect(timeoutError).toBeInstanceOf(HarnessError);
      expect((timeoutError as HarnessError).kind).toBe("timeout");
      expect(readFileSync(stdoutPath, "utf8")).toBe("starting");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("times out even when a descendant keeps inherited stdout open", async () => {
    const workspace = makeWorkspace("command-timeout-descendant");
    const runner = new BunCommandRunner();
    const stdoutPath = join(workspace, "logs", "stdout.log");
    const stderrPath = join(workspace, "logs", "stderr.log");
    const pidPath = join(workspace, "descendant.pid");
    let descendantPid: number | undefined;

    try {
      const outcome = await Promise.race([
        runner
          .run({
            file: process.execPath,
            args: [
              "-e",
              [
                "const { spawn } = require('node:child_process');",
                "const { writeFileSync } = require('node:fs');",
                "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 1, 2] });",
                "writeFileSync(process.argv.at(-1), String(child.pid));",
                "child.unref();",
                "process.stdout.write('starting');",
                "setInterval(() => {}, 1000);",
              ].join(""),
              pidPath,
            ],
            cwd: workspace,
            env: {},
            timeoutMs: 100,
            stdoutPath,
            stderrPath,
          })
          .catch((error: unknown) => error),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);

      if (outcome !== "hung") {
        descendantPid = Number(readFileSync(pidPath, "utf8"));
      }

      expect(outcome).not.toBe("hung");
      expect(outcome).toBeInstanceOf(HarnessError);
      expect((outcome as HarnessError).kind).toBe("timeout");
      expect(readFileSync(stdoutPath, "utf8")).toBe("starting");
    } finally {
      if (descendantPid !== undefined && Number.isFinite(descendantPid)) {
        try {
          process.kill(descendantPid);
        } catch {
          // Best-effort cleanup for the detached descendant used in this test.
        }
      }
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("keeps the timeout deadline even if the parent exits before inherited pipes close", async () => {
    const workspace = makeWorkspace("command-timeout-parent-exits");
    const runner = new BunCommandRunner();
    const stdoutPath = join(workspace, "logs", "stdout.log");
    const stderrPath = join(workspace, "logs", "stderr.log");
    const pidPath = join(workspace, "descendant.pid");
    let descendantPid: number | undefined;

    try {
      const outcome = await Promise.race([
        runner
          .run({
            file: process.execPath,
            args: [
              "-e",
              [
                "const { spawn } = require('node:child_process');",
                "const { writeFileSync } = require('node:fs');",
                "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 1, 2] });",
                "writeFileSync(process.argv.at(-1), String(child.pid));",
                "child.unref();",
                "process.stdout.write('starting');",
              ].join(""),
              pidPath,
            ],
            cwd: workspace,
            env: {},
            timeoutMs: 100,
            stdoutPath,
            stderrPath,
          })
          .catch((error: unknown) => error),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);

      if (outcome !== "hung") {
        descendantPid = Number(readFileSync(pidPath, "utf8"));
      }

      expect(outcome).not.toBe("hung");
      expect(outcome).toBeInstanceOf(HarnessError);
      expect((outcome as HarnessError).kind).toBe("timeout");
      expect(readFileSync(stdoutPath, "utf8")).toBe("starting");
    } finally {
      if (descendantPid !== undefined && Number.isFinite(descendantPid)) {
        try {
          process.kill(descendantPid);
        } catch {
          // Best-effort cleanup for the detached descendant used in this test.
        }
      }
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
