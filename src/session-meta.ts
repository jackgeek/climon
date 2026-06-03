import type { AnsiColor, SessionColorMode } from "./types.js";

export const ANSI_COLORS: readonly AnsiColor[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"
] as const;

export const AUTO_COLOR_ORDER: readonly AnsiColor[] = [
  "white", "cyan", "magenta", "blue", "yellow", "green", "red", "black"
] as const;

/** Effective priority used for sorting when the field is absent. */
export const DEFAULT_PRIORITY = 500;

/**
 * Parses and validates a priority value (string or number) into an integer in
 * the inclusive range 0–1000. Throws on non-integers or out-of-range values.
 */
export function parsePriority(value: string | number): number {
  const n = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(n)) {
    throw new Error(`Priority must be an integer between 0 and 1000 (got "${value}").`);
  }
  if (n < 0 || n > 1000) {
    throw new Error(`Priority must be between 0 and 1000 (got "${value}").`);
  }
  return n;
}

/**
 * Parses a color name into an AnsiColor. "none" and "" map to null (clear the
 * color). Comparison is case-insensitive. Throws on unknown names.
 */
export function parseColor(value: string): AnsiColor | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "none") {
    return null;
  }
  if ((ANSI_COLORS as readonly string[]).includes(normalized)) {
    return normalized as AnsiColor;
  }
  throw new Error(`Color must be one of: none, ${ANSI_COLORS.join(", ")} (got "${value}").`);
}

/**
 * Parses a color mode for session creation/defaults. "auto" defers concrete
 * color selection until the session is created.
 */
export function parseColorMode(value: string): SessionColorMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "none") {
    return normalized;
  }
  if ((ANSI_COLORS as readonly string[]).includes(normalized)) {
    return normalized as AnsiColor;
  }
  throw new Error(`Color must be one of: auto, none, ${ANSI_COLORS.join(", ")} (got "${value}").`);
}
