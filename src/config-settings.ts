import type { ClimonConfig } from "./types.js";
import { THEME_IDS, isThemeId } from "./dashboard-preference-keys.js";
import { DEFAULT_PRIORITY } from "./session-meta.js";
import { FEATURE_FLAGS } from "./features.js";
import { parseShortcut } from "./hotkeys.js";

export const CONFIG_VERSION = 1;
export const DEFAULT_DETACH_PREFIX = 0x1c; // Ctrl-\

export type ConfigProcessScope = "client" | "daemon" | "server" | "browser";

export interface ConfigSetting {
  path: string;
  type: "number" | "string" | "boolean";
  defaultValue?: unknown;
  purpose: string;
  scope: ConfigProcessScope[];
  sensitive?: boolean;
  internal?: boolean;
  /**
   * When true, the web dashboard may read AND write this setting through the
   * generic preferences API. Must include "browser" in `scope`. This flag is the
   * security allowlist for browser-originated config writes.
   */
  dashboardWritable?: boolean;
  acceptInput?: boolean;
  validate?: (value: unknown) => void;
}

const TERMINAL_HELP_WIDTH = 88;

function featureConfigSettings(): ConfigSetting[] {
  return FEATURE_FLAGS.map((flag) => {
    const overrideNote = flag.override
      ? ` Overridden to "${flag.override}" by this build; config has no effect.`
      : "";
    return {
      path: `feature.${flag.name}`,
      type: "string",
      defaultValue: flag.default,
      purpose: `${flag.description} Set to "enabled" or "disabled". [status: ${flag.status}]${overrideNote}`,
      scope: ["client", "daemon", "server", "browser"],
      acceptInput: true,
      validate: (value: unknown) => {
        if (value !== "enabled" && value !== "disabled") {
          throw new Error(`feature.${flag.name} must be "enabled" or "disabled"`);
        }
      }
    } satisfies ConfigSetting;
  });
}

