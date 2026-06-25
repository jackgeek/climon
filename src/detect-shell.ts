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
import { readlinkSync } from "node:fs";
import { child } from "./logging/logger.js";
import { logMsg } from "./i18n/log-msg.js";

function debug(message: string): void {
  logMsg(child("shell-detect"), "debug", "shell.detect_debug", { detail: message });
}

function trace(message: string): void {
  logMsg(child("shell-detect"), "trace", "shell.detect_trace", { detail: message });
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
  trace(`  isBlocked("${exe}") → base="${base}" name="${name}" → ${blocked}`);
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
    trace(`  queryWindowsProcess(${pid}): stdout="${stdout}" stderr="${stderr}" exitCode=${result.status}`);
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
    trace(`  queryWindowsProcess(${pid}): exception ${e}`);
    return { exe: null, parentPid: null };
  }
}

/**
 * On Windows, walk up the process tree from `startPid` until a non-blocked
 * executable is found (max 5 levels to avoid infinite loops).
 */
function detectWindowsParent(startPid: number): string | null {
  trace(`detectWindowsParent starting at PID ${startPid}`);
  let pid: number | null = startPid;
  for (let depth = 0; depth < 5 && pid !== null && pid > 0; depth++) {
    trace(`  depth=${depth} checking PID ${pid}`);
    const { exe, parentPid } = queryWindowsProcess(pid);
    if (exe && !isBlocked(exe)) {
      trace(`  → found shell: "${exe}"`);
      return exe;
    }
    if (!exe) {
      trace(`  → no exe for PID ${pid}, stopping tree walk`);
      break;
    }
    trace(`  → blocked, moving to parent PID ${parentPid}`);
    pid = parentPid;
  }
  trace(`  → tree walk exhausted, returning null`);
  return null;
}

/**
 * On Linux, walk up the process tree via /proc until a non-blocked executable
 * is found.
 */
function detectLinuxParent(startPid: number): string | null {
  trace(`detectLinuxParent starting at PID ${startPid}`);
  let pid = startPid;
  for (let depth = 0; depth < 5 && pid > 1; depth++) {
    try {
      const exe = readlinkSync(`/proc/${pid}/exe`);
      trace(`  depth=${depth} PID ${pid} → exe="${exe}"`);
      if (!isBlocked(exe)) return exe;
      const stat = require("node:fs").readFileSync(`/proc/${pid}/stat`, "utf-8") as string;
      const ppidMatch = stat.match(/^\d+ \(.+?\) \S+ (\d+)/);
      if (!ppidMatch) break;
      pid = parseInt(ppidMatch[1], 10);
    } catch (e) {
      trace(`  depth=${depth} PID ${pid} → error: ${e}`);
      break;
    }
  }
  trace(`  → tree walk exhausted, returning null`);
  return null;
}

/**
 * On macOS (and Unix fallback), walk up the process tree via `ps` until a
 * non-blocked executable is found.
 */
function detectDarwinParent(startPid: number): string | null {
  trace(`detectDarwinParent starting at PID ${startPid}`);
  let pid = startPid;
  for (let depth = 0; depth < 5 && pid > 1; depth++) {
    try {
      const result = spawnSync("ps", ["-o", "comm=,ppid=", "-p", String(pid)], {
        encoding: "utf-8",
        timeout: 5000
      });
      const output = result.stdout?.trim() ?? "";
      trace(`  depth=${depth} PID ${pid} → ps output="${output}"`);
      if (!output) break;
      const parts = output.trimEnd().split(/\s+/);
      const parentPid = parseInt(parts[parts.length - 1], 10);
      let comm = parts.slice(0, -1).join(" ");
      if (comm.startsWith("-")) comm = comm.slice(1);
      if (!comm) break;
      const resolved = Bun.which(comm) ?? comm;
      trace(`  depth=${depth} PID ${pid} → comm="${comm}" resolved="${resolved}"`);
      if (!isBlocked(resolved)) return resolved;
      pid = parentPid;
    } catch (e) {
      trace(`  depth=${depth} PID ${pid} → error: ${e}`);
      break;
    }
  }
  trace(`  → tree walk exhausted, returning null`);
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
