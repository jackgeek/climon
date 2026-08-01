import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareNodePty } from "./node-pty-preflight.js";

export function resolveHarnessRoot(
  moduleUrl: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.CLIMON_HARNESS_ROOT
    ? resolve(env.CLIMON_HARNESS_ROOT)
    : resolve(dirname(fileURLToPath(moduleUrl)), "..", "..");
}

export function isHarnessEntrypoint(
  moduleUrl: string,
  argvEntry = process.argv[1]
): boolean {
  if (argvEntry === undefined) {
    return false;
  }

  return fileURLToPath(moduleUrl) === resolve(argvEntry);
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const root = resolveHarnessRoot(import.meta.url);
  await prepareNodePty(root);
  const { runCli } = await import("./cli.js");
  return runCli(args, { root });
}

if (isHarnessEntrypoint(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  });
  process.exit(exitCode);
}
