export type SessionStatus = "running" | "needs-attention" | "completed" | "failed" | "disconnected";

export type PriorityReason =
  | "attention"
  | "completed"
  | "failed"
  | "running"
  | "disconnected"
  | "manual";

export interface ServerConfig {
  host: string;
  port: number;
  lan: boolean;
  token: string;
}

export interface TerminalConfig {
  /**
   * When true (default), a connected browser viewer cannot grow the shared PTY
   * beyond the host terminal's dimensions. This keeps the local terminal (which
   * renders raw PTY output and cannot reflow) and the browser showing the same
   * content instead of the browser's larger viewport mangling the terminal.
   */
  clampBrowserToHost: boolean;
}

export interface AttentionConfig {
  /**
   * Number of seconds the rendered terminal grid must remain unchanged before
   * the session is flagged as needing attention. A blinking cursor does not
   * count as a change because only cell contents are fingerprinted. Set to 0 or
   * a negative number to disable static-screen detection.
   */
  idleSeconds: number;
}

export interface ClimonConfig {
  version: 1;
  server: ServerConfig;
  terminal: TerminalConfig;
  attention: AttentionConfig;
}

export interface SessionMeta {
  id: string;
  command: string[];
  displayCommand: string;
  cwd: string;
  status: SessionStatus;
  priorityReason: PriorityReason;
  daemonPid?: number;
  socketPath: string;
  cols: number;
  rows: number;
  /**
   * Whether the session was created without a local terminal attached (the
   * dashboard "New session" button or `climon run --headless`). A missing flag
   * (sessions persisted before this field existed) is treated as non-headless.
   */
  headless?: boolean;
  /**
   * The climon client version that created this session. Absent on sessions
   * persisted before this field existed.
   */
  clientVersion?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  attentionMatchedAt?: string;
  attentionReason?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
}

export interface SessionMetaPatch {
  status?: SessionStatus;
  priorityReason?: PriorityReason;
  daemonPid?: number;
  lastActivityAt?: string;
  attentionMatchedAt?: string;
  attentionReason?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
  cols?: number;
  rows?: number;
}

export interface SessionListResponse {
  sessions: SessionMeta[];
}
