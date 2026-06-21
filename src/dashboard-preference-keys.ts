/**
 * Shared constants for the dashboard-preferences mechanism. Imported by both the
 * server-side config registry (`src/config-settings.ts`) and the web UI so the
 * config validator and the picker cannot drift.
 */

/** Config path → dashboard-writable preference. */
export const PREF_THEME = "dashboard.theme";
export const PREF_KEY_BAR_PINNED = "dashboard.keyBarPinned";

/** Ordered curated terminal-theme ids; first entry is the default. */
export const THEME_IDS = [
  "default",
  "dracula",
  "atom",
  "gruvbox-dark",
  "solarized-dark",
  "tomorrow-night",
  "monokai",
  "material-dark",
  "solarized-light",
  "github",
  "tomorrow"
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME_ID: ThemeId = "default";

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}
