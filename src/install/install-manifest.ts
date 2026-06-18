/** One file to copy from the extracted artifact into the install directory. */
export type InstallFile = { source: string; dest: string };

/**
 * Returns the ordered list of files to install for a platform. This is the
 * single source of truth shared by the Windows installer, the Unix installer,
 * and the non-destructive updater swap. Add future locale resource files here
 * and they are installed and swapped automatically.
 */
export function installFilesForPlatform(
  platform: NodeJS.Platform = process.platform
): InstallFile[] {
  const isWindows = platform === "win32";
  const exe = isWindows ? ".exe" : "";
  return [
    { source: `install${exe}`, dest: `climon${exe}` },
    { source: `climon-server${exe}`, dest: `climon-server${exe}` },
    { source: "climon-beta", dest: "climon-beta" },
  ];
}
