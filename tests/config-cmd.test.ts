import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigArgs, runConfigCommand } from "../src/cli/config-cmd.js";

let root: string;
let home: string;

beforeEach(() => {
  const testTmp = join(process.cwd(), ".copilot-tmp");
  mkdirSync(testTmp, { recursive: true });
  root = mkdtempSync(join(testTmp, "climon-cfgcmd-"));
  home = join(root, ".climon");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return { CLIMON_HOME: home };
}

describe("parseConfigArgs", () => {
  test("rejects unknown keys", () => {
    expect(() => parseConfigArgs(["remote.nope", "x"])).toThrow(/Unknown config key/);
  });

  test("no longer recognizes keygen or known-host", () => {
    // These are now plain (invalid) keys, not subcommands.
    expect(() => parseConfigArgs(["keygen"])).toThrow(/Unknown config key/);
    expect(() => parseConfigArgs(["known-host", "x"])).toThrow(/Unknown config key/);
  });

  test("parses set with scope", () => {
    expect(parseConfigArgs(["--local", "remote.port", "6666"])).toEqual({
      action: "set",
      scope: "local",
      key: "remote.port",
      value: "6666"
    });
  });

  test("parses debug as a standalone diagnostic", () => {
    expect(parseConfigArgs(["--debug"])).toEqual({ action: "debug" });
    expect(() => parseConfigArgs(["--debug", "remote.port"])).toThrow(/without other config arguments/);
  });
});

describe("runConfigCommand", () => {
  test("set then get round-trips through the cascade", () => {
    expect(runConfigCommand(["remote.port", "6666"], env(), root)).toBe(0);
    expect(runConfigCommand(["remote.port"], env(), root)).toBe(0);
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(raw.remote.port).toBe(6666);
  });

  test("auto scope writes nearest existing .climon", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".climon"), { recursive: true });
    require("node:fs").writeFileSync(join(repo, ".climon", "config.json"), "{}");
    expect(runConfigCommand(["session.color", "green"], env(), repo)).toBe(0);
    const raw = JSON.parse(readFileSync(join(repo, ".climon", "config.json"), "utf8"));
    expect(raw.session.color).toBe("green");
  });

  test("rejects bad priority range", () => {
    expect(runConfigCommand(["session.priority", "9999"], env(), root)).toBe(2);
  });

  test("unset removes the key", () => {
    runConfigCommand(["--global", "remote.enabled", "true"], env(), root);
    expect(runConfigCommand(["--global", "--unset", "remote.enabled"], env(), root)).toBe(0);
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(raw.remote?.enabled).toBeUndefined();
  });

  test("get of an unset key returns exit code 1", () => {
    expect(runConfigCommand(["remote.port"], env(), root)).toBe(1);
  });

  test("--list prints only the keys that are set", () => {
    runConfigCommand(["--global", "remote.port", "6666"], env(), root);
    runConfigCommand(["--global", "session.color", "green"], env(), root);
    const out: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => {
      out.push(String(chunk));
      return true;
    };
    try {
      expect(runConfigCommand(["--list", "--global"], env(), root)).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const printed = out.join("");
    expect(printed).toContain("remote.port=6666");
    expect(printed).toContain("session.color=green");
    expect(printed).not.toContain("remote.enabled");
  });

  test("--debug prints candidate config files and keys in resolution order", () => {
    const repo = join(root, "repo");
    const nested = join(repo, "src", "app");
    mkdirSync(join(repo, ".climon"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(repo, ".climon", "config.json"), JSON.stringify({ session: { color: "green" } }));
    writeFileSync(join(home, "config.json"), JSON.stringify({ remote: { enabled: true, port: 3132 } }));

    const out: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => {
      out.push(String(chunk));
      return true;
    };
    try {
      expect(runConfigCommand(["--debug"], env(), nested)).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const printed = out.join("");
    expect(printed).toContain(join(nested, ".climon", "config.json"));
    expect(printed).toContain(join(repo, ".climon", "config.json"));
    expect(printed).toContain(join(home, "config.json"));
    expect(printed).toContain("  (missing)");
    expect(printed).toContain("  session.color");
    expect(printed).toContain("  remote.enabled");
    expect(printed).toContain("  remote.port");
    expect(printed.indexOf(join(nested, ".climon", "config.json"))).toBeLessThan(
      printed.indexOf(join(repo, ".climon", "config.json"))
    );
  });
});
