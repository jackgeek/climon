import { describe, expect, test } from "bun:test";
import { parseFileToken, findFileTokens } from "../src/web/file-link.js";

describe("parseFileToken", () => {
  test("parses a bare path", () => {
    expect(parseFileToken("src/index.ts")).toEqual({ path: "src/index.ts" });
  });

  test("parses :line", () => {
    expect(parseFileToken("src/index.ts:42")).toEqual({ path: "src/index.ts", line: 42 });
  });

  test("parses :line:col", () => {
    expect(parseFileToken("src/index.ts:42:7")).toEqual({ path: "src/index.ts", line: 42, col: 7 });
  });

  test("parses an absolute path", () => {
    expect(parseFileToken("/etc/hosts:3")).toEqual({ path: "/etc/hosts", line: 3 });
  });

  test("rejects a bare number / non-path", () => {
    expect(parseFileToken("12345")).toBeNull();
    expect(parseFileToken("just-a-word")).toBeNull();
  });
});

describe("findFileTokens", () => {
  test("locates a token and its offsets in a line", () => {
    const line = "error in src/app.ts:10:2 here";
    const found = findFileTokens(line);
    expect(found.length).toBe(1);
    expect(found[0]).toMatchObject({
      startIndex: line.indexOf("src/app.ts"),
      length: "src/app.ts:10:2".length,
      ref: { path: "src/app.ts", line: 10, col: 2 }
    });
  });

  test("handles long non-path word-runs quickly without false positives", () => {
    // A long run of path-safe chars with no separator/extension must not match,
    // and must scan in linear time (a quadratic scanner would time out here).
    const line = "x".repeat(200000);
    const start = performance.now();
    const found = findFileTokens(line);
    const elapsed = performance.now() - start;
    expect(found).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });
});