export const CONFIG_SETTINGS: ConfigSetting[] = [
  {
    path: "version",
    type: "number",
    defaultValue: CONFIG_VERSION,
    purpose: "Schema version for the persisted config.json format. Always 1 for the current release.",
    scope: ["client", "daemon", "server"],
    internal: true
  },
  {
    path: "server.host",
    type: "string",
    defaultValue: "127.0.0.1",
    purpose: "IP address the dashboard server binds to. Defaults to loopback for local-only access.",
    scope: ["server"]
  },
  {
    path: "server.port",
    type: "number",
    defaultValue: 3131,
    purpose: "TCP port the dashboard server listens on. Change if 3131 conflicts with another service.",
    scope: ["server"]
  },
  {
    path: "terminal.clampBrowserToHost",
    type: "boolean",
    defaultValue: false,
    purpose: "When false (default), a browser viewer may grow the shared PTY beyond the host terminal's dimensions. Set true to clamp viewer size to the host terminal to prevent content mangling.",
    scope: ["daemon"]
  },
  {
    path: "terminal.detachPrefix",
    type: "number",
    defaultValue: DEFAULT_DETACH_PREFIX,
    purpose: "Byte value of the detach key prefix (default 0x1c = Ctrl-\\). Press prefix then 'd' to detach without stopping the command. Must be an integer in [0, 255].",
    scope: ["client"],
    validate: (value: unknown) => {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
        throw new Error("terminal.detachPrefix must be an integer between 0 and 255");
      }
    }
  },
  {
    path: "terminal.setTitle",
    type: "boolean",
    defaultValue: true,
    purpose: "When true (default), climon sets the attached local terminal's title to the session name and updates it live on rename. Disables the whole title feature when false.",
    scope: ["client"]
  },
  {
    path: "hotKeys.focusTopSession",
    type: "string",
    defaultValue: "Alt+J",
    purpose:
      'Web dashboard shortcut that selects the top session in the list and focuses its terminal. Format is "Mod+...+Key" (e.g. "Alt+T", "Ctrl+Shift+J"). Set to an empty string to disable.',
    scope: ["server", "browser"],
    acceptInput: true,
    validate: (value: unknown) => {
      if (typeof value !== "string") {
        throw new Error("hotKeys.focusTopSession must be a string");
      }
      const shortcut = parseShortcut(value);
      if (value !== "" && (shortcut === null || /\s/.test(shortcut.key))) {
        throw new Error(
          'hotKeys.focusTopSession must be empty or a shortcut like "Alt+T" or "Ctrl+Shift+J"'
        );
      }
    }
  },
  {
    path: "dashboard.theme",
    type: "string",
    defaultValue: "default",
    purpose: `Web dashboard terminal colour theme. One of: ${THEME_IDS.join(", ")}.`,
    scope: ["server", "browser"],
    acceptInput: true,
    dashboardWritable: true,
    validate: (value: unknown) => {
      if (!isThemeId(value)) {
        throw new Error(`dashboard.theme must be one of: ${THEME_IDS.join(", ")}`);
      }
    }
  },
  {
    path: "dashboard.keyBarPinned",
    type: "boolean",
    defaultValue: false,
    purpose: "Whether the web dashboard key bar is pinned open.",
    scope: ["server", "browser"],
    acceptInput: true,
    dashboardWritable: true,
    validate: (value: unknown) => {
      if (typeof value !== "boolean") {
        throw new Error("dashboard.keyBarPinned must be a boolean");
      }
    }
  },
  {
    path: "attention.idleSeconds",
    type: "number",
    defaultValue: 10,
    purpose: "Number of seconds the rendered terminal grid must remain unchanged before the session is flagged as needing attention. Set to 0 or negative to disable static-screen detection.",
    scope: ["daemon"]
  },
  {
    path: "remote.enabled",
    type: "boolean",
    purpose: "Enables remote uplink so the local devbox forwards session metadata and I/O to a remote dashboard over a dev tunnel or direct connection.",
    scope: ["client"],
    acceptInput: true
  },
  {
    path: "remote.host",
    type: "string",
    purpose: "Direct remote uplink host for same-machine or LAN setups. Takes precedence over dev tunnel forwarding when set.",
    scope: ["client"],
    acceptInput: true
  },
  {
    path: "remote.ingestHost",
    type: "string",
    purpose: "Host address where the dashboard-side ingest daemon should listen for incoming remote session connections.",
    scope: ["client"],
    acceptInput: true
  },
  {
    path: "remote.tunnelId",
    type: "string",
    purpose: "Dev tunnel id (e.g. \"happy-tree-abc123\") used by `devtunnel connect` to forward local climon traffic to a remote dashboard.",
    scope: ["client"],
    acceptInput: true
  },
  {
    path: "remote.dashboardTunnelId",
    type: "string",
    purpose: "Server-owned persisted dashboard tunnel id used to reuse tunnel identity for tunnel link sessions.",
    scope: ["server"],
    internal: true
  },
  {
    path: "remote.dashboardTunnelCluster",
    type: "string",
    purpose: "Server-owned persisted dashboard tunnel cluster used to reuse tunnel identity for tunnel link sessions.",
    scope: ["server"],
    internal: true
  },
  {
    path: "remote.dashboardTunnelEnabled",
    type: "boolean",
    purpose: "Server-owned flag recording whether the Tunnel Link is enabled, so the server re-establishes the dashboard tunnel automatically on startup.",
    scope: ["server"],
    internal: true
  },
  {
    path: "remote.port",
    type: "number",
    purpose: "Local port the devbox forwards and the ingest daemon listens on. Defaults to server.port if not explicitly set.",
    scope: ["client"],
    acceptInput: true,
    validate: (value: unknown) => {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 65535) {
        throw new Error("remote.port must be a positive integer between 1 and 65535");
      }
    }
  },
  {
    path: "remote.ingestPortRetryAttempts",
    type: "number",
    defaultValue: 100,
    purpose: "How many consecutive ports the ingest daemon will try, starting at its preferred port, before giving up. Raise it if many ports near the default are already in use.",
    scope: ["server"],
    validate: (value: unknown) => {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error("remote.ingestPortRetryAttempts must be a positive integer (>= 1)");
      }
    }
  },
  {
    path: "remote.clientId",
    type: "string",
    purpose: "Stable, non-secret client namespace identifying this machine's sessions. Defaults to the machine hostname when unset; set it to a value that is unique per host to avoid session ID collisions across machines.",
    scope: ["client"],
    acceptInput: true,
    validate: (value: unknown) => {
      if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
        throw new Error("remote.clientId must be 1–64 characters using only letters, digits, dots, hyphens, or underscores.");
      }
    }
  },
  {
    path: "remote.spawnSecret",
    type: "string",
    purpose:
      "Shared HMAC secret authenticating dashboard→devbox spawn commands. Generated automatically on the dashboard host when feature.remoteSpawn is enabled, and planted on the devbox by the remotes-screen setup script. Keep it secret.",
    scope: ["client", "server"],
    acceptInput: true,
    sensitive: true
  },
  {
    path: "remote.keepAlive",
    type: "number",
    defaultValue: 60,
    purpose: "Interval in seconds between mux keepalive pings sent over the remote uplink/ingest connection. Prevents dev tunnel idle timeouts from dropping the connection. Set to 0 to disable.",
    scope: ["client"],
    acceptInput: true,
    validate: (value: unknown) => {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error("remote.keepAlive must be a non-negative integer (seconds)");
      }
    }
  },
  {
    path: "remote.peerHome",
    type: "string",
    purpose: "Path to the peer OS's CLIMON_HOME for same-machine WSL<->Windows discovery (e.g. /mnt/c/Users/<you>/.climon from WSL, or \\\\wsl.localhost\\<distro>\\home\\<you>\\.climon from Windows). When set, climon reads the peer's server.json to find a dashboard running on the other OS and auto-wires sessions to it. Usually set automatically by `climon link`.",
    scope: ["client", "server"],
    acceptInput: true
  },
  {
    path: "remote.peerHost",
    type: "string",
    purpose: "Optional host override used to reach the peer dashboard/ingest. Leave unset to auto-detect (localhost, or the WSL gateway IP under NAT networking).",
    scope: ["client", "server"],
    acceptInput: true
  },
  {
    path: "remote.autoLink",
    type: "boolean",
    defaultValue: true,
    purpose: "When true (default), the first `climon` run inside WSL attempts to auto-link to a Windows-side climon by detecting its CLIMON_HOME and setting remote.peerHome on both sides. Set false to disable auto-linking.",
    scope: ["client"],
    acceptInput: true
  },
  {
    path: "session.color",
    type: "string",
    defaultValue: "auto",
    purpose: "Specifies the default accent color for new sessions. Accepts ANSI color names (red, green, etc.), 'none', or 'auto' for automatic assignment.",
    scope: ["client", "daemon", "server"],
    acceptInput: true,
    validate: (value: unknown) => {
      if (typeof value !== "string") {
        throw new Error("session.color must be a string");
      }
      const validColors = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "none", "auto"];
      if (!validColors.includes(value)) {
        throw new Error(`session.color must be one of: ${validColors.join(", ")}`);
      }
    }
  },
  {
    path: "session.priority",
    type: "number",
    defaultValue: DEFAULT_PRIORITY,
    purpose: "Default sort priority (0-1000) for new sessions. Lower numbers sort first within each status group.",
    scope: ["client", "daemon", "server"],
    acceptInput: true,
    validate: (value: unknown) => {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
        throw new Error("session.priority must be an integer between 0 and 1000");
      }
    }
  },
  {
    path: "session.terminalProgram",
    type: "string",
    purpose:
      "Command template used to open a terminal window for a non-headless (visible) session spawned from the dashboard. Use the {cmd} placeholder for the climon command to run. When unset, climon auto-detects a terminal per OS (Terminal.app, Windows Terminal, or x-terminal-emulator/gnome-terminal/konsole/xterm).",
    scope: ["client"],
    acceptInput: true
  },
  {
    path: "tunnelLink.keepAlive",
    type: "number",
    defaultValue: 60,
    purpose: "Interval in seconds between keep-alive pings sent through the Tunnel Link dev tunnel relay to prevent idle disconnection. Set to 0 to disable keep-alive pings.",
    scope: ["server"],
    acceptInput: true,
    validate: (value: unknown) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error("tunnelLink.keepAlive must be a non-negative number");
      }
    }
  },
  {
    path: "logging.level",
    type: "string",
    defaultValue: "trace",
    purpose: "Minimum log level emitted by climon processes. One of: trace, debug, info, warn, error, fatal, silent. Defaults to trace (everything). Set to silent to disable logging. Overridden per-invocation by the CLIMON_LOG_LEVEL environment variable.",
    scope: ["client", "daemon", "server"],
    acceptInput: true,
    validate: (value: unknown) => {
      const levels = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
      if (typeof value !== "string" || !levels.includes(value)) {
        throw new Error(`logging.level must be one of: ${levels.join(", ")}`);
      }
    }
  },
  {
    path: "logging.appInsights.connectionString",
    type: "string",
    purpose: "Azure Application Insights connection string. When set, the dashboard server also forwards structured logs to Application Insights. Leave unset to disable (the default). Can also be supplied via the APPLICATIONINSIGHTS_CONNECTION_STRING environment variable.",
    scope: ["server"],
    sensitive: true,
    acceptInput: true
  },
  ...featureConfigSettings(),
  {
    path: "eula.accepted",
    type: "boolean",
    defaultValue: false,
    purpose:
      "Whether the current EULA version has been accepted. Set by the installer/setup flow; not intended for manual editing.",
    scope: ["client"],
    internal: true
  },
  {
    path: "eula.version",
    type: "string",
    purpose:
      "The EULA_VERSION the user accepted. A newer embedded version re-triggers acceptance.",
    scope: ["client"],
    internal: true
  },
  {
    path: "eula.acceptedAt",
    type: "string",
    purpose: "ISO-8601 timestamp recording when the EULA was accepted.",
    scope: ["client"],
    internal: true
  },
  {
    path: "telemetry.enabled",
    type: "boolean",
    defaultValue: false,
    purpose:
      "When true, climon sends anonymous, opt-in usage telemetry keyed only by a random install id (no PII, session output, commands, paths, or hostnames). Off by default.",
    scope: ["client", "server"],
    acceptInput: true
  },
  {
    path: "update.auto",
    type: "boolean",
    defaultValue: false,
    purpose:
      "When true, climon downloads and applies signed updates automatically in the background. When false (default), it only prints a one-line banner suggesting `climon --update`.",
    scope: ["client"],
    acceptInput: true
  },
  {
    path: "update.password",
    type: "string",
    purpose:
      "Shared password used to decrypt encrypted release artifacts when auto-updating from the gated public release repo. Provided out-of-band by the maintainer. Stored locally; treat as a secret.",
    scope: ["client"],
    sensitive: true,
    acceptInput: true,
  },
  {
    path: "update.lastCheck",
    type: "string",
    purpose:
      "ISO-8601 timestamp of the last background update check. Used to throttle checks.",
    scope: ["client"],
    internal: true
  },
  {
    path: "update.availableVersion",
    type: "string",
    purpose:
      "Latest version discovered by the background update check, if newer than the installed version. Cleared after a successful update.",
    scope: ["client"],
    internal: true
  },
  {
    path: "install.id",
    type: "string",
    purpose:
      "Anonymous, randomly generated install identifier used only when telemetry is enabled. Contains no personal information.",
    scope: ["client", "server"],
    internal: true
  }
];

