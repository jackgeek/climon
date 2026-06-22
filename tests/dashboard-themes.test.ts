import { describe, expect, test } from "bun:test";
import * as xtermTheme from "xterm-theme";
import { THEME_NAMES, DEFAULT_THEME_NAME, isThemeName } from "../src/dashboard-preference-keys.js";
import { DASHBOARD_THEMES, getTheme } from "../src/web/themes.js";

describe("dashboard theme registry", () => {
  test("registry names match the shared THEME_NAMES in order", () => {
    expect(DASHBOARD_THEMES.map((t) => t.name)).toEqual([...THEME_NAMES]);
  });

  test("default theme is first and is the documented default", () => {
    expect(DASHBOARD_THEMES[0].name).toBe(DEFAULT_THEME_NAME);
    expect(DASHBOARD_THEMES[0].xterm.background).toBe("#0d1117");
  });

  test("exposes the whole bundled set (156 package themes + default)", () => {
    expect(DASHBOARD_THEMES.length).toBe(157);
  });

  test("every theme has a background, a light/dark base, and a non-empty name", () => {
    for (const theme of DASHBOARD_THEMES) {
      expect(typeof theme.xterm.background).toBe("string");
      expect(["light", "dark"]).toContain(theme.base);
      expect(theme.name.length).toBeGreaterThan(0);
      expect(isThemeName(theme.name)).toBe(true);
    }
  });

  test("all names are unique", () => {
    const names = DASHBOARD_THEMES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("both light and dark bases are present", () => {
    expect(DASHBOARD_THEMES.some((t) => t.base === "light")).toBe(true);
    expect(DASHBOARD_THEMES.some((t) => t.base === "dark")).toBe(true);
  });

  test("getTheme falls back to default for an unknown name", () => {
    expect(getTheme("nope").name).toBe(DEFAULT_THEME_NAME);
    expect(getTheme(undefined).name).toBe(DEFAULT_THEME_NAME);
    expect(getTheme("dracula").name).toBe(DEFAULT_THEME_NAME); // old kebab id no longer valid
  });

  test("getTheme resolves a known display name", () => {
    expect(getTheme("Dracula").name).toBe("Dracula");
    expect(getTheme("Adventure Time").name).toBe("Adventure Time");
  });

  test("drift guard: registry covers every package export except its own default", () => {
    const expected = Object.keys(xtermTheme as Record<string, unknown>).filter(
      (name) =>
        name !== "default" &&
        name !== "__esModule" &&
        typeof (xtermTheme as Record<string, unknown>)[name] === "object" &&
        (xtermTheme as Record<string, unknown>)[name] !== null &&
        !Array.isArray((xtermTheme as Record<string, unknown>)[name])
    ).length;
    expect(DASHBOARD_THEMES.length).toBe(expected + 1);
  });
});
