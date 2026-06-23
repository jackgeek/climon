import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { homedir } from "node:os";
import { runConfigCommand } from "../src/cli/config-cmd.js";
import { candidateConfigDirs, resolveConfigSetting, writeConfigSetting } from "../src/config.js";
import { CONFIG_SETTINGS } from "../src/config-settings.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(): { home: string; repo: string } {
  const base = join(process.cwd(), ".copilot-tmp");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "climon-go-"));
  dirs.push(root);
  const home = join(root, "home", ".climon");
  const repo = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, ".climon"), { recursive: true });
  writeFileSync(
    join(home, "config.jsonc"),
    `{"session":{"terminalProgram":"safe {cmd}"},"remote":{"port":3131},"update":{"password":"safe-password"}}`
  );
  writeFileSync(
    join(repo, ".climon", "config.jsonc"),
    `{"session":{"terminalProgram":"./evil.sh {cmd}"},"remote":{"port":4444},"update":{"password":"evil-password"}}`
  );
  return { home, repo };
}

describe("globalOnly settings", () => {
  it("flags the security-sensitive registry entries", () => {
    expect(CONFIG_SETTINGS.filter((setting) => setting.globalOnly).map((setting) => setting.path)).toEqual([
      "remote.enabled",
      "remote.host",
      "remote.ingestHost",
      "remote.tunnelId",
      "remote.dashboardTunnelId",
      "remote.dashboardTunnelCluster",
      "remote.dashboardTunnelEnabled",
      "remote.port",
      "remote.ingestPortRetryAttempts",
      "remote.clientId",
      "remote.spawnSecret",
      "remote.keepAlive",
      "remote.peerHome",
      "remote.peerHost",
      "remote.autoLink",
      "session.terminalProgram",
      "update.auto",
      "update.password",
      "update.lastCheck",
      "update.availableVersion"
    ]);
  });

  it("ignores project-local overrides for security-sensitive settings", () => {
    const { home, repo } = setup();
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;

    expect(resolveConfigSetting("session.terminalProgram", env, repo)).toBe("safe {cmd}");
    expect(resolveConfigSetting("remote.port", env, repo)).toBe(3131);
    expect(resolveConfigSetting("update.password", env, repo)).toBe("safe-password");
  });

  it("does not walk ancestor config dirs when cwd is outside the user home", () => {
    const { home } = setup();
    const outsideRoot = join(parse(homedir()).root, "climon-outside-home");
    const cwd = join(outsideRoot, "work", "project");
    const dirs = candidateConfigDirs({ CLIMON_HOME: home }, cwd);

    expect(dirs).toContain(join(cwd, ".climon"));
    expect(dirs).not.toContain(join(outsideRoot, "work", ".climon"));
    expect(dirs).not.toContain(join(outsideRoot, ".climon"));
    expect(dirs.at(-1)).toBe(home);
  });

  it("writes auto-scoped globalOnly settings to global config", () => {
    const { home, repo } = setup();
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;

    writeConfigSetting("session.terminalProgram", "safe-auto {cmd}", "auto", env, repo);

    expect(resolveConfigSetting("session.terminalProgram", env, repo)).toBe("safe-auto {cmd}");
    expect(readFileSync(join(home, "config.jsonc"), "utf8")).toContain("safe-auto {cmd}");
    expect(readFileSync(join(repo, ".climon", "config.jsonc"), "utf8")).not.toContain("safe-auto {cmd}");
  });

  it("warns when an explicit local write targets a globalOnly setting", () => {
    const { home, repo } = setup();
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    const stderr: string[] = [];

    const code = runConfigCommand(
      ["--local", "session.terminalProgram", "dead-local {cmd}"],
      env,
      repo,
      { stderr: (chunk) => stderr.push(chunk) }
    );

    expect(code).toBe(0);
    expect(stderr.join("")).toContain(
      "climon config: session.terminalProgram is global-only; the local value will not be read. Use --global to set the effective value."
    );
    expect(readFileSync(join(repo, ".climon", "config.jsonc"), "utf8")).toContain("dead-local {cmd}");
    expect(resolveConfigSetting("session.terminalProgram", env, repo)).toBe("safe {cmd}");
  });
});
