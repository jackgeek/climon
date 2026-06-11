import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Files in the source (zip) directory and their installed names. */
const INSTALL_FILES: { source: string; dest: string }[] = [
  { source: "install", dest: "climon" },
  { source: "climon-beta", dest: "climon-beta" },
];
const LOCKED_COPY_ERROR_CODES = new Set(["EBUSY", "EACCES", "EPERM", "ETXTBSY"]);

export type CopyFile = (source: string, destination: string) => void;

export type InstallBinariesOptions = {
  copyFile?: CopyFile;
  confirmKillAndRetry?: (error: unknown) => boolean | Promise<boolean>;
  killRunningClimonProcesses?: () => void | Promise<void>;
};

export function isLockedBinaryCopyError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && LOCKED_COPY_ERROR_CODES.has(error.code);
}

function copyRequiredBinaries(sourceDir: string, installDir: string, copyFile: CopyFile): void {
  mkdirSync(installDir, { recursive: true });

  for (const { source, dest } of INSTALL_FILES) {
    const sourcePath = join(sourceDir, source);
    if (!existsSync(sourcePath)) {
      throw new Error(`Required installer sibling is missing: ${source}`);
    }
    copyFile(sourcePath, join(installDir, dest));
  }
}

export async function installBinaries(
  sourceDir: string,
  installDir: string,
  options: InstallBinariesOptions = {}
): Promise<void> {
  const copyFile = options.copyFile ?? copyFileSync;

  try {
    copyRequiredBinaries(sourceDir, installDir, copyFile);
  } catch (error) {
    if (!isLockedBinaryCopyError(error) || !options.confirmKillAndRetry || !options.killRunningClimonProcesses) {
      throw error;
    }

    if (!(await options.confirmKillAndRetry(error))) {
      throw error;
    }

    await options.killRunningClimonProcesses();
    copyRequiredBinaries(sourceDir, installDir, copyFile);
  }
}

/**
 * Writes the currently-installed version to a `.version` file in the install
 * directory so the next upgrade can detect what was previously installed.
 */
export function writeVersionFile(installDir: string, version: string): void {
  writeFileSync(join(installDir, ".version"), version, "utf8");
}
