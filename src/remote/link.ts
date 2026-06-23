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
import { getClimonHome, resolveConfigSetting, writeConfigSetting } from "../config.js";
import { detectWindowsClimonHome, isWsl, wslHomeUncPath } from "./peer.js";

export interface LinkOptions {
  /** Explicit peer CLIMON_HOME path; auto-detected from WSL when omitted. */
  peerHome?: string;
}

export interface LinkResult {
  localHome: string;
  peerHome: string;
  /** True when the reverse pointer was also written into the peer's config. */
  reverseLinked: boolean;
}

export interface LinkDeps {
  isWsl?: (env: NodeJS.ProcessEnv) => boolean;
  detectWindowsClimonHome?: () => string | undefined;
  wslHomeUncPath?: (env: NodeJS.ProcessEnv) => string | undefined;
  writeConfigSetting?: typeof writeConfigSetting;
  resolveConfigSetting?: typeof resolveConfigSetting;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Links this machine's climon to the peer OS's climon for same-machine
 * WSL<->Windows discovery. Writes `remote.peerHome` into the local config and,
 * when run from WSL, also writes the reverse pointer (the WSL home as a Windows
 * UNC path) into the Windows config over the mount so both directions resolve
 * from a single command. Throws when the peer home cannot be determined.
 */
export function linkPeer(
  options: LinkOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  deps: LinkDeps = {}
): LinkResult {
  const onWsl = (deps.isWsl ?? isWsl)(env);
  const write = deps.writeConfigSetting ?? writeConfigSetting;

  const peerHome =
    options.peerHome ?? (onWsl ? (deps.detectWindowsClimonHome ?? detectWindowsClimonHome)() : undefined);
  if (!peerHome) {
    throw new Error(
      onWsl
        ? "Could not detect the Windows CLIMON_HOME. Pass it explicitly: climon link --peer-home /mnt/c/Users/<you>/.climon"
        : "Provide the peer CLIMON_HOME: climon link --peer-home <path>"
    );
  }

  const localHome = getClimonHome(env);
  write("remote.peerHome", peerHome, "global", env, cwd);

  let reverseLinked = false;
  if (onWsl) {
    const reversePointer = (deps.wslHomeUncPath ?? wslHomeUncPath)(env);
    if (reversePointer) {
      // Write into the peer (Windows) config by pointing CLIMON_HOME at it.
      write("remote.peerHome", reversePointer, "global", { ...env, CLIMON_HOME: peerHome }, cwd);
      reverseLinked = true;
    }
  }

  return { localHome, peerHome, reverseLinked };
}

/**
 * Lazily auto-links on the first `climon` run inside WSL when no peer link is
 * configured yet and a Windows-side climon is detected. Announces the attempt
 * and how to disable it *before* writing anything (so a hang/failure is
 * self-explanatory), then confirms success. Stays completely silent when
 * disabled, not on WSL, already linked, or no Windows climon is present.
 */
export async function maybeAutoLink(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  out: (text: string) => void = (text) => process.stderr.write(text),
  deps: LinkDeps = {}
): Promise<void> {
  const resolve = deps.resolveConfigSetting ?? resolveConfigSetting;
  if (resolve("remote.autoLink", env, cwd) === false) return;
  if (asString(resolve("remote.peerHome", env, cwd))) return;
  if (!(deps.isWsl ?? isWsl)(env)) return;

  const winHome = (deps.detectWindowsClimonHome ?? detectWindowsClimonHome)();
  if (!winHome) return;

  out(`climon: detected a Windows climon at ${winHome}; attempting to auto-link so sessions appear on the Windows dashboard.\n`);
  out(`climon: to prevent this, run: climon config remote.autoLink false\n`);
  try {
    const result = linkPeer({ peerHome: winHome }, env, cwd, deps);
    out(
      `climon: auto-link successful — WSL<->Windows discovery configured${
        result.reverseLinked ? " on both sides" : " (WSL side only)"
      }.\n`
    );
  } catch (error) {
    out(
      `climon: auto-link failed: ${(error as Error).message}. Continuing without it. ` +
        `Set it manually with: climon config remote.peerHome <path>, or disable with: climon config remote.autoLink false\n`
    );
  }
}
