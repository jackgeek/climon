import pino from "pino";

/**
 * Browser-side logger. Wraps the devtools console (no network transport). Level
 * can be raised for debugging via localStorage key "climon:logLevel".
 */
const level =
  (typeof localStorage !== "undefined" && localStorage.getItem("climon:logLevel")) || "warn";

export const log = pino({ name: "climon-web", level, browser: { asObject: false } });

export function webLog(component: string) {
  return log.child({ component });
}
