import { chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseColorMode } from "./session-meta.js";
import type { ClimonConfig } from "./types.js";
import { parseJsoncConfig, renderJsoncConfig } from "./config-jsonc.js";
import {
  acceptedConfigKeys,
  buildDefaultConfigFromSettings,
  coerceConfigValueFromSettings,
  CONFIG_VERSION,
  findConfigSetting
} from "./config-settings.js";

export const DEFAULT_DETACH_PREFIX = 0x1c; // Ctrl-\

const CONFIG_BASENAME = "config.jsonc";
const LEGACY_CONFIG_BASENAME = "config.json";
const LEGACY_CONFIG_BACKUP_BASENAME = "config.json.bak";

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

/**
 * Environment variable tracking nesting depth of climon sessions. Incremented
 * each time a daemon spawns a child process.
 */
export const NEST_LEVEL_ENV_VAR = "CLIMON_NEST_LEVEL";

export function getClimonHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLIMON_HOME ?? join(homedir(), ".climon");
}

export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), CONFIG_BASENAME);
}

function getConfigPathForDir(dir: string): string {
  return join(dir, CONFIG_BASENAME);
}

function getLegacyConfigPathForDir(dir: string): string {
  return join(dir, LEGACY_CONFIG_BASENAME);
}

function getLegacyBackupPathForDir(dir: string): string {
  return join(dir, LEGACY_CONFIG_BACKUP_BASENAME);
}

/** Returns the existing config path for a dir: prefer canonical, fall back to legacy. */
function existingConfigPathForDir(dir: string): string | undefined {
  const canonical = getConfigPathForDir(dir);
  if (existsSync(canonical)) return canonical;
  const legacy = getLegacyConfigPathForDir(dir);
  if (existsSync(legacy)) return legacy;
  return undefined;
}

export function getSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), "sessions");
}

export function getLogsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), "logs");
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
  return buildDefaultConfigFromSettings() as ClimonConfig;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Reads and parses a config file at the given path using JSONC parser. */
