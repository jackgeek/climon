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
import { spawnSync } from "node:child_process";
import { powershellArgsForScript } from "./windows.js";

export const killRunningClimonProcessesScript = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$processes = Get-Process -Name 'climon','climon-server' -ErrorAction SilentlyContinue",
  "if ($null -ne $processes) { $processes | Stop-Process -Force -ErrorAction Stop }"
].join("; ");

/**
 * Strip PowerShell CLIXML progress/verbose noise from stderr output.
 * PowerShell emits XML-encoded progress records (e.g. "Preparing modules for
 * first use") to stderr even on success; these are not actionable errors.
 */
function cleanPowerShellStderr(stderr: string): string {
  return stderr
    .replace(/#< CLIXML\r?\n<Objs[\s\S]*?<\/Objs>/g, "")
    .trim();
}

export function killRunningClimonProcesses(): void {
  const result = spawnSync("powershell.exe", powershellArgsForScript(killRunningClimonProcessesScript), {
    encoding: "utf8",
    windowsHide: true
  });

  if (result.status !== 0) {
    const stderr = cleanPowerShellStderr(result.stderr ?? "");
    const message = stderr
      || result.stdout.trim()
      || result.error?.message
      || "powershell.exe failed";
    throw new Error(`Failed to stop running climon processes: ${message}`);
  }
}
