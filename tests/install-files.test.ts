import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installBinaries, isLockedBinaryCopyError } from "../src/install/files.js";

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
  test("copies climon.exe and climon-server into the install directory", async () => {
    const sourceDir = makeTempDir();
    const installDir = join(makeTempDir(), "Programs", "climon");
    writeFileSync(join(sourceDir, "climon.exe"), "client");
    writeFileSync(join(sourceDir, "climon-server"), "server");

    await installBinaries(sourceDir, installDir);

    expect(readFileSync(join(installDir, "climon.exe"), "utf8")).toBe("client");
    expect(readFileSync(join(installDir, "climon-server"), "utf8")).toBe("server");
  });

  test("throws when a required sibling binary is missing", async () => {
    const sourceDir = makeTempDir();
    const installDir = join(makeTempDir(), "Programs", "climon");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "climon.exe"), "client");

    await expect(installBinaries(sourceDir, installDir))
      .rejects.toThrow("Required installer sibling is missing: climon-server");
  });

  test("identifies Windows locked-file copy errors", () => {
    expect(isLockedBinaryCopyError(Object.assign(new Error("busy"), { code: "EBUSY" }))).toBe(true);
    expect(isLockedBinaryCopyError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(true);
    expect(isLockedBinaryCopyError(Object.assign(new Error("permission"), { code: "EPERM" }))).toBe(true);
    expect(isLockedBinaryCopyError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(false);
  });

  test("prompts to kill climon processes and retries when an installed binary is locked", async () => {
    const sourceDir = makeTempDir();
    const installDir = join(makeTempDir(), "Programs", "climon");
    writeFileSync(join(sourceDir, "climon.exe"), "client");
    writeFileSync(join(sourceDir, "climon-server"), "server");
    const copied: string[] = [];
    let climonAttempts = 0;
    let prompted = 0;
    let killed = 0;

    await installBinaries(sourceDir, installDir, {
      copyFile(source, destination) {
        copied.push(destination);
        if (destination.endsWith("climon.exe") && climonAttempts++ === 0) {
          throw Object.assign(new Error("locked"), { code: "EBUSY" });
        }
        writeFileSync(destination, readFileSync(source));
      },
      async confirmKillAndRetry(error) {
        prompted++;
        expect(isLockedBinaryCopyError(error)).toBe(true);
        return true;
      },
      async killRunningClimonProcesses() {
        killed++;
      }
    });

    expect(prompted).toBe(1);
    expect(killed).toBe(1);
    expect(copied.filter((path) => path.endsWith("climon.exe")).length).toBe(2);
    expect(readFileSync(join(installDir, "climon.exe"), "utf8")).toBe("client");
    expect(readFileSync(join(installDir, "climon-server"), "utf8")).toBe("server");
  });

  test("does not retry a locked installed binary when the user declines process termination", async () => {
    const sourceDir = makeTempDir();
    const installDir = join(makeTempDir(), "Programs", "climon");
    writeFileSync(join(sourceDir, "climon.exe"), "client");
    writeFileSync(join(sourceDir, "climon-server"), "server");
    let killed = 0;

    await expect(installBinaries(sourceDir, installDir, {
      copyFile() {
        throw Object.assign(new Error("locked"), { code: "EPERM" });
      },
      async confirmKillAndRetry() {
        return false;
      },
      async killRunningClimonProcesses() {
        killed++;
      }
    })).rejects.toThrow("locked");

    expect(killed).toBe(0);
  });
});
