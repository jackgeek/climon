#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { helpText, parseArgs } from "./cli/args.js";
import { runConfigCommand } from "./cli/config-cmd.js";
import { delegateToServer } from "./cli/server-exec.js";
import { runUplink } from "./remote/uplink.js";
import { runSessionDaemon } from "./daemon/daemon.js";
import {
  killAllSessions,
  killSession,
  listSessionsCommand,
  reconnectSession,
  startMonitoredCommand
} from "./launcher.js";
import { VERSION } from "./version.js";

function resolveDevServerEntrypoint(): string | undefined {
  if (!import.meta.url.startsWith("file:")) {
    return undefined;
  }
  try {
    const candidate = fileURLToPath(new URL("./server.ts", import.meta.url));
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  switch (parsed.command) {
    case "help":
      process.stdout.write(helpText);
      return 0;
    case "version":
      process.stdout.write(`climon v${VERSION}\n`);
      return 0;
    case "server":
      return delegateToServer(
        process.argv.slice(2),
        process.env,
        process.execPath,
        resolveDevServerEntrypoint()
      );
    case "session":
      await runSessionDaemon(parsed.id);
      return 0;
    case "attach":
      return reconnectSession(parsed.id);
    case "ls":
      return listSessionsCommand();
    case "kill":
      return killSession(parsed.id);
    case "kill-all":
      return killAllSessions();
    case "run":
      return startMonitoredCommand(parsed.argv, {
        headless: parsed.headless,
        name: parsed.name,
        priority: parsed.priority,
        color: parsed.color
      });
    case "config":
      return runConfigCommand(parsed.argv);
    case "uplink":
      return await runUplink();
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
