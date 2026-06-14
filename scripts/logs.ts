#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { getLogsDir } from "../src/config.js";

/** Returns true if an `lnav` executable is resolvable on PATH. */
function hasLnav(): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, ["lnav"], { stdio: "ignore" });
  return result.status === 0;
}

/**
 * `bun run logs`: open lnav on the CLIMON_HOME/logs directory so all of
 * climon's structured (pino NDJSON) log files can be tailed and searched in
 * one place. Any extra args are forwarded to lnav, e.g.
 * `bun run logs -- -c ':filter-in error'`.
 */
function main(): number {
  const logsDir = getLogsDir(process.env);
  // Ensure the directory exists so lnav doesn't error before any logs are written.
  mkdirSync(logsDir, { recursive: true });

  if (!hasLnav()) {
    process.stderr.write(
      `lnav was not found on PATH.\n` +
        `Install it from https://lnav.org/ (e.g. \`brew install lnav\`, \`apt install lnav\`, \`dnf install lnav\`).\n`,
    );
    return 127;
  }

  const extraArgs = process.argv.slice(2);
  process.stdout.write(`Launching lnav on ${logsDir}\n`);
  // `-r` recursively loads the per-role subdirectories (client/server/daemon/...).
  const result = spawnSync("lnav", ["-r", logsDir, ...extraArgs], { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`Failed to launch lnav: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 0;
}

process.exitCode = main();
