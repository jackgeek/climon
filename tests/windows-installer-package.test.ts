import { describe, expect, test } from "bun:test";
import { zipEntryNamesForPlatform } from "../scripts/compile.js";

describe("zipEntryNamesForPlatform", () => {
  test("includes Setup.exe in the Windows zip", () => {
    expect(zipEntryNamesForPlatform("windows-x64")).toEqual([
      "climon.exe",
      "climon-server.exe",
      "Setup.exe"
    ]);
  });

  test("includes install-climon in the macOS zip", () => {
    expect(zipEntryNamesForPlatform("darwin-x64")).toEqual([
      "climon",
      "climon-server",
      "install-climon"
    ]);

    expect(zipEntryNamesForPlatform("darwin-arm64")).toEqual([
      "climon",
      "climon-server",
      "install-climon"
    ]);
  });

  test("does not include installer in Linux zips", () => {
    expect(zipEntryNamesForPlatform("linux-x64")).toEqual([
      "climon",
      "climon-server"
    ]);
  });
});
