/**
 * Shared constants for the dashboard-preferences mechanism. Imported by both the
 * server-side config registry (`src/config-settings.ts`) and the web UI so the
 * config validator and the picker cannot drift. Theme symbols are re-exported
 * from the single-source-of-truth registry in `./dashboard-themes.js`.
 */

export {
  THEME_NAMES,
  DEFAULT_THEME_NAME,
  isThemeName
} from "./dashboard-themes.js";

/** Config path → dashboard-writable preference. */
export const PREF_THEME = "dashboard.theme";
export const PREF_KEY_BAR_PINNED = "dashboard.keyBarPinned";
export const PREF_STATE_ICON_NO_MOTION = "dashboard.stateIconNoMotion";
