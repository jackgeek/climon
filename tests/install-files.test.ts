import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installBinaries } from "../src/install/files.js";

const tempRoot = join(process.cwd(), ".copilot-tmp", "install-files-test");
const tempDirs: string[] = [];
let tempDirId = 0;

function makeTempDir(): string {
  const dir = join(tempRoot, `${process.pid}-${tempDirId++}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("installBinaries", () => {
  test("copies climon.exe and climon-server.exe into the install directory", () => {
    const sourceDir = makeTempDir();
    const installDir = join(makeTempDir(), "Programs", "climon");
    writeFileSync(join(sourceDir, "climon.exe"), "client");
    writeFileSync(join(sourceDir, "climon-server.exe"), "server");

    installBinaries(sourceDir, installDir);

    expect(readFileSync(join(installDir, "climon.exe"), "utf8")).toBe("client");
    expect(readFileSync(join(installDir, "climon-server.exe"), "utf8")).toBe("server");
  });

  test("throws when a required sibling binary is missing", () => {
    const sourceDir = makeTempDir();
    const installDir = join(makeTempDir(), "Programs", "climon");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "climon.exe"), "client");

    expect(() => installBinaries(sourceDir, installDir))
      .toThrow("Required installer sibling is missing: climon-server.exe");
  });
});
