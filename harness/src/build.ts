import { join } from "node:path";
import { lstat } from "node:fs/promises";
import type { HarnessPlatform } from "./types.js";
import { HarnessError } from "./types.js";
import { executableName } from "./platform.js";
import type { CommandRunner, CommandSpec } from "./command.js";
import { compiledServerBuildArgs } from "../../scripts/server-build.js";

export interface BuildArtifacts {
  clientPath: string;
  serverPath: string;
  fixturePath: string;
}

export interface BuildPlan {
  clientPath: string;
  serverPath: string;
  fixturePath: string;
  commands: CommandSpec[];
}

export type StatFn = (path: string) => Promise<{ isFile(): boolean }>;

export function planHostBuild(
  root: string,
  buildDir: string,
  platform: HarnessPlatform
): BuildPlan {
  const logDir = join(buildDir, "logs");
  const clientPath = join(
    root,
    "rust",
    "target",
    "debug",
    executableName("climon", platform)
  );
  const serverPath = join(buildDir, executableName("climon-server", platform));
  const fixturePath = join(root, "harness", "fixtures", "echo-session.mjs");

  // Strip telemetry key from every build command env
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  delete baseEnv.APPLICATIONINSIGHTS_CONNECTION_STRING;

  const timeoutMs = 600_000;

  const commands: CommandSpec[] = [
    {
      file: "cargo",
      args: ["build", "-p", "climon-cli"],
      cwd: join(root, "rust"),
      env: { ...baseEnv },
      timeoutMs,
      stdoutPath: join(logDir, "cargo-stdout.log"),
      stderrPath: join(logDir, "cargo-stderr.log"),
    },
    {
      file: "bun",
      args: ["scripts/embed-assets.ts"],
      cwd: root,
      env: { ...baseEnv },
      timeoutMs,
      stdoutPath: join(logDir, "embed-stdout.log"),
      stderrPath: join(logDir, "embed-stderr.log"),
    },
    {
      file: "bun",
      args: compiledServerBuildArgs(serverPath),
      cwd: root,
      env: { ...baseEnv },
      timeoutMs,
      stdoutPath: join(logDir, "server-build-stdout.log"),
      stderrPath: join(logDir, "server-build-stderr.log"),
    },
  ];

  return { clientPath, serverPath, fixturePath, commands };
}

export async function buildHostArtifacts(
  plan: BuildPlan,
  runner: CommandRunner,
  stat: StatFn = lstat
): Promise<BuildArtifacts> {
  for (const command of plan.commands) {
    await runner.run(command);
  }

  // Verify all three output paths are regular files
  for (const [label, filePath] of [
    ["clientPath", plan.clientPath],
    ["serverPath", plan.serverPath],
    ["fixturePath", plan.fixturePath],
  ] as const) {
    let s: { isFile(): boolean };
    try {
      s = await stat(filePath);
    } catch (err) {
      throw new HarnessError(
        "build",
        `stat failed for ${label} at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
    if (!s.isFile()) {
      throw new HarnessError(
        "build",
        `expected regular file at ${label}: ${filePath}`
      );
    }
  }

  return {
    clientPath: plan.clientPath,
    serverPath: plan.serverPath,
    fixturePath: plan.fixturePath,
  };
}
