import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegateToServer, resolveServerInvocation } from "../src/cli/server-exec.js";

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
    expect(resolveServerInvocation(["server"], {} as NodeJS.ProcessEnv, execPath)).toEqual({
      file: sibling,
      args: ["server"]
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
    expect(resolveServerInvocation(["server"], {} as NodeJS.ProcessEnv, execPath)).toEqual({
      file: "climon-server",
      args: ["server"]
    });
  });
});

describe("delegateToServer", () => {
  test("returns 127 and warns when the server binary is missing", () => {
    const env = {
      CLIMON_SERVER_BIN: "/nonexistent/climon-server-xyz"
    } as NodeJS.ProcessEnv;
    expect(delegateToServer(["server"], env, "/usr/bin/climon")).toBe(127);
  });
});
