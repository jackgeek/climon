import { describe, expect, test } from "bun:test";
import { AUTO_COLOR_ORDER, ANSI_COLORS, parsePriority, parseColor, parseColorMode } from "../src/session-meta.js";

describe("ANSI_COLORS", () => {
  test("is the 8 standard colors in order", () => {
    expect(ANSI_COLORS).toEqual([
      "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"
    ]);
  });
});

describe("AUTO_COLOR_ORDER", () => {
  test("uses the required auto-assignment priority order", () => {
    expect(AUTO_COLOR_ORDER).toEqual([
      "white", "cyan", "magenta", "blue", "yellow", "green", "red", "black"
    ]);
  });
});

describe("parsePriority", () => {
  test("accepts integers within 0–1000", () => {
    expect(parsePriority("0")).toBe(0);
    expect(parsePriority("500")).toBe(500);
    expect(parsePriority("1000")).toBe(1000);
    expect(parsePriority(750)).toBe(750);
  });

  test("rejects out-of-range and non-integer values", () => {
    expect(() => parsePriority("-1")).toThrow(/0 and 1000/);
    expect(() => parsePriority("1001")).toThrow(/0 and 1000/);
    expect(() => parsePriority("12.5")).toThrow(/integer/);
    expect(() => parsePriority("abc")).toThrow(/integer/);
  });
});

describe("parseColor", () => {
  test("accepts the 8 names", () => {
    expect(parseColor("red")).toBe("red");
    expect(parseColor("CYAN")).toBe("cyan");
  });

  test("treats none/empty as null", () => {
    expect(parseColor("none")).toBeNull();
    expect(parseColor("")).toBeNull();
  });

  test("rejects unknown colors", () => {
    expect(() => parseColor("orange")).toThrow(/must be one of/);
  });
});

describe("parseColorMode", () => {
  test("accepts auto, none, and the 8 color names case-insensitively", () => {
    expect(parseColorMode("Auto")).toBe("auto");
    expect(parseColorMode("none")).toBe("none");
    expect(parseColorMode("CYAN")).toBe("cyan");
  });

  test("rejects unknown color modes", () => {
    expect(() => parseColorMode("orange")).toThrow(/must be one of/);
  });
});
