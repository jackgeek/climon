import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigSetting } from "../src/config.js";
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
});