/**
 * Returns all config keys that users can set via `climon config set`.
 * Excludes internal and default-only keys that should not be directly modified.
 */
export function acceptedConfigKeys(): string[] {
  return CONFIG_SETTINGS
    .filter((s) => s.acceptInput === true)
    .map((s) => s.path);
}

/**
 * Returns all config keys including internal and default-only keys.
 */
export function allConfigKeys(): string[] {
  return CONFIG_SETTINGS.map((s) => s.path);
}

/**
 * Constructs the default config object from registry defaults.
 * Only includes settings that have a defaultValue.
 */
export function buildDefaultConfigFromSettings(): ClimonConfig {
  const config: Record<string, unknown> = {};

  for (const setting of CONFIG_SETTINGS) {
    if (setting.defaultValue === undefined) continue;

    const parts = setting.path.split(".");
    let current: Record<string, unknown> = config;

    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!current[key]) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }

    const finalKey = parts[parts.length - 1];
    current[finalKey] = setting.defaultValue;
  }

  return config as unknown as ClimonConfig;
}

/**
 * Coerces a string input value to the appropriate type and validates it
 * according to the registry entry for the given path.
 */
export function coerceConfigValueFromSettings(path: string, value: string): unknown {
  const setting = findConfigSetting(path);
  if (!setting) {
    throw new Error(`Unknown config key: ${path}`);
  }

  let coerced: unknown;

  switch (setting.type) {
    case "boolean":
      if (value === "true") {
        coerced = true;
      } else if (value === "false") {
        coerced = false;
      } else {
        throw new Error(`Value for '${path}' must be 'true' or 'false'.`);
      }
      break;
    case "number":
      coerced = Number(value);
      if (Number.isNaN(coerced)) {
        throw new Error(`${path} must be a valid number`);
      }
      break;
    case "string":
      coerced = value;
      break;
  }

  if (setting.validate) {
    setting.validate(coerced);
  }

  return coerced;
}

