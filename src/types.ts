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

/**
 * Terminal progress state reported by a program inside the PTY via the
 * ConEmu/Windows-Terminal `OSC 9;4` sequence. Mirrors the Rust
 * `climon_proto::meta::ProgressState` (serde camelCase). `normal` (state 1)
 * carries a determinate `value` percentage; the others do not.
 */
export type ProgressState = "normal" | "error" | "indeterminate" | "warning";

/**
 * Latest `OSC 9;4` progress reported by a program in the PTY. Absent when the
 * program has not reported progress or has cleared it (state 0). Mirrors the
 * Rust `climon_proto::meta::TerminalProgress`.
 */
export interface TerminalProgress {
  state: ProgressState;
  /** Determinate percentage 0–100; only present for the `normal` state. */
  value?: number;
}

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
}

export interface HotKeysConfig {
  /**
   * Web-dashboard shortcut that selects the top session in the list and focuses
   * its terminal. Format is `Mod+...+Key` (e.g. "Alt+T", "Ctrl+Shift+J").
   * Set to an empty string to disable the shortcut.
   */
  focusTopSession: string;
}

export interface DashboardConfig {
  /** Selected web-dashboard default terminal theme display name (see THEME_NAMES). */
  theme?: string;
  /** Whether the dashboard key bar is pinned. */
  keyBarPinned?: boolean;
  /** When true, freeze the animated terminal-progress indicator into a static icon. */
  stateIconNoMotion?: boolean;
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

export interface LoggingConfig {
  /** Minimum log level: trace, debug, info, warn, error, fatal, or silent. */
  level?: string;
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

export interface NotificationsConfig {
  /**
   * When true (default), attention notifications include a fuzzy-extracted
   * snippet of the last relevant terminal output as the notification body.
   * Set false to send only the session name / terminal title.
   */
  smartSnippet: boolean;
}

export interface ClimonConfig {
  version: 1;
  server: ServerConfig;
  terminal: TerminalConfig;
  hotKeys: HotKeysConfig;
  dashboard?: DashboardConfig;
  attention: AttentionConfig;
  notifications?: NotificationsConfig;
  remote?: RemoteConfig;
  session?: SessionDefaultsConfig;
  tunnelLink?: TunnelLinkConfig;
  logging?: LoggingConfig;
  /** Feature flag values keyed by flag name; values are "enabled"/"disabled" (lenient on read). */
  feature?: Record<string, string>;
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
  /** Per-session terminal theme display name; absent = inherit the dashboard default. */
  theme?: string;
  /** User-controlled pause marker; live daemon writes must not visually unpause while true. */
  userPaused?: boolean;
  /** Latest terminal title emitted by a program inside the PTY (OSC 0/2), shown as a subtitle. */
  terminalTitle?: string;
  /** Fuzzy-extracted last relevant terminal output at attention time; the smart-notification body. */
  attentionSnippet?: string;
  /** Latest terminal progress (OSC 9;4) reported by a program inside the PTY; absent/null = none. */
  progress?: TerminalProgress | null;
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
  theme?: string;
  userPaused?: boolean;
  terminalTitle?: string;
  attentionSnippet?: string;
  /** Progress patch: a value sets it, `null` clears it (state 0), absent leaves it unchanged. */
  progress?: TerminalProgress | null;
}

export interface SessionListResponse {
  sessions: SessionMeta[];
}
