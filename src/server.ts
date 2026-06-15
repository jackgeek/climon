#!/usr/bin/env bun
import { helpText, parseArgs } from "./cli/args.js";
import { resolveConfigSetting } from "./config.js";
import { ensureInstallId } from "./install-id.js";
import { createAppInsightsStream } from "./logging/appinsights.js";
import { getLogger, initLogger } from "./logging/logger.js";
import { writeStderr } from "./logging/cli-io.js";
import { runIngestDaemon } from "./remote/ingest.js";
import { startServer } from "./server/server.js";

async function initServerLogging(): Promise<void> {
  const conn =
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ??
    (resolveConfigSetting("logging.appInsights.connectionString") as string | undefined);
  // Resolve the anonymous installation id on startup so it is attached to every
  // forwarded record. Never let id resolution block server startup.
  let installId: string | undefined;
  try {
    installId = await ensureInstallId();
  } catch {
    installId = undefined;
  }
  // A misconfigured App Insights connection string must never prevent the
  // dashboard server from starting: logging is a debugging aid, not a core
  // dependency. Degrade to file/terminal logging if the AI stream fails.
  let ai;
  let aiError: unknown;
  try {
    ai = await createAppInsightsStream(conn);
  } catch (error) {
    aiError = error;
  }
  initLogger("server", { installId, extraStreams: ai ? [ai] : [] });
  if (aiError) {
    getLogger().warn(
      `App Insights logging disabled: ${aiError instanceof Error ? aiError.message : String(aiError)}`,
    );
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "server") {
    await initServerLogging();
    await startServer({ port: parsed.port, enableRemotes: parsed.enableRemotes, noTakeover: parsed.noTakeover });
    return 0;
  }
  if (parsed.command === "ingest") {
    await runIngestDaemon();
    return 0;
  }
  writeStderr("climon-server: expected the `server` command.\n");
  writeStderr(helpText);
  return 1;
}

main()
  .then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  })
  .catch((error: unknown) => {
    writeStderr(`climon-server: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