/**
 * Finds the registry entry for a given config path.
 */
export function findConfigSetting(path: string): ConfigSetting | undefined {
  return CONFIG_SETTINGS.find((s) => s.path === path);
}

/** All settings the web dashboard is allowed to read and write. */
export function dashboardWritableSettings(): ConfigSetting[] {
  return CONFIG_SETTINGS.filter((setting) => setting.dashboardWritable === true);
}

/**
 * Renders a Markdown table of all config settings with their metadata.
 * Used for generating documentation.
 */
export function renderConfigSettingsTable(): string {
  const lines: string[] = [];

  lines.push("| Path | Type | Default | Scope | Description |");
  lines.push("|------|------|---------|-------|-------------|");

  for (const setting of CONFIG_SETTINGS) {
    const path = `\`${setting.path}\``;
    const type = setting.type;
    const defaultVal = setting.defaultValue !== undefined ? `\`${String(setting.defaultValue)}\`` : "unset";
    const scope = setting.scope.join(", ");
    let purpose = setting.purpose;

    // Add markers for sensitive and internal settings
    const markers: string[] = [];
    if (setting.sensitive) markers.push("**sensitive**");
    if (setting.internal) markers.push("**internal**");
    if (markers.length > 0) {
      purpose = `${purpose} (${markers.join(", ")})`;
    }

    lines.push(`| ${path} | ${type} | ${defaultVal} | ${scope} | ${purpose} |`);
  }

  return lines.join("\n");
}

