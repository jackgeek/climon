import { describe, expect, test } from "bun:test";
import { ScreenModel } from "../src/drivers/screen-model.js";

describe("ScreenModel", () => {
  test("requires positive integer dimensions", () => {
    expect(() => new ScreenModel(0, 24)).toThrow("Screen dimensions must be positive integers");
    expect(() => new ScreenModel(80.5, 24)).toThrow(
      "Screen dimensions must be positive integers"
    );
    expect(() => new ScreenModel(80, -1)).toThrow("Screen dimensions must be positive integers");
  });

  test("preserves write ordering across concurrent writes", async () => {
    const screen = new ScreenModel(20, 5);

    try {
      const writes = [screen.write("alpha"), screen.write(" "), screen.write("beta")];
      await Promise.all(writes);

      expect(screen.contents()).toBe("alpha beta");
    } finally {
      screen.dispose();
    }
  });

  test("keeps meaningful spaces while trimming only trailing blank lines", async () => {
    const screen = new ScreenModel(12, 6);

    try {
      await screen.write("line 1  \r\n\r\nline 3");

      expect(screen.contents()).toBe("line 1  \n\nline 3");
    } finally {
      screen.dispose();
    }
  });

  test("returns only the visible viewport rows instead of scrollback", async () => {
    const screen = new ScreenModel(5, 2);

    try {
      await screen.write("11111\r\n22222\r\n33333");

      expect(screen.contents()).toBe("22222\n33333");
    } finally {
      screen.dispose();
    }
  });

  test("tracks alternate screen contents and restores the main buffer on exit", async () => {
    const screen = new ScreenModel(20, 8);

    try {
      await screen.write("main screen");
      await screen.write("\x1b[?1049h\x1b[H");
      await screen.write("alt");
      await screen.write("\x1b[2;3H");

      expect(screen.contents()).toBe("alt");
      expect(screen.cursor()).toEqual({ col: 2, row: 1 });

      await screen.write("\x1b[?1049l");

      expect(screen.contents()).toBe("main screen");
    } finally {
      screen.dispose();
    }
  });

  test("applies resize updates to subsequent cursor movement", async () => {
    const screen = new ScreenModel(4, 2);

    try {
      screen.resize(8, 4);
      await screen.write("\x1b[4;8H!");

      expect(screen.cursor()).toEqual({ col: 8, row: 3 });
      expect(screen.contents()).toBe("\n\n\n       !");
    } finally {
      screen.dispose();
    }
  });
});
