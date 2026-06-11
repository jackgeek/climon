/**
 * Bundle entry point for the installer JS bundle loaded in-process by climon.
 * Detects the current platform at runtime and delegates to the appropriate
 * platform-specific installer.
 */

import type { SetupCliRuntime } from "./install/linux-main.js";

async function loadPlatformInstaller() {
  switch (process.platform) {
    case "win32":
      return await import("./install/index.js");
    case "linux":
      return await import("./install/linux-main.js");
    case "darwin":
      return await import("./install/macos-main.js");
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

export async function main(): Promise<void> {
  const installer = await loadPlatformInstaller();
  await installer.main();
}

export async function runSetupCli(runtime: SetupCliRuntime = {}): Promise<void> {
  const installer = await loadPlatformInstaller();
  await installer.runSetupCli(runtime);
}

export async function pauseForExit(): Promise<void> {
  const installer = await loadPlatformInstaller();
  await installer.pauseForExit();
}
