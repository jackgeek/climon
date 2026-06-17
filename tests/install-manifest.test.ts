import { describe, expect, test } from "bun:test";
import { installFilesForPlatform } from "../src/install/install-manifest.js";

describe("install manifest", () => {
  test("unix installs climon + climon-beta from bare source names", () => {
    expect(installFilesForPlatform("linux")).toEqual([
      { source: "install", dest: "climon" },
      { source: "climon-beta", dest: "climon-beta" },
    ]);
  });

  test("windows installs .exe variants", () => {
    expect(installFilesForPlatform("win32")).toEqual([
      { source: "install.exe", dest: "climon.exe" },
      { source: "climon-beta", dest: "climon-beta" },
    ]);
  });

  test("darwin matches the unix layout", () => {
    expect(installFilesForPlatform("darwin")).toEqual(
      installFilesForPlatform("linux")
    );
  });
});
