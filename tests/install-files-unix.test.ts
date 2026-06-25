import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installBinaries, isLockedBinaryCopyError } from "../src/install/files-unix.js";

const tempRoot = join(process.cwd(), ".copilot-tmp", "install-files-unix-test");
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

describe("installBinaries (Unix)", () => {
  test("copies install as climon and climon-server into the install directory", async () => {
    const sourceDir = makeTempDir();
    const installDir = join(makeTempDir(), ".local", "bin");
    writeFileSync(join(sourceDir, "install"), "client");
    writeFileSync(join(sourceDir, "climon-server"), "server");

    await installBinaries(sourceDir, installDir);

    expect(readFileSync(join(installDir, "climon"), "utf8")).toBe("client");
    expect(readFileSync(join(installDir, "climon-server"), "utf8")).toBe("server");
  });

  test("throws when a required sibling binary is missing", async () => {
    const sourceDir = makeTempDir();
    const installDir = join(makeTempDir(), ".local", "bin");
    writeFileSync(join(sourceDir, "install"), "client");

    await expect(installBinaries(sourceDir, installDir))
      .rejects.toThrow("Required installer sibling is missing: climon-server");
  });

  test("identifies Unix locked-file copy errors including ETXTBSY", () => {
    expect(isLockedBinaryCopyError(Object.assign(new Error("busy"), { code: "EBUSY" }))).toBe(true);
    expect(isLockedBinaryCopyError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(true);
    expect(isLockedBinaryCopyError(Object.assign(new Error("permission"), { code: "EPERM" }))).toBe(true);
    expect(isLockedBinaryCopyError(Object.assign(new Error("text busy"), { code: "ETXTBSY" }))).toBe(true);
    expect(isLockedBinaryCopyError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(false);
  });

  test("prompts to kill processes and retries on locked binary", async () => {
    const sourceDir = makeTempDir();
    const installDir = join(makeTempDir(), ".local", "bin");
    writeFileSync(join(sourceDir, "install"), "client");
    writeFileSync(join(sourceDir, "climon-server"), "server");
    let climonAttempts = 0;
    let prompted = 0;
    let killed = 0;

    await installBinaries(sourceDir, installDir, {
      copyFile(source, destination) {
        if (destination.endsWith("climon") && climonAttempts++ === 0) {
          throw Object.assign(new Error("text busy"), { code: "ETXTBSY" });
        }
        writeFileSync(destination, readFileSync(source));
      },
      async confirmKillAndRetry() {
        prompted++;
        return true;
      },
      async killRunningClimonProcesses() {
        killed++;
      }
    });

    expect(prompted).toBe(1);
    expect(killed).toBe(1);
    expect(readFileSync(join(installDir, "climon"), "utf8")).toBe("client");
    expect(readFileSync(join(installDir, "climon-server"), "utf8")).toBe("server");
  });
});