function formatDefaultValue(setting: ConfigSetting): string {
  return setting.defaultValue !== undefined ? String(setting.defaultValue) : "unset";
}

function wrapText(text: string, indent: string, maxWidth = TERMINAL_HELP_WIDTH): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = indent;
  const contentWidth = maxWidth - indent.length;

  for (const word of words) {
    if (word.length > contentWidth) {
      if (line !== indent) {
        lines.push(line);
        line = indent;
      }
      for (let index = 0; index < word.length; index += contentWidth) {
        lines.push(`${indent}${word.slice(index, index + contentWidth)}`);
      }
      continue;
    }

    const separator = line === indent ? "" : " ";
    if (line.length + separator.length + word.length > maxWidth && line !== indent) {
      lines.push(line);
      line = `${indent}${word}`;
    } else {
      line = `${line}${separator}${word}`;
    }
  }

  if (line !== indent) lines.push(line);
  return lines;
}

/**
 * Renders config settings for terminal help output.
 */
export function renderConfigSettingsHelp(): string {
  const lines: string[] = [];

  for (const setting of CONFIG_SETTINGS) {
    const metadata = [
      `Type: ${setting.type}`,
      `Default: ${formatDefaultValue(setting)}`,
      `Scope: ${setting.scope.join(", ")}`
    ];
    if (setting.sensitive) metadata.push("sensitive");
    if (setting.internal) metadata.push("internal");

    lines.push(`  ${setting.path}`);
    lines.push(`    ${metadata.join("; ")}`);
    lines.push(...wrapText(setting.purpose, "    "));
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
