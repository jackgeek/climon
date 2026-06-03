import { chmodSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseColorMode } from "./session-meta.js";
import type { ClimonConfig } from "./types.js";

const CONFIG_VERSION = 1;

export const DEFAULT_DETACH_PREFIX = 0x1c; // Ctrl-\

/** Returns `value` if it is an integer in [0, 255], otherwise the default. */
function normalizeDetachPrefix(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255
    ? value
    : DEFAULT_DETACH_PREFIX;
}

/**
 * Environment variable set on the command running inside a monitored PTY. Its
 * presence signals that we are already inside a climon session, so a nested
 * `climon <cmd>` invocation should fail instead of starting a new monitored
 * session.
 */
export const SESSION_ENV_VAR = "CLIMON_SESSION_ID";

export function getClimonHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLIMON_HOME ?? join(homedir(), ".climon");
}

export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), "config.json");
}

export function getSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), "sessions");
}

export function getSocketDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), "sock");
}

export function getSessionMetaPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(getSessionsDir(env), `${id}.json`);
}

export function getScrollbackPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(getSessionsDir(env), `${id}.scrollback`);
}

export function getSocketPath(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\climon-${id}`;
  }
  return join(getSocketDir(env), `${id}.sock`);
}

export async function ensureClimonHome(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = getClimonHome(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await mkdir(getSessionsDir(env), { recursive: true });
  if (process.platform !== "win32") {
    await mkdir(getSocketDir(env), { recursive: true });
  }
  return dir;
}

export function defaultConfig(): ClimonConfig {
  return {
    version: CONFIG_VERSION,
    server: {
      host: "127.0.0.1",
      port: 3131
    },
    terminal: {
      clampBrowserToHost: true,
      detachPrefix: DEFAULT_DETACH_PREFIX,
      setTitle: true
    },
    attention: {
      idleSeconds: 10
    },
    session: {
      color: "auto"
    }
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ClimonConfig> {
  await ensureClimonHome(env);
  const configPath = getConfigPath(env);
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed) || (parsed.version !== undefined && parsed.version !== CONFIG_VERSION)) {
      throw new Error(`Unsupported climon config format in ${configPath}`);
    }
    const defaults = defaultConfig();
    const parsedServer = isObjectRecord(parsed.server) ? parsed.server : {};
    const parsedTerminal = isObjectRecord(parsed.terminal) ? parsed.terminal : {};
    const parsedAttention = isObjectRecord(parsed.attention) ? parsed.attention : {};
    const parsedSession = isObjectRecord(parsed.session) ? parsed.session : {};
    const parsedPriority = typeof parsedSession.priority === "number" ? { priority: parsedSession.priority } : {};
    const parsedColor = typeof parsedSession.color === "string" ? { color: parsedSession.color } : {};
    const parsedConfig = {
      version: CONFIG_VERSION,
      server: { ...defaults.server, ...parsedServer },
      terminal: { ...defaults.terminal, ...parsedTerminal },
      attention: { ...defaults.attention, ...parsedAttention },
      remote: isObjectRecord(parsed.remote) ? parsed.remote : undefined,
      session: { ...defaults.session, ...parsedPriority, ...parsedColor }
    };
    const parsedConfigObject = parsedConfig as ClimonConfig;
    // Backfill sections added after a config file was first written.
    if (!parsedConfigObject.terminal || typeof parsedConfigObject.terminal.clampBrowserToHost !== "boolean") {
      parsedConfigObject.terminal = { ...(parsedConfigObject.terminal ?? {}), clampBrowserToHost: true };
    }
    parsedConfigObject.terminal.detachPrefix = normalizeDetachPrefix(parsedConfigObject.terminal.detachPrefix);
    if (typeof parsedConfigObject.terminal.setTitle !== "boolean") {
      parsedConfigObject.terminal.setTitle = true;
    }
    // Backfill the attention section for configs written before it existed.
    if (!parsedConfigObject.attention || typeof parsedConfigObject.attention.idleSeconds !== "number") {
      parsedConfigObject.attention = { ...(parsedConfigObject.attention ?? {}), idleSeconds: 10 };
    }
    if (!parsedConfigObject.session || typeof parsedConfigObject.session !== "object") {
      parsedConfigObject.session = { color: "auto" };
    } else {
      try {
        parsedConfigObject.session.color = typeof parsedConfigObject.session.color === "string"
          ? parseColorMode(parsedConfigObject.session.color)
          : "auto";
      } catch {
        parsedConfigObject.session.color = "auto";
      }
    }
    return parsedConfigObject;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const config = defaultConfig();
    await saveConfig(config, env);
    return config;
  }
}

export async function saveConfig(config: ClimonConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await ensureClimonHome(env);
  const configPath = getConfigPath(env);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(configPath, 0o600);
  } catch {
    // Windows and some filesystems do not support POSIX permissions.
  }
}

export async function assertConfigReadable(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await access(getConfigPath(env), constants.R_OK);
}

/** Ordered candidate `.climon` dirs for per-setting resolution: cwd, ancestors, then the global home. */
export function candidateConfigDirs(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    dirs.push(join(dir, ".climon"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = getClimonHome(env);
  if (!dirs.includes(home)) dirs.push(home);
  return dirs;
}

function readSparseConfig(dir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Reads a dotted key (e.g. "session.color") from a parsed config object, or undefined. */
function readDottedKey(obj: Record<string, unknown>, key: string): unknown {
  const [section, field] = key.split(".");
  const sub = obj[section];
  if (!sub || typeof sub !== "object") return undefined;
  return (sub as Record<string, unknown>)[field];
}

/**
 * Resolves a single dotted config key by walking candidate dirs in order; the
 * first dir whose config.json defines the key wins. Returns undefined if unset
 * everywhere. Tolerates sparse/partial files.
 */
export function resolveConfigSetting(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): unknown {
  for (const dir of candidateConfigDirs(env, cwd)) {
    const value = readDottedKey(readSparseConfig(dir), key);
    if (value !== undefined) return value;
  }
  return undefined;
}

export interface ConfigDebugEntry {
  path: string;
  exists: boolean;
  keys: string[];
  error?: string;
}

function collectDottedKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const keys: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    keys.push(...collectDottedKeys(child, dotted));
  }
  return keys;
}

export function listConfigDebugEntries(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): ConfigDebugEntry[] {
  return candidateConfigDirs(env, cwd).map((dir) => {
    const path = join(dir, "config.json");
    if (!existsSync(path)) return { path, exists: false, keys: [] };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return { path, exists: true, keys: collectDottedKeys(parsed).sort() };
    } catch (error) {
      return {
        path,
        exists: true,
        keys: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
}

export type WriteScope = "auto" | "local" | "global";

/** Chooses the target dir for a write: explicit scope, nearest existing .climon, else ~/.climon. */
export function resolveWriteDir(
  scope: WriteScope,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string {
  if (scope === "local") return join(resolve(cwd), ".climon");
  if (scope === "global") return getClimonHome(env);
  for (const dir of candidateConfigDirs(env, cwd)) {
    if (existsSync(join(dir, "config.json"))) return dir;
  }
  return getClimonHome(env);
}

const CONFIG_KEY_TYPES: Record<string, "string" | "number" | "boolean"> = {
  "remote.enabled": "boolean",
  "remote.host": "string",
  "remote.ingestHost": "string",
  "remote.tunnelId": "string",
  "remote.tunnelToken": "string",
  "remote.port": "number",
  "remote.clientId": "string",
  "session.color": "string",
  "session.priority": "number"
};

export function isKnownConfigKey(key: string): boolean {
  return key in CONFIG_KEY_TYPES;
}

export function knownConfigKeys(): string[] {
  return Object.keys(CONFIG_KEY_TYPES);
}

/** Coerces a string CLI value to the typed value for a known key. Throws on bad input. */
export function coerceConfigValue(key: string, value: string): string | number | boolean {
  const type = CONFIG_KEY_TYPES[key];
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`Value for '${key}' must be 'true' or 'false'.`);
  }
  if (type === "number") {
    const n = Number(value);
    if (!Number.isInteger(n)) {
      throw new Error(`Value for '${key}' must be an integer.`);
    }
    if (key === "session.priority") {
      if (n < 0 || n > 1000) {
        throw new Error("Value for 'session.priority' must be between 0 and 1000.");
      }
      return n;
    }
    if (n <= 0) {
      throw new Error(`Value for '${key}' must be a positive integer.`);
    }
    return n;
  }
  if (key === "session.color") {
    return parseColorMode(value);
  }
  return value;
}

/** Sets a dotted key, coercing booleans/numbers, writing a sparse file (0600). */
export function writeConfigSetting(
  key: string,
  value: string,
  scope: WriteScope = "auto",
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string {
  const dir = resolveWriteDir(scope, env, cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "config.json");
  const current = readSparseConfig(dir);
  const [section, field] = key.split(".");
  const sub = (current[section] && typeof current[section] === "object"
    ? (current[section] as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  sub[field] = coerceConfigValue(key, value);
  current[section] = sub;
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-POSIX filesystems.
  }
  return dir;
}

/** Removes a dotted key from a specific scope's sparse file (no-op if absent). */
export function unsetConfigSetting(
  key: string,
  scope: WriteScope = "auto",
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): void {
  const dir = resolveWriteDir(scope, env, cwd);
  if (!existsSync(join(dir, "config.json"))) return;
  const current = readSparseConfig(dir);
  const [section, field] = key.split(".");
  const sub = current[section];
  if (sub && typeof sub === "object") {
    delete (sub as Record<string, unknown>)[field];
    if (Object.keys(sub as Record<string, unknown>).length === 0) delete current[section];
  }
  const path = join(dir, "config.json");
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}

/** Absolute path to the home machine's tunnel-hosting desired-state file. */
export function getRemoteHostPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), "remote-host.json");
}
