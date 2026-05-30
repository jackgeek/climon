import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyConfig,
  coerceValue,
  parseConfigArgs,
  runConfigCommand,
  validateKey
} from "../src/cli/config-cmd.js";
import { defaultConfig } from "../src/config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "climon-cfgcmd-"));
}

describe("parseConfigArgs", () => {
  test("defaults to global scope get", () => {
    expect(parseConfigArgs(["remote.host"])).toEqual({ action: "get", scope: "global", key: "remote.host" });
  });
  test("parses local set", () => {
    expect(parseConfigArgs(["--local", "remote.host", "h"])).toEqual({ action: "set", scope: "local", key: "remote.host", value: "h" });
  });
  test("parses list", () => {
    expect(parseConfigArgs(["--list"])).toEqual({ action: "list", scope: "global" });
  });
  test("parses unset", () => {
    expect(parseConfigArgs(["--unset", "remote.port"])).toEqual({ action: "unset", scope: "global", key: "remote.port" });
  });
  test("rejects unknown keys", () => {
    expect(() => parseConfigArgs(["server.token"])).toThrow();
  });
});

describe("coerceValue", () => {
  test("coerces boolean", () => {
    expect(coerceValue("remote.enabled", "true")).toBe(true);
    expect(coerceValue("remote.enabled", "false")).toBe(false);
    expect(() => coerceValue("remote.enabled", "yes")).toThrow();
  });
  test("coerces positive integer port", () => {
    expect(coerceValue("remote.port", "22")).toBe(22);
    expect(() => coerceValue("remote.port", "0")).toThrow();
    expect(() => coerceValue("remote.port", "x")).toThrow();
  });
  test("passes strings through", () => {
    expect(coerceValue("remote.host", "home.example.com")).toBe("home.example.com");
  });
});

describe("applyConfig", () => {
  test("set then get round-trips", () => {
    const base = defaultConfig();
    const { config } = applyConfig(base, { action: "set", scope: "global", key: "remote.host", value: "h" });
    expect(applyConfig(config, { action: "get", scope: "global", key: "remote.host" }).output).toBe("h");
  });
  test("get missing returns code 1", () => {
    expect(applyConfig(defaultConfig(), { action: "get", scope: "global", key: "remote.host" }).code).toBe(1);
  });
  test("unset removes a key", () => {
    let config = applyConfig(defaultConfig(), { action: "set", scope: "global", key: "remote.user", value: "alice" }).config;
    config = applyConfig(config, { action: "unset", scope: "global", key: "remote.user" }).config;
    expect(config.remote?.user).toBeUndefined();
  });
  test("list shows set keys", () => {
    const config = applyConfig(defaultConfig(), { action: "set", scope: "global", key: "remote.host", value: "h" }).config;
    expect(applyConfig(config, { action: "list", scope: "global" }).output).toBe("remote.host=h");
  });
  test("validateKey rejects junk", () => {
    expect(() => validateKey("nope")).toThrow();
  });
});

describe("runConfigCommand", () => {
  test("global scope writes ~/.climon (CLIMON_HOME) config.json", () => {
    const home = tmp();
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    expect(runConfigCommand(["--global", "remote.host", "home.example.com"], env, "/")).toBe(0);
    const written = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(written.remote.host).toBe("home.example.com");
  });

  test("local scope writes ./.climon/config.json", () => {
    const cwd = tmp();
    const env = {} as NodeJS.ProcessEnv;
    expect(runConfigCommand(["--local", "remote.enabled", "true"], env, cwd)).toBe(0);
    expect(existsSync(join(cwd, ".climon", "config.json"))).toBe(true);
    const written = JSON.parse(readFileSync(join(cwd, ".climon", "config.json"), "utf8"));
    expect(written.remote.enabled).toBe(true);
  });

  test("known-host pins a host key line into known_hosts (idempotent)", () => {
    const cwd = tmp();
    const env = {} as NodeJS.ProcessEnv;
    const line = "home.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5";
    expect(runConfigCommand(["--local", "known-host", line], env, cwd)).toBe(0);
    expect(runConfigCommand(["--local", "known-host", line], env, cwd)).toBe(0);
    const known = readFileSync(join(cwd, ".climon", "known_hosts"), "utf8");
    expect(known.match(/AAAAC3NzaC1lZDI1NTE5/g)?.length).toBe(1);
  });
});
