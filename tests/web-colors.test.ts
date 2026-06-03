import { describe, expect, test } from "bun:test";
import { ANSI_CSS, ANSI_HIGHLIGHT_CSS } from "../src/web/colors.js";
import { ANSI_COLORS } from "../src/session-meta.js";

describe("ANSI_CSS", () => {
  test("maps every ANSI color to a hex value", () => {
    for (const color of ANSI_COLORS) {
      expect(ANSI_CSS[color]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test("maps every ANSI color to a highlighted hex value", () => {
    for (const color of ANSI_COLORS) {
      expect(ANSI_HIGHLIGHT_CSS[color]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test("uses distinct highlighted colors for selected accents", () => {
    expect(ANSI_HIGHLIGHT_CSS.blue).toBe("#729fcf");
    expect(ANSI_HIGHLIGHT_CSS.blue).not.toBe(ANSI_CSS.blue);
  });
});
