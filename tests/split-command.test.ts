import { describe, expect, test } from "bun:test";
import { browserResizePayload, splitCommand } from "../src/server/server.js";

describe("splitCommand", () => {
  test("splits on whitespace", () => {
    expect(splitCommand("npm run dev")).toEqual(["npm", "run", "dev"]);
  });

  describe("browserResizePayload", () => {
    test("does not invent a mode for routine browser resize messages", () => {
      expect(browserResizePayload({ cols: 120, rows: 40 })).toEqual({
        cols: 120,
        rows: 40,
        source: "viewer"
      });
    });

    test("preserves explicit browser resize mode changes", () => {
      expect(browserResizePayload({ cols: 120, rows: 40, mode: "fill" })).toEqual({
        cols: 120,
        rows: 40,
        source: "viewer",
        mode: "fill"
      });
    });
  });

  test("collapses runs of whitespace and trims", () => {
    expect(splitCommand("  npm   test  ")).toEqual(["npm", "test"]);
  });

  test("returns empty array for blank input", () => {
    expect(splitCommand("   ")).toEqual([]);
  });
});
