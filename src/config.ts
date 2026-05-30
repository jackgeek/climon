import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClimonConfig } from "./types.js";

const CONFIG_VERSION = 1;

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

export function getSocketPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
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
      clampBrowserToHost: true
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
