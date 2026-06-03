import { constants, existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ClimonConfig, RemoteConfig } from "./types.js";

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
 * `climon <cmd>` invocation should run the command directly instead of starting
 * a new monitored session.
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
  await mkdir(dir, { recursive: true });
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
    }
  };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ClimonConfig> {
  await ensureClimonHome(env);
  const configPath = getConfigPath(env);
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as ClimonConfig;
    if (parsed.version !== CONFIG_VERSION || !parsed.server?.host) {
      throw new Error(`Unsupported climon config format in ${configPath}`);
    }
    // Backfill sections added after a config file was first written.
    if (!parsed.terminal || typeof parsed.terminal.clampBrowserToHost !== "boolean") {
      parsed.terminal = { ...(parsed.terminal ?? {}), clampBrowserToHost: true };
    }
    parsed.terminal.detachPrefix = normalizeDetachPrefix(parsed.terminal.detachPrefix);
    if (typeof parsed.terminal.setTitle !== "boolean") {
      parsed.terminal.setTitle = true;
    }
    // Backfill the attention section for configs written before it existed.
    if (!parsed.attention || typeof parsed.attention.idleSeconds !== "number") {
      parsed.attention = { ...(parsed.attention ?? {}), idleSeconds: 10 };
    }
    return parsed;
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

/**
 * Walks up from `startDir` (inclusive) looking for a directory that contains a
 * `.climon/config.json`. Returns the `.climon` directory path, or undefined.
 */
export function findAncestorClimonDir(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".climon", "config.json"))) {
      return join(dir, ".climon");
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Resolves which directory provides the `remote` (uplink) configuration.
 * Order: CLIMON_HOME → nearest ancestor `.climon` → `~/.climon`.
 */
export function resolveRemoteConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string {
  if (env.CLIMON_HOME) {
    return getClimonHome(env);
  }
  return findAncestorClimonDir(cwd) ?? getClimonHome(env);
}

/**
 * Loads the resolved `.climon` directory and its `remote` section (if any).
 * The directory is always returned so callers can resolve keyFile/known_hosts
 * paths relative to it.
 */
export function loadRemoteConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): { dir: string; remote?: RemoteConfig } {
  const dir = resolveRemoteConfigDir(env, cwd);
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as ClimonConfig;
    return { dir, remote: parsed.remote };
  } catch {
    return { dir };
  }
}
