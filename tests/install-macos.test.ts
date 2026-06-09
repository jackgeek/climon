import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  detectShellProfile,
  ensureProfilePath,
  fishPathLine,
  pathExportLine,
  profileContainsPath,
} from "../src/install/macos.js";

const tempRoot = join(process.cwd(), ".copilot-tmp", "install-macos-test");
const tempDirs: string[] = [];
let tempDirId = 0;

function makeTempDir(): string {
  const dir = join(tempRoot, `${process.pid}-${tempDirId++}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("pathExportLine", () => {
  test("generates export PATH line with $HOME substitution", () => {
    const home = homedir();
    const line = pathExportLine(`${home}/.local/bin`);
    expect(line).toBe(`export PATH="$HOME/.local/bin:$PATH"`);
  });

  test("uses literal path when not under home", () => {
    const line = pathExportLine("/opt/climon/bin");
    expect(line).toBe(`export PATH="/opt/climon/bin:$PATH"`);
  });
});

describe("fishPathLine", () => {
  test("generates fish_add_path with $HOME substitution", () => {
    const home = homedir();
    const line = fishPathLine(`${home}/.local/bin`);
    expect(line).toBe(`fish_add_path "$HOME/.local/bin"`);
  });
});

describe("profileContainsPath", () => {
  test("returns true when profile contains the $HOME form", () => {
    const home = homedir();
    const content = `export PATH="$HOME/.local/bin:$PATH"\n`;
    expect(profileContainsPath(content, `${home}/.local/bin`)).toBe(true);
  });

  test("returns true when profile contains the literal path", () => {
    const home = homedir();
    const content = `export PATH="${home}/.local/bin:$PATH"\n`;
    expect(profileContainsPath(content, `${home}/.local/bin`)).toBe(true);
  });

  test("returns false when path not present", () => {
    const content = `export PATH="/other/bin:$PATH"\n`;
    expect(profileContainsPath(content, "/usr/local/bin/climon")).toBe(false);
  });
});

describe("detectShellProfile", () => {
  test("detects zsh shell and returns .zshrc path", () => {
    const originalShell = process.env.SHELL;
    try {
      process.env.SHELL = "/bin/zsh";
      const profile = detectShellProfile();
      expect(profile.shell).toBe("zsh");
      expect(profile.profilePath).toEndWith(".zshrc");
    } finally {
      process.env.SHELL = originalShell;
    }
  });

  test("detects bash shell and returns .bash_profile path", () => {
    const originalShell = process.env.SHELL;
    try {
      process.env.SHELL = "/bin/bash";
      const profile = detectShellProfile();
      expect(profile.shell).toBe("bash");
      expect(profile.profilePath).toEndWith(".bash_profile");
    } finally {
      process.env.SHELL = originalShell;
    }
  });

  test("detects fish shell", () => {
    const originalShell = process.env.SHELL;
    try {
      process.env.SHELL = "/usr/local/bin/fish";
      const profile = detectShellProfile();
      expect(profile.shell).toBe("fish");
      expect(profile.profilePath).toContain("fish");
    } finally {
      process.env.SHELL = originalShell;
    }
  });

  test("defaults to zsh for unknown shells", () => {
    const originalShell = process.env.SHELL;
    try {
      process.env.SHELL = "/bin/ksh";
      const profile = detectShellProfile();
      expect(profile.shell).toBe("ksh");
      expect(profile.profilePath).toEndWith(".zshrc");
    } finally {
      process.env.SHELL = originalShell;
    }
  });
});

describe("ensureProfilePath", () => {
  test("appends PATH export to an empty profile", () => {
    const dir = makeTempDir();
    const profilePath = join(dir, ".zshrc");
    const installDir = "/test/.local/bin";

    const changed = ensureProfilePath(installDir, { shell: "zsh", profilePath });

    expect(changed).toBe(true);
    const content = readFileSync(profilePath, "utf8");
    expect(content).toBe(`export PATH="/test/.local/bin:$PATH"\n`);
  });

  test("appends to existing profile with trailing newline", () => {
    const dir = makeTempDir();
    const profilePath = join(dir, ".zshrc");
    writeFileSync(profilePath, "# existing content\n");
    const installDir = "/test/.local/bin";

    const changed = ensureProfilePath(installDir, { shell: "zsh", profilePath });

    expect(changed).toBe(true);
    const content = readFileSync(profilePath, "utf8");
    expect(content).toBe(`# existing content\nexport PATH="/test/.local/bin:$PATH"\n`);
  });

  test("appends with newline separator when profile has no trailing newline", () => {
    const dir = makeTempDir();
    const profilePath = join(dir, ".zshrc");
    writeFileSync(profilePath, "# no trailing newline");
    const installDir = "/test/.local/bin";

    const changed = ensureProfilePath(installDir, { shell: "zsh", profilePath });

    expect(changed).toBe(true);
    const content = readFileSync(profilePath, "utf8");
    expect(content).toBe(`# no trailing newline\nexport PATH="/test/.local/bin:$PATH"\n`);
  });

  test("does not modify profile when install dir is already present", () => {
    const dir = makeTempDir();
    const profilePath = join(dir, ".zshrc");
    writeFileSync(profilePath, `export PATH="/test/.local/bin:$PATH"\n`);
    const installDir = "/test/.local/bin";

    const changed = ensureProfilePath(installDir, { shell: "zsh", profilePath });

    expect(changed).toBe(false);
    const content = readFileSync(profilePath, "utf8");
    expect(content).toBe(`export PATH="/test/.local/bin:$PATH"\n`);
  });

  test("uses fish_add_path for fish shell", () => {
    const dir = makeTempDir();
    const profilePath = join(dir, "climon.fish");
    const installDir = "/test/.local/bin";

    const changed = ensureProfilePath(installDir, { shell: "fish", profilePath });

    expect(changed).toBe(true);
    const content = readFileSync(profilePath, "utf8");
    expect(content).toBe(`fish_add_path "/test/.local/bin"\n`);
  });
});
