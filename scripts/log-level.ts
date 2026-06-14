#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLogLevel, LOG_LEVELS } from "../src/logging/level.js";

const VAR = "CLIMON_LOG_LEVEL";
const RC_BEGIN = "# >>> climon log level >>>";
const RC_END = "# <<< climon log level <<<";

/** Prints usage and the list of valid levels. */
function printUsage(): void {
  process.stdout.write(
    `Usage: bun run log-level <level|--unset|--show>\n\n` +
      `Sets the ${VAR} environment variable persistently for your user.\n` +
      `Valid levels (most to least verbose): ${LOG_LEVELS.join(", ")}.\n\n` +
      `  bun run log-level debug     set the level to debug\n` +
      `  bun run log-level silent    turn logging off\n` +
      `  bun run log-level --unset   remove the persistent override\n` +
      `  bun run log-level --show    print the current value\n`,
  );
}

/** Prints how to apply the value in the *current* shell (child can't mutate parent). */
function printApplyNow(level: string | undefined): void {
  if (process.platform === "win32") {
    process.stdout.write(
      `\nThe change applies to new terminals. To apply it in this PowerShell session now:\n` +
        (level === undefined
          ? `  Remove-Item Env:${VAR}\n`
          : `  $env:${VAR}='${level}'\n`) +
        `(cmd.exe: ${level === undefined ? `set ${VAR}=` : `set ${VAR}=${level}`})\n`,
    );
  } else {
    process.stdout.write(
      `\nThe change applies to new shells. To apply it in this shell now:\n` +
        (level === undefined ? `  unset ${VAR}\n` : `  export ${VAR}=${level}\n`),
    );
  }
}

/** Windows: persist (or remove) the user environment variable. */
function setWindows(level: string | undefined): number {
  if (level === undefined) {
    // setx cannot delete; use reg to remove the user Environment value.
    const del = spawnSync("reg", ["delete", "HKCU\\Environment", "/F", "/V", VAR], {
      stdio: "ignore",
    });
    // reg delete returns 1 when the value doesn't exist — treat that as success.
    process.stdout.write(`Removed persistent ${VAR}.\n`);
    void del;
    return 0;
  }
  const res = spawnSync("setx", [VAR, level], { encoding: "utf8" });
  if (res.status !== 0) {
    process.stderr.write(`Failed to set ${VAR} via setx: ${res.stderr || res.stdout}\n`);
    return res.status ?? 1;
  }
  process.stdout.write(`Set persistent ${VAR}=${level} for your user.\n`);
  return 0;
}

/** Chooses the shell rc file to manage on Unix/WSL. */
function rcFilePath(): string {
  const home = homedir();
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) {
    const zshrc = join(home, ".zshrc");
    if (existsSync(zshrc)) return zshrc;
  }
  const bashrc = join(home, ".bashrc");
  if (existsSync(bashrc)) return bashrc;
  return join(home, ".profile");
}

/** Removes any existing climon-managed block from the rc contents. */
function stripManagedBlock(contents: string): string {
  const begin = contents.indexOf(RC_BEGIN);
  if (begin === -1) return contents;
  const end = contents.indexOf(RC_END, begin);
  if (end === -1) return contents;
  const before = contents.slice(0, begin).replace(/\n+$/, "\n");
  const after = contents.slice(end + RC_END.length).replace(/^\n+/, "");
  return `${before}${after}`;
}

/** Unix/WSL: persist (or remove) the export line in the user's shell rc file. */
function setUnix(level: string | undefined): number {
  const rc = rcFilePath();
  const existing = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  let next = stripManagedBlock(existing);
  if (level !== undefined) {
    if (next.length > 0 && !next.endsWith("\n")) next += "\n";
    next += `${RC_BEGIN}\nexport ${VAR}="${level}"\n${RC_END}\n`;
  }
  writeFileSync(rc, next);
  process.stdout.write(
    level === undefined
      ? `Removed persistent ${VAR} from ${rc}.\n`
      : `Set persistent ${VAR}=${level} in ${rc}.\n`,
  );
  return 0;
}

/**
 * `bun run log-level`: persistently set (or unset) the CLIMON_LOG_LEVEL
 * environment variable for the current user. Works on Windows (setx / HKCU
 * Environment) and on Unix/WSL (managed block in the shell rc file). A child
 * process cannot mutate its parent shell, so we persist the value and print the
 * command to apply it in the current session.
 */
function main(): number {
  const arg = process.argv[2];

  if (arg === undefined || arg === "--help" || arg === "-h") {
    printUsage();
    return arg === undefined ? 1 : 0;
  }

  if (arg === "--show") {
    const current = process.env[VAR];
    process.stdout.write(`${VAR}=${current ?? "(unset)"}\n`);
    return 0;
  }

  const unset = arg === "--unset" || arg === "off" || arg === "none";
  if (!unset && !isLogLevel(arg)) {
    process.stderr.write(`Invalid level "${arg}". Valid levels: ${LOG_LEVELS.join(", ")}.\n`);
    return 2;
  }

  const level = unset ? undefined : arg;
  const status = process.platform === "win32" ? setWindows(level) : setUnix(level);
  if (status === 0) printApplyNow(level);
  return status;
}

process.exitCode = main();
