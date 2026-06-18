import { describe, expect, test } from "bun:test";
import { zipEntryNamesForPlatform } from "../scripts/compile.js";

describe("zipEntryNamesForPlatform", () => {
  test("includes install.exe, climon-server.exe, climon-alpha, and climon-beta in the Windows zip", () => {
    expect(zipEntryNamesForPlatform("windows-x64")).toEqual([
      "install.exe",
      "climon-server.exe",
      "climon-beta",
      "climon-alpha"
    ]);
  });

  test("includes install, climon-server, climon-alpha, and climon-beta in the macOS zip", () => {
    expect(zipEntryNamesForPlatform("darwin-x64")).toEqual([
      "install",
      "climon-server",
      "climon-beta",
      "climon-alpha"
    ]);

    expect(zipEntryNamesForPlatform("darwin-arm64")).toEqual([
      "install",
      "climon-server",
      "climon-beta",
      "climon-alpha"
    ]);
  });

  test("includes install, climon-server, climon-alpha, and climon-beta in Linux zips", () => {
    expect(zipEntryNamesForPlatform("linux-x64")).toEqual([
      "install",
      "climon-server",
      "climon-beta",
      "climon-alpha"
    ]);
  });
});
