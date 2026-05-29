#!/usr/bin/env bun
import { helpText, parseArgs } from "./cli/args.js";
import { runSessionDaemon } from "./daemon/daemon.js";
import {
  killSession,
  listSessionsCommand,
  reconnectSession,
  startMonitoredCommand
} from "./launcher.js";
import { startServer } from "./server/server.js";

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  switch (parsed.command) {
    case "help":
      process.stdout.write(helpText);
      return 0;
    case "server":
      await startServer({ lan: parsed.lan, port: parsed.port });
      return 0;
    case "session":
      await runSessionDaemon(parsed.id);
      return 0;
    case "attach":
      return reconnectSession(parsed.id);
    case "ls":
      return listSessionsCommand();
    case "kill":
      return killSession(parsed.id);
    case "run":
      return startMonitoredCommand(parsed.argv, { headless: parsed.headless });
    default:
      process.stderr.write(helpText);
      return 1;
  }
}

main()
  .then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  })
  .catch((error: unknown) => {
    process.stderr.write(`climon: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
