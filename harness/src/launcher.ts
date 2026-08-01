import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";

const DEFAULT_NODE_BINARY = "node";
const TOOLING_RELATIVE_PATH = [
  ".test-tmp",
  "e2e-harness",
  "tooling",
  "harness-node.mjs",
] as const;

type BunBuildLike = typeof Bun.build;

interface BuildResultLike {
  success: boolean;
  logs: unknown[];
  outputs?: Array<{
    kind?: string;
    text(): Promise<string> | string;
  }>;
}

interface LauncherChildProcess {
  on(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void)
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

interface LauncherProcessLike {
  env: NodeJS.ProcessEnv;
  on(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): void;
  off(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): void;
  stderr: { write(chunk: string): void };
}

export function harnessNodeBundlePath(root: string): string {
  return join(root, ...TOOLING_RELATIVE_PATH);
}

export async function buildHarnessNodeBundle(
  root: string,
  dependencies: {
    build?: BunBuildLike;
    writeFile?: typeof writeFile;
  } = {}
): Promise<string> {
  const outfile = harnessNodeBundlePath(root);
  await mkdir(dirname(outfile), { recursive: true });
  const build = dependencies.build ?? Bun.build;
  const result = (await build({
    entrypoints: [join(root, "harness", "src", "main.ts")],
    target: "node",
    format: "esm",
    packages: "external",
  })) as unknown as BuildResultLike;

  if (!result.success) {
    throw new AggregateError(result.logs, "Failed to build the Node harness bundle");
  }

  const entrypoint = result.outputs?.find((output) => output.kind === "entry-point");
  if (entrypoint === undefined) {
    throw new Error("Node harness build produced no entry-point output");
  }

  await (dependencies.writeFile ?? writeFile)(outfile, await entrypoint.text(), "utf8");
  return outfile;
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return 128 + (osConstants.signals[signal] ?? 0);
}

export async function runHarnessLauncher(
  args = process.argv.slice(2),
  options: {
    root?: string;
    buildNodeBundle?: (root: string) => Promise<string>;
    spawnChild?: (
      file: string,
      args: string[],
      options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        shell: false;
        stdio: "inherit";
      }
    ) => LauncherChildProcess;
    processApi?: LauncherProcessLike;
    nodeBinary?: string;
  } = {}
): Promise<number> {
  const root = options.root ?? resolve(import.meta.dir, "..", "..");
  const processApi = options.processApi ?? process;
  const bundlePath = await (options.buildNodeBundle ?? buildHarnessNodeBundle)(root);
  const child = (options.spawnChild ??
    ((file, childArgs, spawnOptions) => spawn(file, childArgs, spawnOptions)))(
    options.nodeBinary ?? DEFAULT_NODE_BINARY,
    [bundlePath, ...args],
    {
      cwd: root,
      env: { ...processApi.env, CLIMON_HARNESS_ROOT: root },
      shell: false,
      stdio: "inherit",
    }
  );

  return new Promise<number>((resolveRun) => {
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    processApi.on("SIGINT", forward);
    processApi.on("SIGTERM", forward);

    const cleanup = () => {
      processApi.off("SIGINT", forward);
      processApi.off("SIGTERM", forward);
    };

    child.on("exit", ((code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolveRun(signal ? exitCodeForSignal(signal) : code ?? 0);
    }) as (code: number | null, signal: NodeJS.Signals | null) => void);
    child.on("error", ((error: Error) => {
      cleanup();
      processApi.stderr.write(`[harness] failed to run Node: ${error.message}\n`);
      resolveRun(127);
    }) as (error: Error) => void);
  });
}

if (import.meta.main) {
  process.exit(await runHarnessLauncher());
}
