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
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installFilesForPlatform } from "./install-manifest.js";

/** Files in the source (zip) directory and their installed names. */
const INSTALL_FILES = installFilesForPlatform("win32");
const LOCKED_COPY_ERROR_CODES = new Set(["EBUSY", "EACCES", "EPERM"]);

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

/**
 * Try to move an existing destination file out of the way before overwriting.
 * On Windows, antivirus or indexer can hold a handle that prevents overwrite
 * but still allows rename within the same directory.
 */
function displaceExisting(destPath: string): void {
  if (!existsSync(destPath)) return;
  const displaced = `${destPath}.old`;
  try {
    renameSync(destPath, displaced);
  } catch {
    // If rename also fails, fall through and let the copy report the error.
    return;
  }
  // Best-effort cleanup of the displaced file.
  try { unlinkSync(displaced); } catch { /* will be cleaned up next install */ }
}

function copyRequiredBinaries(sourceDir: string, installDir: string, copyFile: CopyFile): void {
  mkdirSync(installDir, { recursive: true });

  for (const { source, dest } of INSTALL_FILES) {
    const sourcePath = join(sourceDir, source);
    if (!existsSync(sourcePath)) {
      throw new Error(`Required installer sibling is missing: ${source}`);
    }
    const destPath = join(installDir, dest);
    displaceExisting(destPath);
    copyFile(sourcePath, destPath);
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
