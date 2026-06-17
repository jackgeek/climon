export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

export type LogRole = "client" | "daemon" | "server" | "ingest" | "uplink";

export interface StreamEntry {
  stream: NodeJS.WritableStream;
  level?: LogLevel;
}

export interface LoggerInitOptions {
  /** Effective level override; when omitted it is resolved from config + env. */
  level?: LogLevel;
  /** Daemon session id; required for role "daemon" to name the log file. */
  sessionId?: string;
  /** Extra in-process streams (e.g. App Insights) added to the multistream. */
  extraStreams?: StreamEntry[];
  /** Override for the climon home / env (testing). */
  env?: NodeJS.ProcessEnv;
  /** Anonymous installation id, added to the logger base when provided. */
  installId?: string;
}
