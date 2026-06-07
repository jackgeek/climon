import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigArgs, runConfigCommand } from "../src/cli/config-cmd.js";
import { parseJsoncConfig } from "../src/config-jsonc.js";

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

  test("rejects help combined with scope flags", () => {
    expect(() => parseConfigArgs(["--local", "--help"])).toThrow(/without other config arguments/);
    expect(() => parseConfigArgs(["--global", "--help"])).toThrow(/without other config arguments/);
  });

  test("rejects help combined with positional arguments", () => {
    expect(() => parseConfigArgs(["--help", "remote.port"])).toThrow(/without other config/);
  });

  test("rejects help combined with unset", () => {
    expect(() => parseConfigArgs(["--help", "--unset", "remote.port"])).toThrow(/without other config/);
  });

  test("parses purge as a standalone action", () => {
    expect(parseConfigArgs(["--purge"])).toEqual({ action: "purge" });
  });

  test("rejects purge combined with other config arguments", () => {
    expect(() => parseConfigArgs(["--purge", "remote.port"])).toThrow(/without other config arguments/);
    expect(() => parseConfigArgs(["--purge", "--help"])).toThrow(/without other config arguments/);
    expect(() => parseConfigArgs(["--purge", "--debug"])).toThrow(/without other config arguments/);
    expect(() => parseConfigArgs(["--purge", "--list"])).toThrow(/without other config arguments/);
    expect(() => parseConfigArgs(["--purge", "--unset", "remote.port"])).toThrow(/without other config arguments/);
    expect(() => parseConfigArgs(["--purge", "--local"])).toThrow(/without other config arguments/);
    expect(() => parseConfigArgs(["--purge", "--global"])).toThrow(/without other config arguments/);
  });
});

