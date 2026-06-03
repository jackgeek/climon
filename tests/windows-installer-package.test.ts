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

  test("does not include Setup.exe in non-Windows zips", () => {
    expect(zipEntryNamesForPlatform("linux-x64")).toEqual([
      "climon",
      "climon-server"
    ]);
  });
});
