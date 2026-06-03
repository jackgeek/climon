import {
  coerceConfigValue,
  isKnownConfigKey,
  knownConfigKeys,
  resolveConfigSetting,
  unsetConfigSetting,
  writeConfigSetting,
  type WriteScope
} from "../config.js";

export type ConfigAction =
  | { action: "list"; scope: WriteScope }
  | { action: "get"; scope: WriteScope; key: string }
  | { action: "set"; scope: WriteScope; key: string; value: string }
  | { action: "unset"; scope: WriteScope; key: string };

export function validateKey(key: string): void {
  if (!isKnownConfigKey(key)) {
    throw new Error(`Unknown config key '${key}'. Known keys: ${knownConfigKeys().join(", ")}.`);
  }
}

export function parseConfigArgs(argv: string[]): ConfigAction {
  let scope: WriteScope = "auto";
  let list = false;
  let unset = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--global") scope = "global";
    else if (arg === "--local") scope = "local";
    else if (arg === "--list" || arg === "-l") list = true;
    else if (arg === "--unset") unset = true;
    else positional.push(arg);
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
