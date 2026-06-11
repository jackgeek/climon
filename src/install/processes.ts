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
