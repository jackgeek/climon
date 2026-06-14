import { resolveConfigSetting } from "../config.js";
import type { LogLevel } from "./types.js";

const LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];

export const LOG_LEVELS = LEVELS;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

/**
 * Resolves the effective log level. Precedence:
 *   CLIMON_LOG_LEVEL env (if valid) > configLevel (if valid) >
 *   silent when NODE_ENV==="test" > default "trace".
 */
export function resolveLevel(
  configLevel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LogLevel {
  const fromEnv = env.CLIMON_LOG_LEVEL;
  if (isLogLevel(fromEnv)) return fromEnv;
  if (isLogLevel(configLevel)) return configLevel;
  if (env.NODE_ENV === "test") return "silent";
  return "trace";
}

/**
 * Convenience wrapper that reads `logging.level` from the hierarchical config
 * and resolves the effective level for the current environment.
 */
export function resolveEffectiveLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const configLevel = resolveConfigSetting("logging.level", env) as string | undefined;
  return resolveLevel(configLevel, env);
}
