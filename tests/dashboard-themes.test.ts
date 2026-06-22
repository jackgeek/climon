import { describe, expect, test } from "bun:test";
import * as xtermTheme from "xterm-theme";
import { THEME_IDS, DEFAULT_THEME_ID, isThemeId } from "../src/dashboard-preference-keys.js";
import { DASHBOARD_THEMES, getTheme } from "../src/web/themes.js";

describe("dashboard theme registry", () => {
  test("registry ids match the shared THEME_IDS in order", () => {
    expect(DASHBOARD_THEMES.map((t) => t.id)).toEqual([...THEME_IDS]);
  });

  test("default theme is first and is the documented default", () => {
    expect(DASHBOARD_THEMES[0].id).toBe(DEFAULT_THEME_ID);
    expect(DASHBOARD_THEMES[0].xterm.background).toBe("#0d1117");
  });

  test("exposes the whole bundled set (156 package themes + default)", () => {
    expect(DASHBOARD_THEMES.length).toBe(157);
  });

  test("every theme has a background, a light/dark base, and a valid kebab id", () => {
    for (const theme of DASHBOARD_THEMES) {
      expect(typeof theme.xterm.background).toBe("string");
      expect(["light", "dark"]).toContain(theme.base);
      expect(theme.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(isThemeId(theme.id)).toBe(true);
    }
  });

  test("all ids are unique", () => {
    const ids = DASHBOARD_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("both light and dark bases are present", () => {
    expect(DASHBOARD_THEMES.some((t) => t.base === "light")).toBe(true);
    expect(DASHBOARD_THEMES.some((t) => t.base === "dark")).toBe(true);
  });

  test("getTheme falls back to default for an unknown id", () => {
    expect(getTheme("nope").id).toBe(DEFAULT_THEME_ID);
    expect(getTheme(undefined).id).toBe(DEFAULT_THEME_ID);
  });

  test("getTheme resolves a known derived id", () => {
    expect(getTheme("dracula").id).toBe("dracula");
  });

  test("drift guard: registry covers every package export except its own default", () => {
    const expected = Object.keys(xtermTheme as Record<string, unknown>).filter(
      (name) =>
        name !== "default" &&
        name !== "__esModule" &&
        typeof (xtermTheme as Record<string, unknown>)[name] === "object" &&
        (xtermTheme as Record<string, unknown>)[name] !== null
    ).length;
    // +1 for the built-in climon default
    expect(DASHBOARD_THEMES.length).toBe(expected + 1);
  });
});
