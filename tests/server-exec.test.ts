import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegateToServer, resolveServerBundle, resolveServerEnv, resolveServerInvocation } from "../src/cli/server-exec.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "climon-srvexec-"));
}

describe("resolveServerInvocation", () => {
  test("honors CLIMON_SERVER_BIN override", () => {
    const env = { CLIMON_SERVER_BIN: "/opt/climon-server" } as NodeJS.ProcessEnv;
    expect(resolveServerInvocation(["server", "--port", "9000"], env, "/usr/bin/climon")).toEqual({
      file: "/opt/climon-server",
      args: ["server", "--port", "9000"]
    });
  });

  test("prefers a sibling climon-server binary", () => {
    const dir = tmp();
    const sibling = join(dir, "climon-server");
    writeFileSync(sibling, "");
    const execPath = join(dir, "climon");
    expect(resolveServerInvocation(["server"], {} as NodeJS.ProcessEnv, execPath, undefined, "linux")).toEqual({
      file: sibling,
      args: ["server"]
    });
  });

  test("prefers the dev entrypoint over a sibling binary in source mode", () => {
    const dir = tmp();
    const sibling = join(dir, "climon-server");
    const devEntry = join(dir, "server.ts");
    writeFileSync(sibling, "");
    writeFileSync(devEntry, "");
    const execPath = join(dir, "bun");
    expect(resolveServerInvocation(["server"], {} as NodeJS.ProcessEnv, execPath, devEntry, "linux")).toEqual({
      file: execPath,
      args: [devEntry, "server"]
    });
  });

  test("uses a sibling server when no dev entrypoint is available", () => {
    const dir = tmp();
    const sibling = join(dir, "climon-server");
    writeFileSync(sibling, "");
    const execPath = join(dir, "bun");
    expect(resolveServerInvocation(["server"], {} as NodeJS.ProcessEnv, execPath, undefined, "linux")).toEqual({
      file: sibling,
      args: ["server"]
    });
  });

  test("prefers a sibling climon-server.exe on win32", () => {
    const dir = tmp();
    const sibling = join(dir, "climon-server.exe");
    writeFileSync(sibling, "");
    const execPath = join(dir, "climon.exe");
    expect(resolveServerInvocation([], {} as NodeJS.ProcessEnv, execPath, undefined, "win32")).toEqual({
      file: sibling,
      args: []
    });
  });

  test("falls back to the dev entrypoint via execPath", () => {
    const dir = tmp();
    const devEntry = join(dir, "server.ts");
    writeFileSync(devEntry, "");
    const execPath = join(dir, "bun");
    expect(
      resolveServerInvocation(["server"], {} as NodeJS.ProcessEnv, execPath, devEntry)
    ).toEqual({ file: execPath, args: [devEntry, "server"] });
  });

  test("falls back to bare name on PATH when nothing else resolves", () => {
    const dir = tmp();
    const execPath = join(dir, "climon");
    expect(resolveServerInvocation(["server"], {} as NodeJS.ProcessEnv, execPath, undefined, "linux")).toEqual({
      file: "climon-server",
      args: ["server"]
    });
  });
});

describe("resolveServerEnv", () => {
  test("passes the current client executable to the server for dashboard-spawned child sessions", () => {
    const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;

    expect(resolveServerEnv(env, "/opt/climon/bin/climon").CLIMON_CLIENT_BIN).toBe("/opt/climon/bin/climon");
  });

  test("does not overwrite an explicit CLIMON_CLIENT_BIN override", () => {
    const env = { CLIMON_CLIENT_BIN: "/custom/climon" } as NodeJS.ProcessEnv;

    expect(resolveServerEnv(env, "/opt/climon/bin/climon").CLIMON_CLIENT_BIN).toBe("/custom/climon");
  });

  test("does not treat the Bun runtime as the client binary in source mode", () => {
    const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;

    expect(resolveServerEnv(env, "/usr/bin/bun", "/repo/src/server.ts").CLIMON_CLIENT_BIN).toBeUndefined();
  });
});

describe("delegateToServer", () => {
  test("returns 127 and warns when the server binary is missing", async () => {
    const env = {
      CLIMON_SERVER_BIN: "/nonexistent/climon-server-xyz"
    } as NodeJS.ProcessEnv;
    expect(await delegateToServer(["server"], env, "/usr/bin/climon")).toBe(127);
  });
});

describe("resolveServerBundle", () => {
  test("finds a sibling climon-beta next to the executable", () => {
    const dir = tmp();
    const bundle = join(dir, "climon-beta");
    writeFileSync(bundle, "bundle-content");
    const execPath = join(dir, "climon");
    expect(resolveServerBundle({} as NodeJS.ProcessEnv, execPath)).toBe(bundle);
  });

  test("honors CLIMON_SERVER_BUNDLE override", () => {
    const dir = tmp();
    const bundle = join(dir, "custom-server");
    writeFileSync(bundle, "encrypted-content");
    const env = { CLIMON_SERVER_BUNDLE: bundle } as NodeJS.ProcessEnv;
    expect(resolveServerBundle(env, "/some/other/path/climon")).toBe(bundle);
  });

  test("returns undefined when no bundle exists", () => {
    const dir = tmp();
    const execPath = join(dir, "climon");
    expect(resolveServerBundle({} as NodeJS.ProcessEnv, execPath)).toBeUndefined();
  });
});
