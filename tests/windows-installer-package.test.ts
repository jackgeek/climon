import { describe, expect, test } from "bun:test";
import { zipEntryNamesForPlatform } from "../scripts/compile.js";

describe("zipEntryNamesForPlatform", () => {
  test("includes climon-installer in the Windows zip", () => {
    expect(zipEntryNamesForPlatform("windows-x64")).toEqual([
      "climon.exe",
      "climon-server",
      "climon-installer"
    ]);
  });

  test("includes climon-installer in the macOS zip", () => {
    expect(zipEntryNamesForPlatform("darwin-x64")).toEqual([
      "climon",
      "climon-server",
      "climon-installer"
    ]);

    expect(zipEntryNamesForPlatform("darwin-arm64")).toEqual([
      "climon",
      "climon-server",
      "climon-installer"
    ]);
  });

  test("includes climon-installer in Linux zips", () => {
    expect(zipEntryNamesForPlatform("linux-x64")).toEqual([
      "climon",
      "climon-server",
      "climon-installer"
    ]);
  });
});
