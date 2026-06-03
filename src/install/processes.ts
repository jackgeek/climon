import { spawnSync } from "node:child_process";
import { powershellArgsForScript } from "./windows.js";

export const killRunningClimonProcessesScript = [
  "$processes = Get-Process -Name 'climon','climon-server' -ErrorAction SilentlyContinue",
  "if ($null -ne $processes) { $processes | Stop-Process -Force -ErrorAction Stop }"
].join("; ");

export function killRunningClimonProcesses(): void {
  const result = spawnSync("powershell.exe", powershellArgsForScript(killRunningClimonProcessesScript), {
    encoding: "utf8",
    windowsHide: true
  });

  if (result.status !== 0) {
    const message = result.stderr.trim()
      || result.stdout.trim()
      || result.error?.message
      || "powershell.exe failed";
    throw new Error(`Failed to stop running climon processes: ${message}`);
  }
}
