import { describe, expect, test } from "bun:test";
import { THEME_IDS, DEFAULT_THEME_ID } from "../src/dashboard-preference-keys.js";
import { DASHBOARD_THEMES, getTheme } from "../src/web/themes.js";

describe("dashboard theme registry", () => {
  test("registry ids match the shared THEME_IDS in order", () => {
    expect(DASHBOARD_THEMES.map((t) => t.id)).toEqual([...THEME_IDS]);
  });

  test("default theme is first and is the documented default", () => {
    expect(DASHBOARD_THEMES[0].id).toBe(DEFAULT_THEME_ID);
    expect(DASHBOARD_THEMES[0].xterm.background).toBe("#0d1117");
  });

  test("every theme has a background and a light/dark base", () => {
    for (const theme of DASHBOARD_THEMES) {
      expect(typeof theme.xterm.background).toBe("string");
      expect(["light", "dark"]).toContain(theme.base);
    }
  });

  test("getTheme falls back to default for an unknown id", () => {
    expect(getTheme("nope").id).toBe(DEFAULT_THEME_ID);
    expect(getTheme("dracula").id).toBe("dracula");
  });

  test("includes at least one light theme to exercise the Fluent base swap", () => {
    expect(DASHBOARD_THEMES.some((t) => t.base === "light")).toBe(true);
  });
});
