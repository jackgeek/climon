import pino from "pino/browser";

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

type LogRecord = Record<string, unknown>;
type ConsoleMethod = (...args: unknown[]) => void;

/**
 * Forwards a pino log record to the matching console method, resolved at call
 * time. pino's default browser transport captures the console method references
 * when the logger is constructed; that both prevents tests from intercepting
 * output and breaks if devtools or error-tracking tools replace a console method
 * after boot. Looking the method up dynamically here, and emitting `(message,
 * fields)`, avoids both problems and keeps console output readable.
 */
function emitToConsole(level: string) {
  return (record: object) => {
    const consoleMethods = console as unknown as Record<string, ConsoleMethod | undefined>;
    const emit = consoleMethods[level] ?? console.log;
    const { msg, level: _level, time: _time, ...fields } = record as LogRecord;
    if (Object.keys(fields).length > 0) emit(msg, fields);
    else emit(msg);
  };
}

/**
 * Browser-side logger. Wraps the devtools console (no network transport). Level
 * can be raised for debugging via localStorage key "climon:logLevel".
 */
export const log = pino({
  name: "climon-web",
  level: resolveBrowserLevel(),
  browser: {
    write: {
      fatal: emitToConsole("fatal"),
      error: emitToConsole("error"),
      warn: emitToConsole("warn"),
      info: emitToConsole("info"),
      debug: emitToConsole("debug"),
      trace: emitToConsole("trace")
    }
  }
});

export function webLog(component: string) {
  return log.child({ component });
}
