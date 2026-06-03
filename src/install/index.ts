import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { installBinaries } from "./files.js";
import { ensurePathEntryFirst } from "./path.js";
import { killRunningClimonProcesses } from "./processes.js";
import {
  broadcastEnvironmentChange,
  expandEnvironmentString,
  getLocalAppData,
  readUserPath,
  writeUserPath
} from "./windows.js";

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
  if (process.execPath.toLowerCase().endsWith("setup.exe")) {
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
  return askYesNo("climon appears to be running. Kill climon.exe and climon-server.exe and try again? [y/N] ");
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
  await installBinaries(installerSourceDir(), installDir, {
    confirmKillAndRetry,
    killRunningClimonProcesses
  });
  const changedPath = updateUserPath(installDir);

  console.log(`Installed climon to ${installDir}`);
  console.log(changedPath
    ? "Updated your user PATH so climon resolves to this install first. Open a new terminal to use it."
    : "climon is already first on your user PATH.");
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
