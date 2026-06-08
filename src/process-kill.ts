import { spawnSync } from "node:child_process";

export type KillRunner = (cmd: string, args: string[]) => { status: number | null };

const defaultRunner: KillRunner = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: "ignore", windowsHide: true });
  return { status: result.error ? 1 : result.status };
};

/**
 * Terminates a process cross-platform, best-effort. On Windows uses `taskkill`
 * with `/T` (whole process tree) and `/F` when forcing. On POSIX sends SIGKILL
 * (force) or SIGTERM (graceful). Returns whether the kill was issued
 * successfully; a process that is already gone reports false on POSIX (ESRCH)
 * and the caller should re-check liveness if it cares.
 *
 * Set `tree: false` on Windows to kill only the specific process without its
 * descendants (e.g. when the caller is itself a child of the target).
 */
export function killProcess(
  pid: number,
  force: boolean,
  platform: NodeJS.Platform = process.platform,
  run: KillRunner = defaultRunner,
  tree: boolean = true
): boolean {
  if (platform === "win32") {
    const args = ["/PID", String(pid)];
    if (tree) args.push("/T");
    if (force) args.push("/F");
    return run("taskkill", args).status === 0;
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** Returns whether a process with the given pid currently exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
