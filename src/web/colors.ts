import type { AnsiColor } from "../types.js";

/** Web-safe CSS hex values for the 8 ANSI colors, used for swatches and the
 * sidebar accent bar. */
export const ANSI_CSS: Record<AnsiColor, string> = {
  black: "#000000",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf"
};

export const ANSI_HIGHLIGHT_CSS: Record<AnsiColor, string> = {
  black: "#555753",
  red: "#ef2929",
  green: "#8ae234",
  yellow: "#fce94f",
  blue: "#729fcf",
  magenta: "#ad7fa8",
  cyan: "#34e2e2",
  white: "#eeeeec"
};