describe("runConfigCommand", () => {
  test("set then get round-trips through the cascade", () => {
    expect(runConfigCommand(["remote.port", "6666"], env(), root)).toBe(0);
    expect(runConfigCommand(["remote.port"], env(), root)).toBe(0);
    const raw = parseJsoncConfig(readFileSync(join(home, "config.jsonc"), "utf8"), "config.jsonc");
    expect(raw.remote).toBeDefined();
    expect((raw.remote as Record<string, unknown>).port).toBe(6666);
  });

  test("auto scope writes nearest existing .climon", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".climon"), { recursive: true });
    require("node:fs").writeFileSync(join(repo, ".climon", "config.json"), "{}");
    expect(runConfigCommand(["session.color", "green"], env(), repo)).toBe(0);
    // After migration, config should be in config.jsonc
    const raw = parseJsoncConfig(readFileSync(join(repo, ".climon", "config.jsonc"), "utf8"), "config.jsonc");
    expect((raw.session as Record<string, unknown>).color).toBe("green");
  });

  test("sets and lists session.color auto", () => {
    expect(runConfigCommand(["session.color", "auto"], env(), root)).toBe(0);
    const raw = parseJsoncConfig(readFileSync(join(home, "config.jsonc"), "utf8"), "config.jsonc");
    expect((raw.session as Record<string, unknown>).color).toBe("auto");

    const out: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => {
      out.push(String(chunk));
      return true;
    };
    try {
      expect(runConfigCommand(["--list"], env(), root)).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(out.join("")).toContain("session.color=auto");
  });

  test("rejects bad priority range", () => {
    expect(runConfigCommand(["session.priority", "9999"], env(), root)).toBe(2);
  });

  test("unset removes the key", () => {
    runConfigCommand(["--global", "remote.enabled", "true"], env(), root);
    runConfigCommand(["--global", "remote.port", "3333"], env(), root);
    expect(runConfigCommand(["--global", "--unset", "remote.enabled"], env(), root)).toBe(0);
    const raw = parseJsoncConfig(readFileSync(join(home, "config.jsonc"), "utf8"), "config.jsonc");
    expect(raw.remote).toBeDefined();
    expect((raw.remote as Record<string, unknown>)?.enabled).toBeUndefined();
    expect((raw.remote as Record<string, unknown>)?.port).toBe(3333);
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
    writeFileSync(join(repo, ".climon", "config.jsonc"), JSON.stringify({ session: { color: "green" } }));
    writeFileSync(join(home, "config.jsonc"), JSON.stringify({ remote: { enabled: true, port: 3132 } }));

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
    expect(printed).toContain(join(nested, ".climon", "config.jsonc"));
    expect(printed).toContain(join(repo, ".climon", "config.jsonc"));
    expect(printed).toContain(join(home, "config.jsonc"));
    expect(printed).toContain("  (missing)");
    expect(printed).toContain("  session.color");
    expect(printed).toContain("  remote.enabled");
    expect(printed).toContain("  remote.port");
    expect(printed.indexOf(join(nested, ".climon", "config.jsonc"))).toBeLessThan(
      printed.indexOf(join(repo, ".climon", "config.jsonc"))
    );
  });

  test("--debug prints values and redacts sensitive ones", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.jsonc"),
      JSON.stringify({ remote: { enabled: true, port: 3132, tunnelToken: "super-secret-token" }, mystery: { apiKey: "leak-me" } })
    );

    const out: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => {
      out.push(String(chunk));
      return true;
    };
    try {
      expect(runConfigCommand(["--debug"], env(), root)).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const printed = out.join("");
    expect(printed).toContain("  remote.enabled = true");
    expect(printed).toContain("  remote.port = 3132");
    expect(printed).toContain("  remote.tunnelToken = <redacted>");
    expect(printed).not.toContain("super-secret-token");
    expect(printed).toContain("  mystery.apiKey = <redacted>");
    expect(printed).not.toContain("leak-me");
  });

  test("set migrates legacy config.json to config.jsonc with a backup", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ remote: { port: 3132 } })
    );
    
    expect(runConfigCommand(["remote.enabled", "true"], env(), root)).toBe(0);
    
    // Check config.jsonc exists with generated comment
    const jsoncPath = join(home, "config.jsonc");
    expect(existsSync(jsoncPath)).toBe(true);
    
    const raw = readFileSync(jsoncPath, "utf8");
    const parsed = parseJsoncConfig(raw, jsoncPath);
    
    expect(parsed.remote).toBeDefined();
    expect((parsed.remote as Record<string, unknown>).port).toBe(3132);
    expect((parsed.remote as Record<string, unknown>).enabled).toBe(true);
    
    // Check comment was added for remote.enabled
    expect(raw).toContain("// Enables remote uplink");
    
    // Check legacy config.json was backed up and removed
    expect(existsSync(join(home, "config.json.bak"))).toBe(true);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("auto scope writes nearest existing config.jsonc", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".climon"), { recursive: true });
    writeFileSync(join(repo, ".climon", "config.jsonc"), "{}");
    
    expect(runConfigCommand(["session.color", "green"], env(), repo)).toBe(0);
    
    const raw = readFileSync(join(repo, ".climon", "config.jsonc"), "utf8");
    const parsed = parseJsoncConfig(raw, "config.jsonc");
    expect((parsed.session as Record<string, unknown>).color).toBe("green");
  });

  test("reports error when legacy config backup rename fails", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ remote: { port: 3132 } }));
    
    // Create config.json.bak as a directory to cause rename to fail
    mkdirSync(join(home, "config.json.bak"), { recursive: true });
    
    const stderr: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string) => {
      stderr.push(String(chunk));
      return true;
    };
    
    try {
      expect(runConfigCommand(["remote.enabled", "true"], env(), root)).toBe(2);
    } finally {
      process.stderr.write = originalStderrWrite;
    }
    
    // Canonical config.jsonc should exist with the new setting
    const jsoncPath = join(home, "config.jsonc");
    expect(existsSync(jsoncPath)).toBe(true);
    const parsed = parseJsoncConfig(readFileSync(jsoncPath, "utf8"), jsoncPath);
    expect((parsed.remote as Record<string, unknown>).enabled).toBe(true);
    
    // Legacy config.json should still exist because backup rename failed
    expect(existsSync(join(home, "config.json"))).toBe(true);
    
    // Stderr should mention the cleanup/migration problem
    const stderrOutput = stderr.join("");
    expect(stderrOutput).toContain("config.json.bak");
  });

  test("prints registry-driven config help in terminal-friendly plain text", () => {
    const out: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => {
      out.push(String(chunk));
      return true;
    };
    try {
      expect(runConfigCommand(["--help"], env(), root)).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const printed = out.join("");
    expect(printed).toContain("Usage:");
    expect(printed).toContain("climon config <key>");
    expect(printed).toContain("climon config --purge");
    expect(printed).toContain("config.jsonc");
    expect(printed).toContain("Legacy config.json files");
    expect(printed).not.toContain("| Path | Type | Default | Scope | Description |");
    expect(printed).not.toContain("|------|------|---------|-------|-------------|");
    expect(printed).toContain("  session.color");
    expect(printed).toContain("    Type: string; Default: auto; Scope: client, daemon, server");
    expect(printed).toContain("    Specifies the default accent color");
    expect(printed).toContain("  remote.tunnelToken");
    expect(printed).toContain("    Type: string; Default: unset; Scope: client; sensitive");
    expect(printed).toContain("  version");
    expect(printed).toContain("    Type: number; Default: 1; Scope: client, daemon, server; internal");
    expect(printed).toContain("Delete config files from cwd ancestry and $CLIMON_HOME");
  });

  test("prints config help with short help flag", () => {
    const out: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => {
      out.push(String(chunk));
      return true;
    };
    try {
      expect(runConfigCommand(["-h"], env(), root)).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(out.join("")).toContain("climon config — inspect and update climon configuration");
  });

  test("rejects internal registry keys for get and set", () => {
    expect(runConfigCommand(["version"], env(), root)).toBe(2);
    expect(runConfigCommand(["remote.clientId", "client-1"], env(), root)).toBe(2);
  });

  test("rejects help with scope flags", () => {
    expect(runConfigCommand(["--global", "--help"], env(), root)).toBe(2);
    expect(runConfigCommand(["--local", "--help"], env(), root)).toBe(2);
  });

  test("rejects help with other operations", () => {
    expect(runConfigCommand(["--help", "--unset", "remote.port"], env(), root)).toBe(2);
    expect(runConfigCommand(["--help", "remote.port"], env(), root)).toBe(2);
  });

  test("--purge deletes confirmed config files and continues through the cascade", () => {
    const repo = join(root, "repo");
    const nested = join(repo, "src");
    mkdirSync(join(repo, ".climon"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(home, { recursive: true });

    const localConfig = join(repo, ".climon", "config.jsonc");
    const localLegacy = join(repo, ".climon", "config.json");
    const globalConfig = join(home, "config.jsonc");
    writeFileSync(localConfig, "{}");
    writeFileSync(localLegacy, "{}");
    writeFileSync(globalConfig, "{}");

    const out: string[] = [];
    const result = runConfigCommand(["--purge"], env(), nested, {
      stdout: (chunk) => out.push(chunk),
      stderr: () => undefined,
      confirm: () => true
    });

    expect(result).toBe(0);
    expect(existsSync(localConfig)).toBe(false);
    expect(existsSync(localLegacy)).toBe(false);
    expect(existsSync(globalConfig)).toBe(false);
    expect(out.join("")).toContain(`Delete ${localConfig}?`);
    expect(out.join("")).toContain(`Deleted ${localConfig}`);
    expect(out.join("")).toContain(`Delete ${localLegacy}?`);
    expect(out.join("")).toContain(`Delete ${globalConfig}?`);
  });

  test("--purge exits immediately when a config deletion is declined", () => {
    const repo = join(root, "repo");
    const nested = join(repo, "src");
    mkdirSync(join(repo, ".climon"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(home, { recursive: true });

    const localConfig = join(repo, ".climon", "config.jsonc");
    const globalConfig = join(home, "config.jsonc");
    writeFileSync(localConfig, "{}");
    writeFileSync(globalConfig, "{}");

    let promptCount = 0;
    const out: string[] = [];
    const result = runConfigCommand(["--purge"], env(), nested, {
      stdout: (chunk) => out.push(chunk),
      stderr: () => undefined,
      confirm: () => {
        promptCount += 1;
        return false;
      }
    });

    expect(result).toBe(0);
    expect(promptCount).toBe(1);
    expect(existsSync(localConfig)).toBe(true);
    expect(existsSync(globalConfig)).toBe(true);
    expect(out.join("")).toContain("Purge cancelled.");
  });

  test("--purge succeeds when no config files exist", () => {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    const out: string[] = [];
    const result = runConfigCommand(["--purge"], env(), repo, {
      stdout: (chunk) => out.push(chunk),
      stderr: () => undefined,
      confirm: () => {
        throw new Error("confirm should not be called");
      }
    });

    expect(result).toBe(0);
    expect(out.join("")).toContain("No climon config files found.");
  });
});
