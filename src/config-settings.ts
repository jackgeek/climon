import type { ClimonConfig } from "./types.js";

export const CONFIG_VERSION = 1;
export const DEFAULT_DETACH_PREFIX = 0x1c; // Ctrl-\

export interface ConfigSetting {
  path: string;
  type: "number" | "string" | "boolean";
  defaultValue?: unknown;
  purpose: string;
  scope: string;
  sensitive?: boolean;
  internal?: boolean;
  acceptInput?: boolean;
  validate?: (value: unknown) => void;
}

export const CONFIG_SETTINGS: ConfigSetting[] = [
  {
    path: "version",
    type: "number",
    defaultValue: CONFIG_VERSION,
    purpose: "Schema version for the persisted config.json format. Always 1 for the current release.",
    scope: "client, daemon, server",
    internal: true
  },
  {
    path: "server.host",
    type: "string",
    defaultValue: "127.0.0.1",
    purpose: "IP address the dashboard server binds to. Defaults to loopback for local-only access.",
    scope: "server"
  },
  {
    path: "server.port",
    type: "number",
    defaultValue: 3131,
    purpose: "TCP port the dashboard server listens on. Change if 3131 conflicts with another service.",
    scope: "server"
  },
  {
    path: "terminal.clampBrowserToHost",
    type: "boolean",
    defaultValue: true,
    purpose: "When true (default), a browser viewer cannot grow the shared PTY beyond the host terminal's dimensions to prevent content mangling.",
    scope: "daemon"
  },
  {
    path: "terminal.detachPrefix",
    type: "number",
    defaultValue: DEFAULT_DETACH_PREFIX,
    purpose: "Byte value of the detach key prefix (default 0x1c = Ctrl-\\). Press prefix then 'd' to detach without stopping the command. Must be an integer in [0, 255].",
    scope: "client",
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
    scope: "client"
  },
  {
    path: "attention.idleSeconds",
    type: "number",
    defaultValue: 10,
    purpose: "Number of seconds the rendered terminal grid must remain unchanged before the session is flagged as needing attention. Set to 0 or negative to disable static-screen detection.",
    scope: "daemon"
  },
  {
    path: "remote.enabled",
    type: "boolean",
    purpose: "Enables remote uplink so the local devbox forwards session metadata and I/O to a remote dashboard over a dev tunnel or direct connection.",
    scope: "client",
    acceptInput: true
  },
  {
    path: "remote.host",
    type: "string",
    purpose: "Direct remote uplink host for same-machine or LAN setups. Takes precedence over dev tunnel forwarding when set.",
    scope: "client",
    acceptInput: true
  },
  {
    path: "remote.ingestHost",
    type: "string",
    purpose: "Host address where the dashboard-side ingest daemon should listen for incoming remote session connections.",
    scope: "client",
    acceptInput: true
  },
  {
    path: "remote.tunnelId",
    type: "string",
    purpose: "Dev tunnel id (e.g. \"happy-tree-abc123\") used by `devtunnel connect` to forward local climon traffic to a remote dashboard.",
    scope: "client",
    acceptInput: true
  },
  {
    path: "remote.tunnelToken",
    type: "string",
    purpose: "Stores the dev tunnel connect token scoped to this tunnel. Supplied via DEVTUNNEL_ACCESS_TOKEN environment variable.",
    scope: "client",
    sensitive: true,
    acceptInput: true
  },
  {
    path: "remote.port",
    type: "number",
    purpose: "Local port the devbox forwards and the ingest daemon listens on. Defaults to server.port if not explicitly set.",
    scope: "client",
    acceptInput: true,
    validate: (value: unknown) => {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 65535) {
        throw new Error("remote.port must be a positive integer between 1 and 65535");
      }
    }
  },
  {
    path: "remote.clientId",
    type: "string",
    purpose: "Stable, non-secret client namespace; auto-generated once on the devbox to uniquely identify this remote client.",
    scope: "client",
    internal: true
  },
  {
    path: "session.color",
    type: "string",
    defaultValue: "auto",
    purpose: "Specifies the default accent color for new sessions. Accepts ANSI color names (red, green, etc.), 'none', or 'auto' for automatic assignment.",
    scope: "client, daemon, server",
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
    purpose: "Default sort priority (0-1000) for new sessions. Lower numbers sort first within each status group.",
    scope: "client, daemon, server",
    acceptInput: true,
    validate: (value: unknown) => {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
        throw new Error("session.priority must be an integer between 0 and 1000");
      }
    }
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
  const config: any = {};

  for (const setting of CONFIG_SETTINGS) {
    if (setting.defaultValue === undefined) continue;

    const parts = setting.path.split(".");
    let current = config;

    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!current[key]) {
        current[key] = {};
      }
      current = current[key];
    }

    const finalKey = parts[parts.length - 1];
    current[finalKey] = setting.defaultValue;
  }

  return config as ClimonConfig;
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
      coerced = value === "true" || value === "1";
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
    const scope = setting.scope;
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
