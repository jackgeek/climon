import { describe, expect, test } from "bun:test";
import { zipEntryNamesForPlatform } from "../scripts/compile.js";

describe("legacy layout packaging", () => {
  test("legacy Windows zip has climon.exe + climon-server.exe and no dll/installer", () => {
    const names = zipEntryNamesForPlatform("windows-x64", { legacy: true });
    expect(names).toEqual(["climon.exe", "climon-server.exe"]);
    expect(names).not.toContain("climon.dll");
    expect(names).not.toContain("install.exe");
  });

  test("stub Windows zip is unchanged (install.exe + climon.dll + server)", () => {
    const names = zipEntryNamesForPlatform("windows-x64");
    expect(names).toEqual(["install.exe", "climon.dll", "climon-server.exe"]);
  });
});
