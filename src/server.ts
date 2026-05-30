#!/usr/bin/env bun
import { helpText, parseArgs } from "./cli/args.js";
import { startServer } from "./server/server.js";
import { runAcceptHandler } from "./remote/accept.js";

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "server") {
    await startServer({ port: parsed.port });
    return 0;
  }
  if (parsed.command === "ssh-accept") {
    await runAcceptHandler(parsed.label);
    return 0;
  }
  process.stderr.write("climon-server: expected the `server` command.\n");
  process.stderr.write(helpText);
  return 1;
}

main()
  .then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  })
  .catch((error: unknown) => {
    process.stderr.write(`climon-server: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
