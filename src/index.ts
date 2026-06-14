#!/usr/bin/env bun
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { helpText, parseArgs } from "./cli/args.js";
import { runCleanupCommand } from "./cli/cleanup-cmd.js";
import { runConfigCommand } from "./cli/config-cmd.js";
import { runLinkCommand } from "./cli/link-cmd.js";
import { delegateToServer } from "./cli/server-exec.js";
import { detectParentShell, buildShellArgv } from "./detect-shell.js";
import { runUplink } from "./remote/uplink.js";
import { readSessionMeta } from "./store.js";
import { runSessionHost } from "./session-host.js";
import {
  killAllSessions,
  killSession,
  listSessionsCommand,
  startMonitoredCommand
} from "./launcher.js";
import { VERSION } from "./version.js";
import { initLogger } from "./logging/logger.js";
import { writeStdout, writeStderr, logCliCommand } from "./logging/cli-io.js";

const INSTALLER_BUNDLE_NAME = "climon-alpha";

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

/**
 * Checks if an installer bundle exists next to the executable.
 * If so, imports and runs it (self-install mode).
 */
async function tryRunInstaller(): Promise<number | undefined> {
  const installerPath = join(dirname(process.execPath), INSTALLER_BUNDLE_NAME);
  if (!existsSync(installerPath)) return undefined;

  const mod = await import(installerPath);
  if (typeof mod.runSetupCli === "function") {
    await mod.runSetupCli();
    return 0;
  }
  if (typeof mod.main === "function") {
    await mod.main();
    return 0;
  }
  process.stderr.write("climon: installer bundle does not export runSetupCli() or main()\n");
  return 1;
}
async function main(): Promise<number> {
  // If an installer bundle is present next to the executable, run it.
  const installerResult = await tryRunInstaller();
  if (installerResult !== undefined) return installerResult;

  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command !== "uplink") {
    initLogger("client");
    logCliCommand(parsed.command);
  }

  switch (parsed.command) {
    case "help":
      writeStdout(helpText);
      return 0;
    case "version":
      writeStdout(`climon v${VERSION}\n`);
      return 0;
    case "server":
      return await delegateToServer(
        process.argv.slice(2),
        process.env,
        process.execPath,
        resolveDevServerEntrypoint()
      );
    case "shell": {
      const shell = detectParentShell();
      const argv = buildShellArgv(shell);
      const shellName = parsed.name ?? basename(shell).replace(/\.exe$/i, "");
      return startMonitoredCommand(argv, {
        headless: false,
        name: shellName,
        priority: parsed.priority,
        color: parsed.color
      });
    }
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
    case "cleanup":
      return await runCleanupCommand();
    case "link":
      return runLinkCommand(parsed.argv);
    case "uplink":
      return await runUplink();
    case "session": {
      const meta = await readSessionMeta(parsed.id);
      if (!meta) {
        throw new Error(`No session found with id '${parsed.id}'.`);
      }
      return await runSessionHost(parsed.id, meta, { headless: true });
    }
    default:
      writeStderr(helpText);
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
    writeStderr(`climon: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
