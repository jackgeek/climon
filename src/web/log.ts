import pino from "pino";

const VALID_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

/**
 * Resolves the browser log level from localStorage["climon:logLevel"], defaulting
 * to "warn". Reading localStorage can throw a SecurityError in sandboxed iframes
 * or when storage is blocked, and an invalid stored value would make pino() throw;
 * since this module is imported at app boot, either would crash the dashboard. We
 * therefore guard the lookup and fall back to "warn" on any problem.
 */
function resolveBrowserLevel(): string {
  try {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem("climon:logLevel") : null;
    if (stored && VALID_LEVELS.has(stored)) return stored;
  } catch {
    // localStorage access blocked — fall back to the default.
  }
  return "warn";
}

/**
 * Browser-side logger. Wraps the devtools console (no network transport). Level
 * can be raised for debugging via localStorage key "climon:logLevel".
 */
export const log = pino({ name: "climon-web", level: resolveBrowserLevel(), browser: { asObject: false } });

export function webLog(component: string) {
  return log.child({ component });
}
