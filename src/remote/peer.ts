import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Cross-OS discovery helpers for the same-machine WSL <-> Windows case. The two
 * filesystems are mutually visible (WSL sees Windows at `/mnt/<drive>/...`;
 * Windows sees WSL at `\\wsl.localhost\<distro>\...`), so each side keeps its
 * own CLIMON_HOME and simply reads the peer's `server.json` beacon to discover a
 * dashboard running on the other OS. Nothing here shares a CLIMON_HOME or
 * crosses a socket — only small JSON files are read over the mount.
 */

export type RunCommand = (file: string, args: string[]) => string;

const defaultRun: RunCommand = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });

/** True when this process is running inside a WSL distribution. */
export function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== "linux") return false;
  if (typeof env.WSL_DISTRO_NAME === "string" && env.WSL_DISTRO_NAME.length > 0) return true;
  try {
    const version = readFileSync("/proc/version", "utf8").toLowerCase();
    return version.includes("microsoft") || version.includes("wsl");
  } catch {
    return false;
  }
}

/**
 * Detects the Windows-side CLIMON_HOME as seen from inside WSL, e.g.
 * `/mnt/c/Users/<you>/.climon`. Resolves `%USERPROFILE%` via `cmd.exe` and
 * translates it with `wslpath`. Returns the path only when it already exists,
 * which is our signal that climon has been set up on Windows. Returns undefined
 * on any failure so callers can stay quiet.
 */
export function detectWindowsClimonHome(
  run: RunCommand = defaultRun,
  exists: (p: string) => boolean = existsSync
): string | undefined {
  let profile: string;
  try {
    profile = run("cmd.exe", ["/c", "echo %USERPROFILE%"]).trim();
  } catch {
    return undefined;
  }
  if (!profile || profile.includes("%USERPROFILE%")) return undefined;
  let mnt: string;
  try {
    mnt = run("wslpath", ["-u", profile]).trim();
  } catch {
    return undefined;
  }
  if (!mnt) return undefined;
  const home = join(mnt, ".climon");
  return exists(home) ? home : undefined;
}

/**
 * Builds the WSL-side CLIMON_HOME path as a Windows UNC path, e.g.
 * `\\wsl.localhost\Ubuntu\home\you\.climon`. This is the value written into the
 * Windows config so a Windows-side client can discover a WSL-hosted dashboard.
 * Returns undefined when the distro name or home directory is unknown.
 */
export function wslHomeUncPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const distro = env.WSL_DISTRO_NAME;
  const home = env.HOME ?? (env.USER ? `/home/${env.USER}` : undefined);
  if (!distro || !home) return undefined;
  const tail = `${home}/.climon`.replace(/\//g, "\\");
  return `\\\\wsl.localhost\\${distro}${tail}`;
}

/**
 * Parses the WSL2 default-route gateway IP from `/proc/net/route` without
 * spawning anything. Under NAT networking this is the address that reaches the
 * Windows host. Returns undefined under mirrored networking (no default route
 * gateway) or on any parse failure.
 */
export function wslDefaultGatewayIp(read: (p: string) => string = (p) => readFileSync(p, "utf8")): string | undefined {
  let table: string;
  try {
    table = read("/proc/net/route");
  } catch {
    return undefined;
  }
  for (const line of table.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const [, destination, gateway] = cols;
    if (destination !== "00000000") continue;
    const hex = gateway;
    if (!/^[0-9A-Fa-f]{8}$/.test(hex)) continue;
    // Little-endian hex (e.g. "0100A8C0" -> 192.168.0.1).
    const octets = [
      parseInt(hex.slice(6, 8), 16),
      parseInt(hex.slice(4, 6), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(0, 2), 16)
    ];
    if (octets.every((n) => Number.isFinite(n))) return octets.join(".");
  }
  return undefined;
}

/**
 * Ordered list of hosts to try when reaching a dashboard on the peer OS.
 *
 * - Windows -> WSL: WSL2 forwards `localhost` into the distro, so localhost is
 *   the only candidate.
 * - WSL -> Windows: under mirrored networking `localhost` reaches Windows;
 *   under NAT the default-route gateway IP does. Both are tried (localhost
 *   first), and the `/health` probe selects the reachable one.
 */
export function peerHostCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = ["localhost"];
  if (isWsl(env)) {
    const gateway = wslDefaultGatewayIp();
    if (gateway && !candidates.includes(gateway)) candidates.push(gateway);
  }
  return candidates;
}

/**
 * Human label for the peer OS, used in `climon cleanup` guidance. When this
 * process runs on Windows the peer is WSL, and vice versa.
 */
export function peerOsLabel(_env: NodeJS.ProcessEnv = process.env): string {
  return process.platform === "win32" ? "WSL" : "Windows";
}
