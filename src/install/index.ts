import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installBinaries } from "./files.js";
import { appendPathEntryIfMissing } from "./path.js";
import {
  broadcastEnvironmentChange,
  expandEnvironmentString,
  getLocalAppData,
  readUserPath,
  writeUserPath
} from "./windows.js";

export function updateUserPath(installDir: string): boolean {
  const currentPath = readUserPath();
  const nextPath = appendPathEntryIfMissing(currentPath, installDir, expandEnvironmentString);

  if (nextPath === currentPath) {
    return false;
  }

  writeUserPath(nextPath);
  broadcastEnvironmentChange();
  return true;
}

function installerSourceDir(): string {
  if (process.execPath.toLowerCase().endsWith("setup.exe")) {
    return dirname(process.execPath);
  }
  return dirname(fileURLToPath(import.meta.url));
}

export function main(): void {
  if (process.platform !== "win32") {
    throw new Error("Setup.exe can only install climon on Windows.");
  }

  const installDir = join(getLocalAppData(), "Programs", "climon");
  installBinaries(installerSourceDir(), installDir);
  const changedPath = updateUserPath(installDir);

  console.log(`Installed climon to ${installDir}`);
  console.log(changedPath
    ? "Added climon to your user PATH. Open a new terminal to use it."
    : "climon is already on your user PATH.");
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
