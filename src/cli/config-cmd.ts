import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { defaultConfig, getClimonHome } from "../config.js";
import type { ClimonConfig, RemoteConfig } from "../types.js";

export type Scope = "global" | "local";

type KeyType = "string" | "number" | "boolean";

const KEY_TYPES: Record<string, KeyType> = {
  "remote.enabled": "boolean",
  "remote.host": "string",
  "remote.port": "number",
  "remote.user": "string",
  "remote.hostKey": "string",
  "remote.keyFile": "string"
};

export type ConfigAction =
  | { action: "list"; scope: Scope }
  | { action: "get"; scope: Scope; key: string }
  | { action: "set"; scope: Scope; key: string; value: string }
  | { action: "unset"; scope: Scope; key: string }
  | { action: "keygen"; scope: Scope }
  | { action: "known-host"; scope: Scope; line: string };

export function validateKey(key: string): void {
  if (!(key in KEY_TYPES)) {
    throw new Error(`Unknown config key '${key}'. Known keys: ${Object.keys(KEY_TYPES).join(", ")}.`);
  }
}

export function coerceValue(key: string, value: string): string | number | boolean {
  const type = KEY_TYPES[key];
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`Value for '${key}' must be 'true' or 'false'.`);
  }
  if (type === "number") {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`Value for '${key}' must be a positive integer.`);
    }
    return n;
  }
  return value;
}

export function parseConfigArgs(argv: string[]): ConfigAction {
  let scope: Scope = "global";
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
  if (list) {
    return { action: "list", scope };
  }
  if (positional[0] === "keygen") {
    return { action: "keygen", scope };
  }
  if (positional[0] === "known-host") {
    return { action: "known-host", scope, line: positional.slice(1).join(" ") };
  }
  if (unset) {
    const key = positional[0];
    if (!key) throw new Error("Provide a key to unset, e.g. `climon config --unset remote.host`.");
    validateKey(key);
    return { action: "unset", scope, key };
  }
  const [key, value] = positional;
  if (!key) throw new Error("Provide a key, e.g. `climon config remote.host`.");
  validateKey(key);
  if (value === undefined) return { action: "get", scope, key };
  return { action: "set", scope, key, value };
}

function remoteField(key: string): keyof RemoteConfig {
  return key.slice("remote.".length) as keyof RemoteConfig;
}

export function applyConfig(
  config: ClimonConfig,
  action: ConfigAction
): { config: ClimonConfig; output: string; code: number } {
  const next: ClimonConfig = { ...config, remote: { ...(config.remote ?? {}) } };
  switch (action.action) {
    case "list": {
      const lines: string[] = [];
      for (const key of Object.keys(KEY_TYPES)) {
        const value = (next.remote as Record<string, unknown>)[remoteField(key)];
        if (value !== undefined) lines.push(`${key}=${value}`);
      }
      return { config, output: lines.join("\n"), code: 0 };
    }
    case "get": {
      const value = (next.remote as Record<string, unknown>)[remoteField(action.key)];
      if (value === undefined) return { config, output: "", code: 1 };
      return { config, output: String(value), code: 0 };
    }
    case "set": {
      (next.remote as Record<string, unknown>)[remoteField(action.key)] = coerceValue(action.key, action.value);
      return { config: next, output: "", code: 0 };
    }
    case "unset": {
      delete (next.remote as Record<string, unknown>)[remoteField(action.key)];
      return { config: next, output: "", code: 0 };
    }
    default:
      throw new Error("applyConfig: side-effecting action handled in runConfigCommand");
  }
}

function scopeDir(scope: Scope, env: NodeJS.ProcessEnv, cwd: string): string {
  return scope === "global" ? getClimonHome(env) : join(cwd, ".climon");
}

function readConfigAt(dir: string): ClimonConfig {
  try {
    return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as ClimonConfig;
  } catch {
    return defaultConfig();
  }
}

function writeConfigAt(dir: string, config: ClimonConfig): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-POSIX filesystems.
  }
}

/** Generates an ed25519 client key (if missing) and prints the public key to paste into the dashboard. */
function runKeygen(dir: string): number {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "id_climon");
  if (!existsSync(keyPath)) {
    const res = spawnSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "climon-devbox"],
      { stdio: ["ignore", "ignore", "inherit"] }
    );
    if (res.status !== 0) {
      process.stderr.write("climon config: ssh-keygen failed.\n");
      return 1;
    }
  }
  const pub = readFileSync(`${keyPath}.pub`, "utf8").trim();
  process.stdout.write(`Paste this public key into the climon dashboard to authorize this client:\n${pub}\n`);
  return 0;
}

/** Pins a server host key into the project known_hosts (exact line from the dashboard — no TOFU). */
function runKnownHost(dir: string, line: string): number {
  const trimmed = line.trim();
  if (!trimmed) {
    process.stderr.write("climon config: known-host requires a host key line.\n");
    return 2;
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "known_hosts");
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    // Absent: create it.
  }
  if (!existing.split("\n").includes(trimmed)) {
    const head = existing.length > 0 ? existing.replace(/\n*$/, "\n") : "";
    writeFileSync(path, `${head}${trimmed}\n`, { mode: 0o600 });
  }
  return 0;
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
  const dir = scopeDir(action.scope, env, cwd);
  if (action.action === "keygen") {
    return runKeygen(dir);
  }
  if (action.action === "known-host") {
    return runKnownHost(dir, action.line);
  }
  const config = readConfigAt(dir);
  let result: { config: ClimonConfig; output: string; code: number };
  try {
    result = applyConfig(config, action);
  } catch (error) {
    process.stderr.write(`climon config: ${(error as Error).message}\n`);
    return 2;
  }
  if (action.action === "set" || action.action === "unset") {
    writeConfigAt(dir, result.config);
  } else if (result.output) {
    process.stdout.write(`${result.output}\n`);
  }
  return result.code;
}
