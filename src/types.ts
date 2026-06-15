export type SessionStatus =
  | "running"
  | "acknowledged"
  | "needs-attention"
  | "completed"
  | "paused"
  | "failed"
  | "disconnected";

export type AnsiColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white";

export type SessionColorMode = AnsiColor | "none" | "auto";

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
}

export interface TerminalConfig {
  /**
   * When true (default), a connected browser viewer cannot grow the shared PTY
   * beyond the host terminal's dimensions. This keeps the local terminal (which
   * renders raw PTY output and cannot reflow) and the browser showing the same
   * content instead of the browser's larger viewport mangling the terminal.
   */
  clampBrowserToHost: boolean;
  /**
   * Byte value of the detach key prefix for the local attach client (default
   * 0x1c = Ctrl-\). Press this prefix then `d` to detach without stopping the
   * command. Configurable because Ctrl-\ does not emit 0x1c under every Windows
   * terminal. Must be an integer in [0, 255].
   */
  detachPrefix: number;
  /**
   * When true (default), climon sets the attached local terminal's title to the
   * session name and updates it live on rename. Disables the whole title feature
   * (including reading the terminal's current title to default an unnamed
   * session) when false.
   */
  setTitle: boolean;
}

export interface RemoteConfig {
  enabled?: boolean;
  /** Direct remote uplink host for same-machine or LAN setups. */
  host?: string;
  /** Host address where the dashboard-side ingest daemon should listen. */
  ingestHost?: string;
  /** Dev tunnel id (e.g. "happy-tree-abc123") used by `devtunnel connect`. */
  tunnelId?: string;
  /** Server-owned persisted dashboard tunnel id reused for tunnel link sessions. */
  dashboardTunnelId?: string;
  /** Server-owned persisted dashboard tunnel cluster reused for tunnel link sessions. */
  dashboardTunnelCluster?: string;
  /** Server-owned flag: whether the Tunnel Link was enabled, so the server re-establishes it on startup. */
  dashboardTunnelEnabled?: boolean;
  /** Local port the devbox forwards and the ingest daemon listens on. */
  port?: number;
  /** Consecutive ingest daemon ports to try from the preferred port before giving up. */
  ingestPortRetryAttempts?: number;
  /** Stable, non-secret client namespace; auto-generated once on the devbox. */
  clientId?: string;
  /** Interval in seconds between mux keepalive pings (default 60, 0 to disable). */
  keepAlive?: number;
  /** CLIMON_HOME of the peer OS (e.g. Windows path from WSL) for same-machine discovery. */
  peerHome?: string;
  /** Optional host override used when connecting to a discovered peer dashboard. */
  peerHost?: string;
  /** Whether to lazily auto-link to a peer dashboard on first run (default true). */
  autoLink?: boolean;
}

export interface SessionDefaultsConfig {
  /** Default sidebar accent color mode for new sessions. */
  color?: SessionColorMode;
  /** Default sort priority (0-1000) for new sessions. */
  priority?: number;
}

export interface TunnelLinkConfig {
  /** Interval in seconds between keep-alive pings to the dev tunnel relay. Set to 0 to disable. */
  keepAlive?: number;
}

export interface LoggingAppInsightsConfig {
  /** Azure Application Insights connection string. When set, the server emits logs to App Insights. */
  connectionString?: string;
}

export interface LoggingConfig {
  /** Minimum log level: trace, debug, info, warn, error, fatal, or silent. */
  level?: string;
  appInsights?: LoggingAppInsightsConfig;
}

export interface EulaConfig {
  /** Whether the current EULA version has been accepted. */
  accepted?: boolean;
  /** The EULA_VERSION the user accepted. */
  version?: string;
  /** ISO-8601 timestamp recording when the EULA was accepted. */
  acceptedAt?: string;
}

export interface TelemetryConfig {
  /** Whether anonymous, opt-in usage telemetry is enabled. */
  enabled?: boolean;
}

export interface UpdateConfig {
  /** Whether signed updates are automatically downloaded and applied in the background. */
  auto?: boolean;
  /** ISO-8601 timestamp of the last background update check. */
  lastCheck?: string;
  /** Latest version discovered by the background update check, if newer than the installed version. */
  availableVersion?: string;
}

export interface InstallConfig {
  /** Anonymous, randomly generated install identifier used only when telemetry is enabled. */
  id?: string;
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
  remote?: RemoteConfig;
  session?: SessionDefaultsConfig;
  tunnelLink?: TunnelLinkConfig;
  logging?: LoggingConfig;
  eula?: EulaConfig;
  telemetry?: TelemetryConfig;
  update?: UpdateConfig;
  install?: InstallConfig;
}

export interface SessionMeta {
  id: string;
  command: string[];
  displayCommand: string;
  cwd: string;
  status: SessionStatus;
  priorityReason: PriorityReason;
  daemonPid?: number;
  cols: number;
  rows: number;
  /**
   * Whether the session was created without a local terminal attached (the
   * dashboard "New session" button or `climon run --headless`). A missing flag
   * (sessions persisted before this field existed) is treated as non-headless.
   */
  headless?: boolean;
  /**
   * Session daemon connection target. New sessions use a loopback TCP ref
   * (`tcp://127.0.0.1:<port>`), while older sessions may still carry a legacy
   * filesystem socket path or named pipe.
   */
  socketPath: string;
  /** The climon client version that created this session. */
  clientVersion?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  attentionMatchedAt?: string;
  attentionReason?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
  origin?: "local" | "remote";
  clientLabel?: string;
  /** Human-friendly label shown in the UI instead of the raw command. */
  name?: string;
  /** Sort priority, integer 0–1000. Absent is treated as 500. */
  priority?: number;
  /** Accent color for the sidebar item, or null/absent for none. */
  color?: AnsiColor | null;
  /** User-controlled pause marker; live daemon writes must not visually unpause while true. */
  userPaused?: boolean;
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
  socketPath?: string;
  cols?: number;
  rows?: number;
  name?: string;
  priority?: number;
  color?: AnsiColor | null;
  userPaused?: boolean;
}

export interface SessionListResponse {
  sessions: SessionMeta[];
}
