import { describe, expect, test } from "bun:test";
import { splitCommand } from "../src/server/server.js";

describe("splitCommand", () => {
  test("splits on whitespace", () => {
    expect(splitCommand("npm run dev")).toEqual(["npm", "run", "dev"]);
  });

  test("collapses runs of whitespace and trims", () => {
    expect(splitCommand("  npm   test  ")).toEqual(["npm", "test"]);
  });

  test("returns empty array for blank input", () => {
    expect(splitCommand("   ")).toEqual([]);
  });
});
