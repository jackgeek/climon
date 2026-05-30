import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { findAncestorClimonDir, loadRemoteConfig, resolveRemoteConfigDir } from "../src/config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "climon-remote-"));
}

function writeClimon(dir: string, remote: unknown): string {
  const climon = join(dir, ".climon");
  mkdirSync(climon, { recursive: true });
  writeFileSync(join(climon, "config.json"), JSON.stringify({ version: 1, server: { host: "127.0.0.1", port: 3131 }, terminal: { clampBrowserToHost: true }, remote }));
  return climon;
}

const noHome = {} as NodeJS.ProcessEnv;

describe("findAncestorClimonDir", () => {
  test("finds .climon in the start dir", () => {
    const root = tmp();
    const climon = writeClimon(root, { enabled: true });
    expect(findAncestorClimonDir(root)).toBe(climon);
  });

  test("walks up to an ancestor .climon", () => {
    const root = tmp();
    const climon = writeClimon(root, { enabled: true });
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(findAncestorClimonDir(nested)).toBe(climon);
  });

  test("returns undefined when none found", () => {
    const root = tmp();
    expect(findAncestorClimonDir(root)).toBeUndefined();
  });
});

describe("resolveRemoteConfigDir", () => {
  test("CLIMON_HOME overrides ancestor discovery", () => {
    const root = tmp();
    writeClimon(root, { enabled: true });
    const env = { CLIMON_HOME: "/tmp/forced-home" } as NodeJS.ProcessEnv;
    expect(resolveRemoteConfigDir(env, root)).toBe("/tmp/forced-home");
  });

  test("nearest ancestor wins when no CLIMON_HOME", () => {
    const root = tmp();
    const climon = writeClimon(root, { enabled: true });
    expect(resolveRemoteConfigDir(noHome, root)).toBe(climon);
  });

  test("falls back to ~/.climon when nothing found", () => {
    const root = tmp();
    expect(resolveRemoteConfigDir(noHome, root)).toBe(join(homedir(), ".climon"));
  });
});

describe("loadRemoteConfig", () => {
  test("reads the remote section from the nearest .climon", () => {
    const root = tmp();
    writeClimon(root, { enabled: true, host: "home.example.com", port: 22, user: "alice", hostKey: "ssh-ed25519 AAAA", keyFile: "id_climon" });
    const { remote } = loadRemoteConfig(noHome, root);
    expect(remote?.enabled).toBe(true);
    expect(remote?.host).toBe("home.example.com");
  });

  test("returns the resolved dir with undefined remote when absent", () => {
    const root = tmp();
    const { dir, remote } = loadRemoteConfig(noHome, root);
    expect(dir).toBe(join(homedir(), ".climon"));
    expect(remote).toBeUndefined();
  });
});
