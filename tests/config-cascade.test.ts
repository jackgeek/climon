import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  candidateConfigDirs,
  coerceConfigValue,
  listExistingConfigFiles,
  resolveConfigSetting,
  unsetConfigSetting,
  writeConfigSetting
} from "../src/config.js";

let root: string;
let home: string;

beforeEach(() => {
  const testTmp = join(process.cwd(), ".copilot-tmp");
  mkdirSync(testTmp, { recursive: true });
  root = mkdtempSync(join(testTmp, "climon-cascade-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return { CLIMON_HOME: join(home, ".climon") };
}

function writeSetting(dir: string, obj: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
}

describe("config cascade", () => {
  test("repo-level setting overrides global", () => {
    const repo = join(root, "work", "repo");
    mkdirSync(repo, { recursive: true });
    writeSetting(join(repo, ".climon"), { session: { color: "green", priority: 20 } });
    writeSetting(join(home, ".climon"), { session: { color: "red", priority: 500 } });
    expect(resolveConfigSetting("session.color", env(), repo)).toBe("green");
    expect(resolveConfigSetting("session.priority", env(), repo)).toBe(20);
  });

  test("falls back to global per-setting when repo omits the key", () => {
    const repo = join(root, "work", "repo");
    mkdirSync(repo, { recursive: true });
    writeSetting(join(repo, ".climon"), { session: { color: "green" } });
    writeSetting(join(home, ".climon"), { session: { priority: 500 } });
    expect(resolveConfigSetting("session.color", env(), repo)).toBe("green");
    expect(resolveConfigSetting("session.priority", env(), repo)).toBe(500);
  });

  test("returns undefined when no dir defines the key", () => {
    const repo = join(root, "work", "repo");
    mkdirSync(repo, { recursive: true });
    expect(resolveConfigSetting("remote.tunnelId", env(), repo)).toBeUndefined();
  });

  test("walks ancestors up to filesystem root", () => {
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    writeSetting(join(root, "a", ".climon"), { remote: { port: 6666 } });
    expect(resolveConfigSetting("remote.port", env(), deep)).toBe(6666);
  });

  test("candidateConfigDirs lists cwd, ancestors, then home", () => {
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    const dirs = candidateConfigDirs(env(), deep);
    expect(dirs[0]).toBe(join(deep, ".climon"));
    expect(dirs[dirs.length - 1]).toBe(join(home, ".climon"));
  });

  test("write to nearest existing .climon", () => {
    const repo = join(root, "work", "repo");
    const sub = join(repo, "src");
    mkdirSync(sub, { recursive: true });
    writeSetting(join(repo, ".climon"), {});
    writeConfigSetting("session.color", "blue", "auto", env(), sub);
    expect(resolveConfigSetting("session.color", env(), sub)).toBe("blue");
    expect(resolveConfigSetting("session.color", env(), repo)).toBe("blue");
  });

  test("write creates ~/.climon when no ancestor .climon exists", () => {
    const repo = join(root, "work", "repo");
    mkdirSync(repo, { recursive: true });
    writeConfigSetting("session.priority", "42", "auto", env(), repo);
    expect(resolveConfigSetting("session.priority", env(), repo)).toBe(42);
    expect(resolveConfigSetting("session.priority", env(), home)).toBe(42);
  });

  test("--local writes cwd/.climon sparsely", () => {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeConfigSetting("remote.enabled", "true", "local", env(), repo);
    const raw = JSON.parse(
      require("node:fs").readFileSync(join(repo, ".climon", "config.jsonc"), "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")
    );
    expect(raw).toEqual({ remote: { enabled: true } });
  });

  test("sparse repo config does not break full loadConfig", async () => {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeSetting(join(repo, ".climon"), { session: { color: "green" } });
    const { loadConfig } = await import("../src/config.js");
    const cfg = await loadConfig(env());
    expect(cfg.version).toBe(1);
    expect(cfg.server.host).toBe("127.0.0.1");
  });
});

describe("listExistingConfigFiles", () => {
  test("lists canonical and legacy config files from cwd ancestors then home", () => {
    const repo = join(root, "work", "repo");
    const nested = join(repo, "src", "app");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, ".climon"), { recursive: true });
    mkdirSync(join(root, "work", ".climon"), { recursive: true });
    mkdirSync(join(home, ".climon"), { recursive: true });

    writeFileSync(join(repo, ".climon", "config.jsonc"), "{}");
    writeFileSync(join(repo, ".climon", "config.json"), "{}");
    writeFileSync(join(root, "work", ".climon", "config.json"), "{}");
    writeFileSync(join(home, ".climon", "config.jsonc"), "{}");

    expect(listExistingConfigFiles(env(), nested)).toEqual([
      join(repo, ".climon", "config.jsonc"),
      join(repo, ".climon", "config.json"),
      join(root, "work", ".climon", "config.json"),
      join(home, ".climon", "config.jsonc")
    ]);
  });

  test("returns an empty array when no cascade config files exist", () => {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    expect(listExistingConfigFiles(env(), repo)).toEqual([]);
  });

  test("lists canonical symlink and legacy target in the same config dir", () => {
    const repo = join(root, "repo");
    const configDir = join(repo, ".climon");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "{}");
    symlinkSync(join(configDir, "config.json"), join(configDir, "config.jsonc"));

    expect(listExistingConfigFiles(env(), repo)).toEqual([
      join(configDir, "config.jsonc"),
      join(configDir, "config.json")
    ]);
  });

  test("does not list duplicate files when CLIMON_HOME aliases an ancestor .climon dir", () => {
    const repo = join(root, "repo");
    const configDir = join(repo, ".climon");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.jsonc"), "{}");
    writeFileSync(join(configDir, "config.json"), "{}");

    expect(listExistingConfigFiles({ CLIMON_HOME: `${configDir}${sep}` }, repo)).toEqual([
      join(configDir, "config.jsonc"),
      join(configDir, "config.json")
    ]);
  });

  test("does not list duplicate files when CLIMON_HOME symlinks to an ancestor .climon dir", () => {
    const repo = join(root, "repo");
    const nested = join(repo, "src");
    const configDir = join(repo, ".climon");
    const symlinkHome = join(root, "home-link");
    mkdirSync(nested, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    symlinkSync(configDir, symlinkHome, "dir");
    writeFileSync(join(configDir, "config.jsonc"), "{}");
    writeFileSync(join(configDir, "config.json"), "{}");

    expect(listExistingConfigFiles({ CLIMON_HOME: symlinkHome }, nested)).toEqual([
      join(configDir, "config.jsonc"),
      join(configDir, "config.json")
    ]);
  });
});

describe("coerceConfigValue", () => {
  test("parses booleans", () => {
    expect(coerceConfigValue("remote.enabled", "true")).toBe(true);
    expect(coerceConfigValue("remote.enabled", "false")).toBe(false);
  });

  test("rejects a non-boolean boolean value", () => {
    expect(() => coerceConfigValue("remote.enabled", "yes")).toThrow();
  });

  test("accepts session.priority at both range boundaries", () => {
    expect(coerceConfigValue("session.priority", "0")).toBe(0);
    expect(coerceConfigValue("session.priority", "1000")).toBe(1000);
  });

  test("rejects session.priority above the range", () => {
    expect(() => coerceConfigValue("session.priority", "1001")).toThrow();
  });

  test("rejects a negative session.priority", () => {
    expect(() => coerceConfigValue("session.priority", "-1")).toThrow();
  });

  test("rejects a non-integer number", () => {
    expect(() => coerceConfigValue("remote.port", "12.5")).toThrow();
  });

  test("requires remote.port to be a positive integer", () => {
    expect(coerceConfigValue("remote.port", "6666")).toBe(6666);
    expect(() => coerceConfigValue("remote.port", "0")).toThrow();
  });

  test("accepts auto as a session color config value", () => {
    expect(coerceConfigValue("session.color", "auto")).toBe("auto");
  });

  test("rejects invalid session color config values", () => {
    expect(() => coerceConfigValue("session.color", "orange")).toThrow(/must be one of/);
  });

  test("returns string values unchanged", () => {
    expect(coerceConfigValue("remote.tunnelId", "abc-123")).toBe("abc-123");
  });
});

describe("sparse writes preserve existing keys", () => {
  test("setting one key leaves other keys in the same file intact", () => {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeSetting(join(repo, ".climon"), { session: { color: "red" } });
    writeConfigSetting("session.priority", "42", "local", env(), repo);
    expect(resolveConfigSetting("session.color", env(), repo)).toBe("red");
    expect(resolveConfigSetting("session.priority", env(), repo)).toBe(42);
  });

  test("setting a key in a new section keeps an existing section", () => {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeSetting(join(repo, ".climon"), { session: { color: "red" } });
    writeConfigSetting("remote.enabled", "true", "local", env(), repo);
    expect(resolveConfigSetting("session.color", env(), repo)).toBe("red");
    expect(resolveConfigSetting("remote.enabled", env(), repo)).toBe(true);
  });
});

describe("unsetConfigSetting", () => {
  test("removes one key but keeps others, then drops the empty section", () => {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeSetting(join(repo, ".climon"), { session: { color: "red", priority: 42 } });
    unsetConfigSetting("session.color", "local", env(), repo);
    expect(resolveConfigSetting("session.color", env(), repo)).toBeUndefined();
    expect(resolveConfigSetting("session.priority", env(), repo)).toBe(42);
    unsetConfigSetting("session.priority", "local", env(), repo);
    const raw = JSON.parse(
      require("node:fs").readFileSync(join(repo, ".climon", "config.jsonc"), "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")
    );
    expect(raw).toEqual({});
  });

  test("is a no-op when the file does not exist", () => {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    expect(() => unsetConfigSetting("session.color", "local", env(), repo)).not.toThrow();
  });
});
