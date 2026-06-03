import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClientInvocation } from "../src/cli/client-exec.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "climon-cliexec-"));
}

describe("resolveClientInvocation", () => {
  test("honors CLIMON_CLIENT_BIN override", () => {
    const env = { CLIMON_CLIENT_BIN: "/opt/climon" } as NodeJS.ProcessEnv;
    expect(resolveClientInvocation(["run", "--headless", "echo", "hi"], env, "/usr/bin/climon-server")).toEqual({
      file: "/opt/climon",
      args: ["run", "--headless", "echo", "hi"]
    });
  });

  test("prefers a sibling climon binary", () => {
    const dir = tmp();
    const sibling = join(dir, "climon");
    writeFileSync(sibling, "");
    const execPath = join(dir, "climon-server");
    expect(resolveClientInvocation(["run"], {} as NodeJS.ProcessEnv, execPath, undefined, "linux")).toEqual({
      file: sibling,
      args: ["run"]
    });
  });

  test("prefers a sibling climon.exe on win32", () => {
    const dir = tmp();
    const sibling = join(dir, "climon.exe");
    writeFileSync(sibling, "");
    const execPath = join(dir, "climon-server.exe");
    expect(resolveClientInvocation(["run"], {} as NodeJS.ProcessEnv, execPath, undefined, "win32")).toEqual({
      file: sibling,
      args: ["run"]
    });
  });

  test("falls back to the dev entrypoint via execPath", () => {
    const dir = tmp();
    const devEntry = join(dir, "index.ts");
    writeFileSync(devEntry, "");
    const execPath = join(dir, "bun");
    expect(resolveClientInvocation(["run"], {} as NodeJS.ProcessEnv, execPath, devEntry)).toEqual({
      file: execPath,
      args: [devEntry, "run"]
    });
  });

  test("falls back to bare name on PATH when nothing else resolves", () => {
    const dir = tmp();
    const execPath = join(dir, "climon-server");
    expect(resolveClientInvocation(["run"], {} as NodeJS.ProcessEnv, execPath, undefined, "linux")).toEqual({
      file: "climon",
      args: ["run"]
    });
  });
});
