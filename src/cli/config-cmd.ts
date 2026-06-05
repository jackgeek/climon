import {
  coerceConfigValue,
  isKnownConfigKey,
  listConfigDebugEntries,
  knownConfigKeys,
  resolveConfigSetting,
  unsetConfigSetting,
  writeConfigSetting,
  type WriteScope
} from "../config.js";
import { renderConfigSettingsHelp } from "../config-settings.js";

export type ConfigAction =
  | { action: "help" }
  | { action: "debug" }
  | { action: "purge" }
  | { action: "list"; scope: WriteScope }
  | { action: "get"; scope: WriteScope; key: string }
  | { action: "set"; scope: WriteScope; key: string; value: string }
  | { action: "unset"; scope: WriteScope; key: string };

export function validateKey(key: string): void {
  if (!isKnownConfigKey(key)) {
    throw new Error(`Unknown config key '${key}'. Known keys: ${knownConfigKeys().join(", ")}.`);
  }
}

export function configHelpText(): string {
  return `climon config — inspect and update climon configuration

Usage:
  climon config <key>              Get the value of a config setting
  climon config <key> <value>      Set a config setting
  climon config --unset <key>      Remove a config setting
  climon config --list             List all set configuration values
  climon config --debug            Show config files and keys in resolution order
  climon config --help             Show this help

Scope (where the setting is written):
  --local      Write to the nearest .climon/config.jsonc (repository-specific)
  --global     Write to $CLIMON_HOME/config.jsonc (user-wide default)
  (no scope)   Automatically choose --local if a .climon/ directory exists nearby,
               otherwise --global

Configuration files and cascade:
  climon uses config.jsonc as the canonical filename. Legacy config.json files
  are automatically migrated to config.jsonc (with comments) when you run a set
  operation. The original file is backed up as config.json.bak.

  Config resolution checks local .climon/config.jsonc files from the current
  working directory upward, then falls back to the global $CLIMON_HOME/config.jsonc.
  Settings from more specific (local) files override global ones.

Settings:

${renderConfigSettingsHelp()}
`;
}

export function parseConfigArgs(argv: string[]): ConfigAction {
  let scope: WriteScope = "auto";
  let debug = false;
  let purge = false;
  let list = false;
  let unset = false;
  let help = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--global") scope = "global";
    else if (arg === "--local") scope = "local";
    else if (arg === "--debug") debug = true;
    else if (arg === "--purge") purge = true;
    else if (arg === "--list" || arg === "-l") list = true;
    else if (arg === "--unset") unset = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else positional.push(arg);
  }
  if (help) {
    if (scope !== "auto" || debug || purge || list || unset || positional.length > 0) {
      throw new Error("Use `climon config --help` without other config arguments.");
    }
    return { action: "help" };
  }
  if (debug) {
    if (purge || list || unset || positional.length > 0) {
      throw new Error("Use `climon config --debug` without other config arguments.");
    }
    return { action: "debug" };
  }
  if (purge) {
    if (scope !== "auto" || list || unset || positional.length > 0) {
      throw new Error("Use `climon config --purge` without other config arguments.");
    }
    return { action: "purge" };
  }
  if (list) return { action: "list", scope };
  if (unset) {
    const key = positional[0];
    if (!key) throw new Error("Provide a key to unset, e.g. `climon config --unset remote.enabled`.");
    validateKey(key);
    return { action: "unset", scope, key };
  }
  const [key, value] = positional;
  if (!key) throw new Error("Provide a key, e.g. `climon config remote.tunnelId`.");
  validateKey(key);
  if (value === undefined) return { action: "get", scope, key };
  // Validate type eagerly so errors surface before any write.
  coerceConfigValue(key, value);
  return { action: "set", scope, key, value };
}

export function runConfigCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): number {
  let action: ConfigAction;
  try {
    action = parseConfigArgs(argv);
  } catch (error) {
    process.stderr.write(`climon config: ${(error as Error).message}\n`);
    return 2;
  }
  try {
    switch (action.action) {
      case "help": {
        process.stdout.write(configHelpText());
        return 0;
      }
      case "debug": {
        const lines: string[] = [];
        for (const entry of listConfigDebugEntries(env, cwd)) {
          lines.push(entry.path);
          if (!entry.exists) {
            lines.push("  (missing)");
          } else if (entry.error) {
            lines.push(`  (error: ${entry.error})`);
          } else if (entry.keys.length === 0) {
            lines.push("  (no keys)");
          } else {
            for (const key of entry.keys) lines.push(`  ${key}`);
          }
        }
        process.stdout.write(`${lines.join("\n")}\n`);
        return 0;
      }
      case "purge":
        throw new Error("Config purge is not implemented yet.");
      case "list": {
        const lines: string[] = [];
        for (const key of knownConfigKeys()) {
          const value = resolveConfigSetting(key, env, cwd);
          if (value !== undefined) lines.push(`${key}=${value}`);
        }
        if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
        return 0;
      }
      case "get": {
        const value = resolveConfigSetting(action.key, env, cwd);
        if (value === undefined) return 1;
        process.stdout.write(`${String(value)}\n`);
        return 0;
      }
      case "set":
        writeConfigSetting(action.key, action.value, action.scope, env, cwd);
        return 0;
      case "unset":
        unsetConfigSetting(action.key, action.scope, env, cwd);
        return 0;
    }
  } catch (error) {
    process.stderr.write(`climon config: ${(error as Error).message}\n`);
    return 2;
  }
}
