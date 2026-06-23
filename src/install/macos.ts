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
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ShellProfile = {
  shell: string;
  profilePath: string;
};

const SHELL_PROFILES: Record<string, string> = {
  zsh: ".zshrc",
  bash: ".bash_profile",
  fish: ".config/fish/conf.d/climon.fish",
};

export function detectShellProfile(): ShellProfile {
  const shell = shellBasename(process.env.SHELL ?? "/bin/zsh");
  const profileFile = SHELL_PROFILES[shell] ?? SHELL_PROFILES.zsh!;
  return {
    shell,
    profilePath: join(homedir(), profileFile),
  };
}

function shellBasename(shellPath: string): string {
  const parts = shellPath.split("/");
  return parts[parts.length - 1] ?? "zsh";
}

export function pathExportLine(installDir: string): string {
  const home = homedir();
  const pathRef = installDir.startsWith(home)
    ? installDir.replace(home, "$HOME")
    : installDir;
  return `export PATH="${pathRef}:$PATH"`;
}

export function fishPathLine(installDir: string): string {
  const home = homedir();
  const pathRef = installDir.startsWith(home)
    ? installDir.replace(home, "$HOME")
    : installDir;
  return `fish_add_path "${pathRef}"`;
}

export function profileContainsPath(profileContent: string, installDir: string): boolean {
  const home = homedir();
  const pathRef = installDir.startsWith(home)
    ? installDir.replace(home, "$HOME")
    : installDir;

  // Check for the install dir in any PATH-related line (handles both literal and $HOME forms)
  return profileContent.includes(installDir) || profileContent.includes(pathRef);
}

export function ensureProfilePath(installDir: string, profile: ShellProfile): boolean {
  const { shell, profilePath } = profile;

  let existingContent = "";
  if (existsSync(profilePath)) {
    existingContent = readFileSync(profilePath, "utf8");
  }

  if (profileContainsPath(existingContent, installDir)) {
    return false;
  }

  const line = shell === "fish"
    ? fishPathLine(installDir)
    : pathExportLine(installDir);

  const prefix = existingContent.length > 0 && !existingContent.endsWith("\n") ? "\n" : "";
  appendFileSync(profilePath, `${prefix}${line}\n`);
  return true;
}

export function getDefaultInstallDir(): string {
  return join(homedir(), ".local", "bin");
}

export function killRunningClimonProcesses(): void {
  try {
    execSync("pkill -f '(^|/)climon(-server)?$' || true", {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch {
    // pkill returns non-zero when no processes matched; that's fine.
  }
}
