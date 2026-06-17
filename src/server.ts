#!/usr/bin/env bun
import { helpText, parseArgs } from "./cli/args.js";
import { readGlobalConfigSetting } from "./config.js";
import { createAppInsightsStream } from "./logging/appinsights.js";
import { getLogger, initLogger } from "./logging/logger.js";
import { logMsg } from "./i18n/log-msg.js";
import { writeStderr } from "./logging/cli-io.js";
import { runIngestDaemon } from "./remote/ingest.js";
import { startServer } from "./server/server.js";
import { ensureInstallId } from "./setup/install-id.js";
import { resolveTelemetryConnection } from "./telemetry/connection.js";

async function initServerLogging(): Promise<void> {
  const conn = resolveTelemetryConnection(process.env);
  if (!conn) {
    // Telemetry disabled or unconfigured: start logging with no AI stream.
    initLogger("server", { extraStreams: [] });
    return;
  }
  const installId =
    (readGlobalConfigSetting("install.id", process.env) as string | undefined) ??
    ensureInstallId(process.env);
  // A misconfigured App Insights connection string must never prevent the
  // dashboard server from starting: logging is a debugging aid, not a core
  // dependency. Degrade to file/terminal logging if the AI stream fails.
  let ai;
  let aiError: unknown;
  try {
    ai = await createAppInsightsStream(conn, { installId });
  } catch (error) {
    aiError = error;
  }
  initLogger("server", { installId, extraStreams: ai ? [ai] : [] });
  if (aiError) {
    logMsg(getLogger(), "warn", "boot.app_insights_logging_disabled", { err: aiError instanceof Error ? aiError.message : String(aiError) });
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
