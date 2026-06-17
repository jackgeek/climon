import pino, { type Logger } from "pino";
import { resolveEffectiveLevel } from "./level.js";
import { createPrettyStream, setTerminalSuspended } from "./pretty.js";
import { REDACT_OPTIONS } from "./redact.js";
import { buildFileStream } from "./sinks.js";
import type { LoggerInitOptions, LogRole, StreamEntry } from "./types.js";
import { VERSION } from "../version.js";

let root: Logger | undefined;

/** Roles that emit pretty output to the terminal (info/warn->out, error/fatal->err). */
const TERMINAL_ROLES: ReadonlySet<LogRole> = new Set<LogRole>(["client", "server"]);

/**
 * Initializes the process-wide root logger for a role. Safe to call once at
 * startup. At level "silent" no streams or files are created.
 */
export function initLogger(role: LogRole, options: LoggerInitOptions = {}): Logger {
  const env = options.env ?? process.env;
  const level = options.level ?? resolveEffectiveLevel(env);

  const base: Record<string, unknown> = { role, pid: process.pid, version: VERSION };
  if (options.installId) base.installId = options.installId;

  if (level === "silent") {
    root = pino({ level: "silent", enabled: false, base });
    return root;
  }

  const streams: StreamEntry[] = [
    { ...buildFileStream(role, env, options.sessionId), level },
    ...(TERMINAL_ROLES.has(role) ? [{ stream: createPrettyStream(), level: "info" as const }] : []),
    ...(options.extraStreams ?? []),
  ];

  const dest = streams.length === 1 ? streams[0].stream : pino.multistream(streams, { dedupe: false });
  root = pino(
    { level, redact: REDACT_OPTIONS, base },
    dest,
  );
  return root;
}

/**
 * Returns the root logger, lazily initializing a default one if init was never
 * called (covers utility code and tests that import product modules directly).
 */
export function getLogger(): Logger {
  if (!root) root = initLogger("client");
  return root;
}

/** Returns a child logger tagged with a component name. */
export function child(component: string): Logger {
  return getLogger().child({ component });
}

/** Mutes pretty terminal output (used by the client around PTY attach). */
export function suspendTerminal(): void {
  setTerminalSuspended(true);
}

/** Restores pretty terminal output. */
export function resumeTerminal(): void {
  setTerminalSuspended(false);
}

/** Test helper: drops the cached root logger so the next getLogger re-inits. */
export function resetLoggerForTests(): void {
  if (root && root.flush) {
    // Flush pending log writes. In test mode this helps avoid cleanup race conditions.
    root.flush((_err?: NodeJS.ErrnoException) => {
      // Ignore flush errors during cleanup
    });
  }
  root = undefined;
  setTerminalSuspended(false);
}
