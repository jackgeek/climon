import type { HarnessPlatform } from "./types.js";
import { HarnessError } from "./types.js";

export function platformFromNode(nodePlatform: string): HarnessPlatform {
  switch (nodePlatform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      throw new HarnessError(
        "catalogue",
        `unsupported platform: ${nodePlatform}`
      );
  }
}

export function executableName(base: string, platform: HarnessPlatform): string {
  if (platform === "windows") {
    return base.endsWith(".exe") ? base : `${base}.exe`;
  }
  return base;
}

export type WindowsTermination = { file: "taskkill"; args: string[] };
export type UnixTermination = { signal: "SIGTERM" | "SIGKILL"; pid: number };
export type ProcessTermination = WindowsTermination | UnixTermination;

export function processTreeTermination(
  platform: HarnessPlatform,
  pid: number,
  force: boolean
): ProcessTermination {
  if (platform === "windows") {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    return { file: "taskkill", args };
  }
  return { signal: force ? "SIGKILL" : "SIGTERM", pid: -pid };
}
