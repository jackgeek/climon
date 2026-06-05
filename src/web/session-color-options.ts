import { ANSI_COLORS } from "../session-meta.js";
import type { SessionColorMode } from "../types.js";

const BASE_COLOR_OPTIONS: readonly SessionColorMode[] = ["none", ...ANSI_COLORS];

export function sessionColorDropdownOptions(includeAuto = false): readonly SessionColorMode[] {
  return includeAuto ? ["auto", ...BASE_COLOR_OPTIONS] : BASE_COLOR_OPTIONS;
}
