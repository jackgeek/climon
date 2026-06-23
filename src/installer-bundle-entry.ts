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
