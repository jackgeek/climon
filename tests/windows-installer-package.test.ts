import { describe, expect, test } from "bun:test";
import { zipEntryNamesForPlatform } from "../scripts/compile.js";

describe("zipEntryNamesForPlatform", () => {
  test("includes install.exe, climon.dll, and climon-server.exe in the Windows zip", () => {
    expect(zipEntryNamesForPlatform("windows-x64")).toEqual([
      "install.exe",
      "climon.dll",
      "climon-server.exe"
    ]);
  });

  test("includes install, climon, and climon-server in macOS zips", () => {
    expect(zipEntryNamesForPlatform("darwin-x64")).toEqual([
      "install",
      "climon",
      "climon-server"
    ]);

    expect(zipEntryNamesForPlatform("darwin-arm64")).toEqual([
      "install",
      "climon",
      "climon-server"
    ]);
  });

  test("includes install, climon, and climon-server in the Linux x64 zip", () => {
    expect(zipEntryNamesForPlatform("linux-x64")).toEqual([
      "install",
      "climon",
      "climon-server"
    ]);
  });
});
