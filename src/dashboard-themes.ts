/**
 * Single source of truth for dashboard terminal themes. Derives the full theme
 * registry at runtime from the bundled `xterm-theme` package so the config
 * validator, the web picker, and the menu can never disagree about which theme
 * ids exist. Imported by `src/dashboard-preference-keys.ts` (ids/validation) and
 * `src/web/themes.ts` (colours).
 */
import type { ITheme } from "@xterm/xterm";
import * as xtermTheme from "xterm-theme";

export interface DashboardTheme {
  id: string;
  label: string;
  xterm: ITheme;
  base: "light" | "dark";
}

/** Built-in "Default" look: the historical un-themed terminal background. */
const DEFAULT_XTERM: ITheme = { background: "#0d1117" };

export const DEFAULT_THEME_ID = "default";

/** Relative luminance of a #rrggbb colour (0 = black, 1 = white). */
function luminance(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) {
    return 0;
  }
  const int = Number.parseInt(m[1], 16);
  const r = ((int >> 16) & 0xff) / 255;
  const g = ((int >> 8) & 0xff) / 255;
  const b = (int & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function baseFor(theme: ITheme): "light" | "dark" {
  return luminance(theme.background ?? "#000000") > 0.5 ? "light" : "dark";
}

/** kebab id: camelCase + underscore boundaries -> lower-kebab. */
export function toThemeId(exportName: string): string {
  return exportName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Human label: split words, preserve existing caps, capitalise first char. */
export function toThemeLabel(exportName: string): string {
  const spaced = exportName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const PACKAGE = xtermTheme as Record<string, unknown>;

function packageThemes(): DashboardTheme[] {
  return Object.keys(PACKAGE)
    .filter((name) => name !== "default" && name !== "__esModule")
    .map((name) => [name, PACKAGE[name]] as const)
    .filter(([, value]) => typeof value === "object" && value !== null && !Array.isArray(value))
    .map(([name, value]) => {
      const xterm = value as ITheme;
      return { id: toThemeId(name), label: toThemeLabel(name), xterm, base: baseFor(xterm) };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export const DASHBOARD_THEMES: DashboardTheme[] = [
  { id: DEFAULT_THEME_ID, label: "Default", xterm: DEFAULT_XTERM, base: baseFor(DEFAULT_XTERM) },
  ...packageThemes()
];

export const THEME_IDS = DASHBOARD_THEMES.map((t) => t.id);

export type ThemeId = string;

const BY_ID = new Map<string, DashboardTheme>(DASHBOARD_THEMES.map((t) => [t.id, t]));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && BY_ID.has(value);
}

export function getTheme(id: string | null | undefined): DashboardTheme {
  return (id && BY_ID.get(id)) || BY_ID.get(DEFAULT_THEME_ID)!;
}
