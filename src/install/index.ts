import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { installBinaries, writeVersionFile } from "./files.js";
import { ensurePathEntryFirst } from "./path.js";
import { killRunningClimonProcesses } from "./processes.js";
import {
  broadcastEnvironmentChange,
  expandEnvironmentString,
  getLocalAppData,
  readUserPath,
  writeUserPath
} from "./windows.js";
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

export type UserPathIO = {
  readUserPath: () => string;
  writeUserPath: (value: string) => void;
  broadcastEnvironmentChange: () => void;
  expandEnvironmentString: (value: string) => string;
};

export function updateUserPathWithIO(installDir: string, io: UserPathIO): boolean {
  const currentPath = io.readUserPath();
  const nextPath = ensurePathEntryFirst(currentPath, installDir, io.expandEnvironmentString);

  if (nextPath === currentPath) {
    return false;
  }

  io.writeUserPath(nextPath);
  io.broadcastEnvironmentChange();
  return true;
}

export function updateUserPath(installDir: string): boolean {
  return updateUserPathWithIO(installDir, {
    readUserPath,
    writeUserPath,
    broadcastEnvironmentChange,
    expandEnvironmentString
  });
}

function installerSourceDir(): string {
  // When loaded in-process by climon.exe, the files are next to the executable.
  return dirname(process.execPath);
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
  return askYesNo("The file may be locked by climon or another program (antivirus, Explorer). Kill climon processes and retry? [y/N] ");
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

export async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Setup.exe can only install climon on Windows.");
  }

  const installDir = join(getLocalAppData(), "Programs", "climon");
  const previousVersion = readInstalledVersion(installDir);

  const setupOptions = parseSetupOptions(process.argv.slice(2));
  const onboarding = await runOnboarding({ options: setupOptions });
  if (!onboarding.accepted) {
    console.error("Licence not accepted; aborting installation.");
    await pauseForExit();
    process.exit(1);
  }

  await installBinaries(installerSourceDir(), installDir, {
    confirmKillAndRetry,
    killRunningClimonProcesses
  });

  const { VERSION } = await import("../version.js");
  writeVersionFile(installDir, VERSION);

  const changedPath = updateUserPath(installDir);

  console.log(`Installed climon ${VERSION} to ${installDir}`);
  console.log(changedPath
    ? "Updated your user PATH so climon resolves to this install first. Open a new terminal to use it."
    : "climon is already first on your user PATH.");

  const changelog = loadChangelog();
  const newEntries = getChangesSince(changelog, previousVersion);
  const formatted = formatChangelog(newEntries);
  if (formatted) {
    console.log(formatted);
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
