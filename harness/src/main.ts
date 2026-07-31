import { resolve } from "node:path";
import { prepareNodePty } from "./node-pty-preflight.js";

async function main(): Promise<number> {
  const root = resolve(import.meta.dir, "..", "..");
  await prepareNodePty(root);
  const { runCli } = await import("./cli.js");
  return runCli(process.argv.slice(2), { root });
}

if (import.meta.main) {
  const exitCode = await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  });
  process.exit(exitCode);
}
