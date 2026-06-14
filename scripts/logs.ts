#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { getLogsDir } from "../src/config.js";

/** Returns true if a native `lnav` executable is resolvable on PATH. */
function hasNativeLnav(): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, ["lnav"], { stdio: "ignore" });
  return result.status === 0;
}

/** Returns true if `lnav` is resolvable inside WSL. */
function hasWslLnav(): boolean {
  const result = spawnSync("wsl", ["-e", "bash", "-lc", "command -v lnav"], { stdio: "ignore" });
  return result.status === 0;
}

/** Translates a Windows path to its WSL (/mnt/...) equivalent via `wslpath`. */
function toWslPath(winPath: string): string | undefined {
  const result = spawnSync("wsl", ["-e", "wslpath", "-a", winPath], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const out = result.stdout.trim();
  return out.length > 0 ? out : undefined;
}

/** Spawns native lnav on the given directory, forwarding extra args. */
function runNativeLnav(logsDir: string, extraArgs: string[]): number {
  process.stdout.write(`Launching lnav on ${logsDir}\n`);
  // `-r` recursively loads the per-role subdirectories (client/server/daemon/...).
  const result = spawnSync("lnav", ["-r", logsDir, ...extraArgs], { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`Failed to launch lnav: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 0;
}

/** Spawns lnav inside WSL on the WSL-translated logs directory. */
function runWslLnav(logsDir: string, extraArgs: string[]): number {
  const wslDir = toWslPath(logsDir);
  if (!wslDir) {
    process.stderr.write(`Failed to translate ${logsDir} to a WSL path via wslpath.\n`);
    return 1;
  }
  process.stdout.write(`Launching lnav (WSL) on ${wslDir}\n`);
  const result = spawnSync("wsl", ["-e", "lnav", "-r", wslDir, ...extraArgs], { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`Failed to launch lnav in WSL: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 0;
}

function printInstallGuidance(triedWsl: boolean): void {
  process.stderr.write(`lnav was not found on PATH.\n`);
  if (process.platform === "win32") {
    process.stderr.write(
      `lnav has no native Windows build. Install it inside WSL ` +
        `(\`sudo apt-get install lnav\`) and re-run \`bun run logs\`.\n`,
    );
    if (triedWsl) {
      process.stderr.write(`(WSL was detected but does not have lnav installed.)\n`);
    }
  } else {
    process.stderr.write(
      `Install it from https://lnav.org/ (e.g. \`brew install lnav\`, \`apt install lnav\`, \`dnf install lnav\`).\n`,
    );
  }
}

/**
 * `bun run logs`: open lnav on the CLIMON_HOME/logs directory so all of
 * climon's structured (pino NDJSON) log files can be tailed and searched in
 * one place. Any extra args are forwarded to lnav, e.g.
 * `bun run logs -- -c ':filter-in error'`.
 *
 * lnav has no native Windows build, so on Windows we transparently fall back to
 * running lnav inside WSL (translating the logs path with `wslpath`).
 */
function main(): number {
  const logsDir = getLogsDir(process.env);
  // Ensure the directory exists so lnav doesn't error before any logs are written.
  mkdirSync(logsDir, { recursive: true });

  const extraArgs = process.argv.slice(2);

  if (hasNativeLnav()) {
    return runNativeLnav(logsDir, extraArgs);
  }

  if (process.platform === "win32" && hasWslLnav()) {
    return runWslLnav(logsDir, extraArgs);
  }

  printInstallGuidance(process.platform === "win32");
  return 127;
}

process.exitCode = main();
