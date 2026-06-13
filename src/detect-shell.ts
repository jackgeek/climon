import { spawnSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { child } from "./logging/logger.js";

function debug(message: string): void {
  child("shell-detect").debug(message);
}

/**
 * Executables that are never a useful shell to re-launch. If the parent process
 * matches one of these, fall back to environment-based detection instead.
 */
const BLOCKED_PARENTS = new Set([
  "explorer.exe",
  "finder",
  "code",
  "cursor",
  "node",
  "bun",
  "deno",
  "sshd",
  "login",
  "init",
  "systemd",
  "launchd",
  "conhost.exe",
  "windowsterminal.exe",
  "wt.exe",
  "copilot",
]);

function isBlocked(exe: string): boolean {
  const base = exe.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const name = base.replace(/\.exe$/, "");
  const blocked = BLOCKED_PARENTS.has(base) || BLOCKED_PARENTS.has(name);
  debug(`  isBlocked("${exe}") → base="${base}" name="${name}" → ${blocked}`);
  return blocked;
}

interface ProcessInfo {
  exe: string | null;
  parentPid: number | null;
}

/**
 * On Windows, query a process's executable path and parent PID via
 * Get-CimInstance (works on both PowerShell 5.1 and 7+, unlike .Parent which
 * requires PS 7).
 */
function queryWindowsProcess(pid: number): ProcessInfo {
  try {
    const script =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop; ` +
      `if($p){$p.ExecutablePath + '|' + $p.ParentProcessId}else{'|'}`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NoLogo", "-Command", script], {
      encoding: "utf-8",
      timeout: 10000,
      windowsHide: true
    });
    const stdout = (result.stdout ?? "").trim();
    const stderr = (result.stderr ?? "").trim();
    debug(`  queryWindowsProcess(${pid}): stdout="${stdout}" stderr="${stderr}" exitCode=${result.status}`);
    if (result.status !== 0 || !stdout) {
      return { exe: null, parentPid: null };
    }
    const sepIdx = stdout.lastIndexOf("|");
    if (sepIdx === -1) {
      return { exe: stdout || null, parentPid: null };
    }
    const exe = stdout.slice(0, sepIdx);
    const ppidStr = stdout.slice(sepIdx + 1);
    const parentPid = parseInt(ppidStr, 10);
    return {
      exe: exe || null,
      parentPid: Number.isFinite(parentPid) ? parentPid : null
    };
  } catch (e) {
    debug(`  queryWindowsProcess(${pid}): exception ${e}`);
    return { exe: null, parentPid: null };
  }
}

/**
 * On Windows, walk up the process tree from `startPid` until a non-blocked
 * executable is found (max 5 levels to avoid infinite loops).
 */
function detectWindowsParent(startPid: number): string | null {
  debug(`detectWindowsParent starting at PID ${startPid}`);
  let pid: number | null = startPid;
  for (let depth = 0; depth < 5 && pid !== null && pid > 0; depth++) {
    debug(`  depth=${depth} checking PID ${pid}`);
    const { exe, parentPid } = queryWindowsProcess(pid);
    if (exe && !isBlocked(exe)) {
      debug(`  → found shell: "${exe}"`);
      return exe;
    }
    if (!exe) {
      debug(`  → no exe for PID ${pid}, stopping tree walk`);
      break;
    }
    debug(`  → blocked, moving to parent PID ${parentPid}`);
    pid = parentPid;
  }
  debug(`  → tree walk exhausted, returning null`);
  return null;
}

/**
 * On Linux, walk up the process tree via /proc until a non-blocked executable
 * is found.
 */
function detectLinuxParent(startPid: number): string | null {
  debug(`detectLinuxParent starting at PID ${startPid}`);
  let pid = startPid;
  for (let depth = 0; depth < 5 && pid > 1; depth++) {
    try {
      const exe = readlinkSync(`/proc/${pid}/exe`);
      debug(`  depth=${depth} PID ${pid} → exe="${exe}"`);
      if (!isBlocked(exe)) return exe;
      const stat = require("node:fs").readFileSync(`/proc/${pid}/stat`, "utf-8") as string;
      const ppidMatch = stat.match(/^\d+ \(.+?\) \S+ (\d+)/);
      if (!ppidMatch) break;
      pid = parseInt(ppidMatch[1], 10);
    } catch (e) {
      debug(`  depth=${depth} PID ${pid} → error: ${e}`);
      break;
    }
  }
  debug(`  → tree walk exhausted, returning null`);
  return null;
}

/**
 * On macOS (and Unix fallback), walk up the process tree via `ps` until a
 * non-blocked executable is found.
 */
function detectDarwinParent(startPid: number): string | null {
  debug(`detectDarwinParent starting at PID ${startPid}`);
  let pid = startPid;
  for (let depth = 0; depth < 5 && pid > 1; depth++) {
    try {
      const result = spawnSync("ps", ["-o", "comm=,ppid=", "-p", String(pid)], {
        encoding: "utf-8",
        timeout: 5000
      });
      const output = result.stdout?.trim() ?? "";
      debug(`  depth=${depth} PID ${pid} → ps output="${output}"`);
      if (!output) break;
      const parts = output.trimEnd().split(/\s+/);
      const parentPid = parseInt(parts[parts.length - 1], 10);
      let comm = parts.slice(0, -1).join(" ");
      if (comm.startsWith("-")) comm = comm.slice(1);
      if (!comm) break;
      const resolved = Bun.which(comm) ?? comm;
      debug(`  depth=${depth} PID ${pid} → comm="${comm}" resolved="${resolved}"`);
      if (!isBlocked(resolved)) return resolved;
      pid = parentPid;
    } catch (e) {
      debug(`  depth=${depth} PID ${pid} → error: ${e}`);
      break;
    }
  }
  debug(`  → tree walk exhausted, returning null`);
  return null;
}

/**
 * Builds the full argv (command + args) for launching the detected shell.
 */
export function buildShellArgv(shell: string): string[] {
  return [shell];
}

/**
 * Detects the shell that invoked the current process by inspecting the parent
 * process. Returns the full path to the shell executable suitable for spawning
 * as a new climon session.
 *
 * Falls back to `$SHELL` (Unix) or `$ComSpec` (Windows) if detection fails or
 * the parent is not a recognizable shell.
 */
export function detectParentShell(): string {
  const ppid = process.ppid;
  debug(`detectParentShell: platform=${process.platform} ppid=${ppid}`);
  let detected: string | null = null;

  switch (process.platform) {
    case "win32":
      detected = detectWindowsParent(ppid);
      break;
    case "linux":
      detected = detectLinuxParent(ppid);
      break;
    default:
      // macOS and other Unix
      detected = detectDarwinParent(ppid);
      break;
  }

  if (detected && !isBlocked(detected)) {
    debug(`result: "${detected}"`);
    return detected;
  }

  // Environment fallback
  const fallback = process.platform === "win32"
    ? (process.env.ComSpec ?? "cmd.exe")
    : (process.env.SHELL ?? "/bin/sh");
  debug(`fallback: "${fallback}" (detected was ${detected ? `"${detected}"` : "null"})`);
  return fallback;
}
