import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ShellProfile = {
  shell: string;
  profilePath: string;
};

const SHELL_PROFILES: Record<string, string> = {
  zsh: ".zshrc",
  bash: ".bashrc",
  fish: ".config/fish/conf.d/climon.fish",
};

export function detectShellProfile(): ShellProfile {
  const shell = shellBasename(process.env.SHELL ?? "/bin/bash");
  const profileFile = SHELL_PROFILES[shell] ?? SHELL_PROFILES.bash!;
  return {
    shell,
    profilePath: join(homedir(), profileFile),
  };
}

function shellBasename(shellPath: string): string {
  const parts = shellPath.split("/");
  return parts[parts.length - 1] ?? "bash";
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

  return profileContent.includes(installDir) || profileContent.includes(pathRef);
}

export function ensureProfilePath(installDir: string, profile: ShellProfile): boolean {
  const { shell, profilePath } = profile;

  // Ensure parent directory exists (e.g. ~/.config/fish/conf.d/)
  const parentDir = dirname(profilePath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

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
