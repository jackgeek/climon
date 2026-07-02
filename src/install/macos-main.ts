/**
 * ⚠️ LEGACY TypeScript client — frozen. Fix the Rust client instead.
 *
 * The shipping `climon` *client* is the Rust workspace under `rust/` (crates
 * `climon-cli`, `climon-session`, `climon-pty`, `climon-store`, `climon-config`,
 * `climon-remote`, `climon-install`, `climon-update`, …). This module belongs to
 * the legacy Bun/TypeScript client, kept only for local development and the Bun
 * test suite. Do NOT add features or fix client bugs here — make all client
 * changes in the Rust crates. (The Bun dashboard *server* under `src/server*`
 * and `src/web/` is NOT legacy and is still maintained.)
 */
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync } from "node:fs";
import { installBinaries, writeVersionFile } from "./files-unix.js";
import {
  detectShellProfile,
  ensureProfilePath,
  getDefaultInstallDir,
  killRunningClimonProcesses,
} from "./macos.js";
import {
  formatChangelog,
  getChangesSince,
  loadChangelog,
  readInstalledVersion,
} from "./changelog.js";
import { parseSetupOptions, runOnboarding } from "../setup/onboarding.js";

export type SetupCliRuntime = {
  main?: () => void | Promise<void>;
  writeError?: (message: string) => void;
  pauseForExit?: () => void | Promise<void>;
  exit?: (code: number) => void;
};

function installerSourceDir(): string {
  const execName = process.execPath.split("/").pop() ?? "";
  if (execName === "install-climon") {
    return dirname(process.execPath);
  }
  return dirname(fileURLToPath(import.meta.url));
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function confirmKillAndRetry(error: unknown): Promise<boolean> {
  console.error(`Failed to copy climon binaries: ${error instanceof Error ? error.message : String(error)}`);
  return askYesNo("climon appears to be running. Kill climon processes and try again? [y/N] ");
}

export async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("This installer can only install climon on macOS.");
  }

  const installDir = getDefaultInstallDir();
  const previousVersion = readInstalledVersion(installDir);

  const setupOptions = parseSetupOptions(process.argv.slice(2));
  await runOnboarding({ options: setupOptions });

  await installBinaries(installerSourceDir(), installDir, {
    confirmKillAndRetry,
    killRunningClimonProcesses,
  });

  // Ensure installed binaries are executable
  const binaries = ["climon", "climon-beta"];
  for (const name of binaries) {
    const binPath = join(installDir, name);
    if (existsSync(binPath)) {
      chmodSync(binPath, 0o755);
    }
  }

  const { VERSION } = await import("../version.js");
  writeVersionFile(installDir, VERSION);

  const profile = detectShellProfile();
  const changedProfile = ensureProfilePath(installDir, profile);

  console.log(`Installed climon ${VERSION} to ${installDir}`);
  if (changedProfile) {
    console.log(`Updated ${profile.profilePath} to add climon to your PATH.`);
    console.log("Open a new terminal or run the following to use climon now:");
    console.log(`  source ${profile.profilePath}`);
  } else {
    console.log("climon is already on your PATH.");
  }

  const changelog = loadChangelog();
  const newEntries = getChangesSince(changelog, previousVersion);
  const formatted = formatChangelog(newEntries);
  if (formatted) {
    console.log(formatted);
  }
}

export async function pauseForExit(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question("Press Enter to exit...");
  } finally {
    rl.close();
  }
}

export async function runSetupCli(runtime: SetupCliRuntime = {}): Promise<void> {
  const runMain = runtime.main ?? main;
  const writeError = runtime.writeError ?? ((message) => console.error(message));
  const waitBeforeExit = runtime.pauseForExit ?? pauseForExit;
  const exit = runtime.exit ?? ((code) => process.exit(code));
  let exitCode: number | undefined;

  try {
    await runMain();
  } catch (err) {
    writeError(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  }

  await waitBeforeExit();
  if (exitCode !== undefined) {
    exit(exitCode);
  }
}

if (import.meta.main) {
  await runSetupCli();
}