async function readConfigRecordFromPath(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf8");
  return parseJsoncConfig(raw, path);
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ClimonConfig> {
  await ensureClimonHome(env);
  const home = getClimonHome(env);
  const canonicalPath = getConfigPathForDir(home);
  const legacyPath = getLegacyConfigPathForDir(home);
  
  let configPath: string | undefined;
  if (existsSync(canonicalPath)) {
    configPath = canonicalPath;
  } else if (existsSync(legacyPath)) {
    configPath = legacyPath;
  }
  
  try {
    if (!configPath) {
      throw { code: "ENOENT" };
    }
    const parsed = await readConfigRecordFromPath(configPath);
    if (!isObjectRecord(parsed) || (parsed.version !== undefined && parsed.version !== CONFIG_VERSION)) {
      throw new Error(`Unsupported climon config format in ${configPath}`);
    }
    const defaults = defaultConfig();
    const parsedServer = isObjectRecord(parsed.server) ? parsed.server : {};
    const parsedTerminal = isObjectRecord(parsed.terminal) ? parsed.terminal : {};
    const parsedAttention = isObjectRecord(parsed.attention) ? parsed.attention : {};
    const parsedSession = isObjectRecord(parsed.session) ? parsed.session : {};
    const parsedFeature = isObjectRecord(parsed.feature) ? (parsed.feature as Record<string, string>) : {};
    const parsedHotKeys = isObjectRecord(parsed.hotKeys) ? parsed.hotKeys : {};
    const parsedPriority = typeof parsedSession.priority === "number" ? { priority: parsedSession.priority } : {};
    const parsedColor = typeof parsedSession.color === "string" ? { color: parsedSession.color } : {};
    const parsedConfig = {
      version: CONFIG_VERSION,
      server: { ...defaults.server, ...parsedServer },
      terminal: { ...defaults.terminal, ...parsedTerminal },
      attention: { ...defaults.attention, ...parsedAttention },
      remote: isObjectRecord(parsed.remote) ? parsed.remote : undefined,
      session: { ...defaults.session, ...parsedPriority, ...parsedColor },
      feature: { ...(defaults.feature ?? {}), ...parsedFeature },
      hotKeys: { ...(defaults.hotKeys ?? {}), ...parsedHotKeys }
    };
    const parsedConfigObject = parsedConfig as ClimonConfig;
    // Backfill sections added after a config file was first written.
    if (!parsedConfigObject.terminal || typeof parsedConfigObject.terminal.clampBrowserToHost !== "boolean") {
      parsedConfigObject.terminal = { ...(parsedConfigObject.terminal ?? {}), clampBrowserToHost: false };
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
    if (
      !parsedConfigObject.hotKeys ||
      typeof parsedConfigObject.hotKeys.focusTopSession !== "string"
    ) {
      parsedConfigObject.hotKeys = {
        ...(parsedConfigObject.hotKeys ?? {}),
        focusTopSession: "Alt+J"
      };
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
  const home = getClimonHome(env);
  const canonicalPath = getConfigPathForDir(home);
  const legacyPath = getLegacyConfigPathForDir(home);
  const backupPath = getLegacyBackupPathForDir(home);
  
  // Check if migration is needed
  const hasLegacy = existsSync(legacyPath);
  const hasCanonical = existsSync(canonicalPath);
  
  // Write the canonical config.jsonc
  const rendered = renderJsoncConfig(config as unknown as Record<string, unknown>);
  await writeFile(canonicalPath, rendered, { mode: 0o600 });
  try {
    await chmod(canonicalPath, 0o600);
  } catch {
    // Windows and some filesystems do not support POSIX permissions.
  }
  
  // Migrate legacy config.json to backup if it exists
  if (hasLegacy && !hasCanonical) {
    try {
      await rename(legacyPath, backupPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Wrote ${canonicalPath} but failed to back up legacy ${legacyPath} to ${backupPath}: ${message}`
      );
    }
  }
}

export async function assertConfigReadable(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await access(getConfigPath(env), constants.R_OK);
}

/** Ordered candidate `.climon` dirs for per-setting resolution: cwd, ancestors up
 * to (but not past) the OS home directory, then the global home. The upward walk
 * stops at the user's home directory so directories at or above `$HOME` are never
 * treated as project-local config sources; the home `.climon` is the global config
 * and is appended separately below. */
export function candidateConfigDirs(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string[] {
  const dirs: string[] = [];
  const homeBoundary = resolve(homedir());
  let dir = resolve(cwd);
  for (;;) {
    if (dir === homeBoundary) break;
    dirs.push(join(dir, ".climon"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = getClimonHome(env);
  if (!dirs.includes(home)) dirs.push(home);
  return dirs;
}

export function listExistingConfigFiles(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string[] {
  const files: string[] = [];
  const seenDirs = new Set<string>();
  for (const dir of candidateConfigDirs(env, cwd)) {
    if (!existsSync(dir)) continue;
    const dirKey = realpathSync(dir);
    if (seenDirs.has(dirKey)) continue;
    seenDirs.add(dirKey);

    const canonical = getConfigPathForDir(dir);
    if (existsSync(canonical)) {
      files.push(canonical);
    }
    const legacy = getLegacyConfigPathForDir(dir);
    if (existsSync(legacy)) {
      files.push(legacy);
    }
  }
  return files;
}

function readSparseConfig(dir: string): Record<string, unknown> {
  try {
    const configPath = existingConfigPathForDir(dir);
    if (!configPath) return {};
    const raw = readFileSync(configPath, "utf8");
    return parseJsoncConfig(raw, configPath);
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
  if (findConfigSetting(key)?.globalOnly) {
    return readGlobalConfigSetting(key, env);
  }
  for (const dir of candidateConfigDirs(env, cwd)) {
    const value = readDottedKey(readSparseConfig(dir), key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Reads a dotted config key from ONLY the global `$CLIMON_HOME/config.jsonc`,
 * bypassing the cwd-upward cascade used by `resolveConfigSetting`. Use this for
 * installer/EULA/update state, which is per-machine and must not be shadowed by
 * a project-local `.climon/config.jsonc`. Returns undefined when unset.
 */
export function readGlobalConfigSetting(
  key: string,
  env: NodeJS.ProcessEnv = process.env
): unknown {
  return readDottedKey(readSparseConfig(getClimonHome(env)), key);
}

export interface ConfigDebugKey {
  key: string;
  /** String representation of the value; redacted for sensitive settings. */
  value: string;
}

export interface ConfigDebugEntry {
  path: string;
  exists: boolean;
  keys: ConfigDebugKey[];
  error?: string;
}

function collectDottedEntries(value: unknown, prefix = ""): ConfigDebugKey[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (!prefix) return [];
    return [{ key: prefix, value: formatDebugValue(prefix, value) }];
  }
  const entries: ConfigDebugKey[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    entries.push(...collectDottedEntries(child, dotted));
  }
  return entries;
}

function formatDebugValue(key: string, value: unknown): string {
  const setting = findConfigSetting(key);
  // Redact sensitive settings and any key absent from the registry, since an
  // unknown key's value cannot be verified as safe to print.
  if (!setting || setting.sensitive) return "<redacted>";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function listConfigDebugEntries(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): ConfigDebugEntry[] {
  return candidateConfigDirs(env, cwd).map((dir) => {
    const configPath = existingConfigPathForDir(dir);
    const reportedPath = getConfigPathForDir(dir);
    
    if (!configPath) return { path: reportedPath, exists: false, keys: [] };
    try {
      const parsed = parseJsoncConfig(readFileSync(configPath, "utf8"), configPath);
      const keys = collectDottedEntries(parsed).sort((a, b) => a.key.localeCompare(b.key));
      return { path: reportedPath, exists: true, keys };
    } catch (error) {
      return {
        path: reportedPath,
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
    if (existingConfigPathForDir(dir)) return dir;
  }
  return getClimonHome(env);
}

/** Registry-backed config key helpers */
export function isKnownConfigKey(key: string): boolean {
  return acceptedConfigKeys().includes(key);
}

export function knownConfigKeys(): string[] {
  return acceptedConfigKeys();
}

/** Coerces a string CLI value to the typed value for a known key. Throws on bad input. */
export function coerceConfigValue(key: string, value: string): string | number | boolean {
  const coerced = coerceConfigValueFromSettings(key, value);
  // Ensure return type matches expected primitives
  if (typeof coerced === "string" || typeof coerced === "number" || typeof coerced === "boolean") {
    return coerced;
  }
  throw new Error(`Value for '${key}' could not be coerced to a primitive type.`);
}

/** Writes a sparse config record to the target dir, backing up legacy config.json if needed. */
function writeSparseConfig(dir: string, record: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const canonicalPath = getConfigPathForDir(dir);
  const legacyPath = getLegacyConfigPathForDir(dir);
  const backupPath = getLegacyBackupPathForDir(dir);
  
  // Check if migration is needed
  const hasLegacy = existsSync(legacyPath);
  const hasCanonical = existsSync(canonicalPath);
  
  // Write the canonical config.jsonc
  const rendered = renderJsoncConfig(record);
  writeFileSync(canonicalPath, rendered, { mode: 0o600 });
  try {
    chmodSync(canonicalPath, 0o600);
  } catch {
    // Non-POSIX filesystems.
  }
  
  // Migrate legacy config.json to backup if it exists
  if (hasLegacy && !hasCanonical) {
    try {
      renameSync(legacyPath, backupPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Wrote ${canonicalPath} but failed to back up legacy ${legacyPath} to ${backupPath}: ${message}`
      );
    }
  }
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
  const current = readSparseConfig(dir);
  const [section, field] = key.split(".");
  const sub = (current[section] && typeof current[section] === "object"
    ? (current[section] as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  sub[field] = coerceConfigValue(key, value);
  current[section] = sub;
  writeSparseConfig(dir, current);
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
  const existingPath = existingConfigPathForDir(dir);
  if (!existingPath) return;
  const current = readSparseConfig(dir);
  const [section, field] = key.split(".");
  const sub = current[section];
  if (sub && typeof sub === "object") {
    delete (sub as Record<string, unknown>)[field];
    if (Object.keys(sub as Record<string, unknown>).length === 0) delete current[section];
  }
  writeSparseConfig(dir, current);
}

/** Absolute path to the home machine's tunnel-hosting desired-state file. */
export function getRemoteHostPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), "remote-host.json");
}
