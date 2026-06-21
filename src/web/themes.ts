import type { ITheme } from "@xterm/xterm";
import * as xtermTheme from "xterm-theme";
import { THEME_IDS, DEFAULT_THEME_ID, type ThemeId } from "../dashboard-preference-keys.js";

export interface DashboardTheme {
  id: ThemeId;
  label: string;
  xterm: ITheme;
  base: "light" | "dark";
}

/** Built-in "Default" look: the historical un-themed terminal background. */
const DEFAULT_XTERM: ITheme = { background: "#0d1117" };

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

function baseFor(theme: ITheme): "light" | "dark" {
  return luminance(theme.background ?? "#000000") > 0.5 ? "light" : "dark";
}

const PACKAGE_THEMES = xtermTheme as Record<string, ITheme>;

const SOURCE: Record<ThemeId, { label: string; xterm: ITheme }> = {
  default: { label: "Default", xterm: DEFAULT_XTERM },
  dracula: { label: "Dracula", xterm: PACKAGE_THEMES.Dracula },
  atom: { label: "Atom", xterm: PACKAGE_THEMES.Atom },
  "gruvbox-dark": { label: "Gruvbox Dark", xterm: PACKAGE_THEMES.Gruvbox_Dark },
  "solarized-dark": { label: "Solarized Dark", xterm: PACKAGE_THEMES.Solarized_Dark },
  "tomorrow-night": { label: "Tomorrow Night", xterm: PACKAGE_THEMES.Tomorrow_Night },
  monokai: { label: "Monokai", xterm: PACKAGE_THEMES.Monokai_Soda },
  "material-dark": { label: "Material Dark", xterm: PACKAGE_THEMES.MaterialDark },
  "solarized-light": { label: "Solarized Light", xterm: PACKAGE_THEMES.Solarized_Light },
  github: { label: "GitHub", xterm: PACKAGE_THEMES.Github },
  tomorrow: { label: "Tomorrow", xterm: PACKAGE_THEMES.Tomorrow }
};

export const DASHBOARD_THEMES: DashboardTheme[] = THEME_IDS.map((id) => ({
  id,
  label: SOURCE[id].label,
  xterm: SOURCE[id].xterm,
  base: baseFor(SOURCE[id].xterm)
}));

const BY_ID = new Map<string, DashboardTheme>(DASHBOARD_THEMES.map((t) => [t.id, t]));

export function getTheme(id: string | null | undefined): DashboardTheme {
  return (id && BY_ID.get(id)) || BY_ID.get(DEFAULT_THEME_ID)!;
}
