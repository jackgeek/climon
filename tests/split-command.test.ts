import { describe, expect, test } from "bun:test";
import { browserResizePayload, splitCommand } from "../src/server/server.js";

describe("splitCommand", () => {
  test("splits on whitespace", () => {
    expect(splitCommand("npm run dev")).toEqual(["npm", "run", "dev"]);
  });

  describe("browserResizePayload", () => {
    test("carries only cols and rows for routine browser resize messages", () => {
      expect(browserResizePayload({ cols: 120, rows: 40 })).toEqual({
        cols: 120,
        rows: 40
      });
    });

    test("preserves the surface kind and viewer id when present", () => {
      expect(browserResizePayload({ cols: 120, rows: 40, kind: "dashboard", viewerId: "v1" })).toEqual({
        cols: 120,
        rows: 40,
        kind: "dashboard",
        viewerId: "v1"
      });
    });

    test("returns null for a zero-sized resize", () => {
      expect(browserResizePayload({ cols: 0, rows: 40 })).toBeNull();
    });
  });

  test("collapses runs of whitespace and trims", () => {
    expect(splitCommand("  npm   test  ")).toEqual(["npm", "test"]);
  });

  test("returns empty array for blank input", () => {
    expect(splitCommand("   ")).toEqual([]);
  });
});
