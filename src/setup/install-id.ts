import { randomUUID } from "node:crypto";
import { readGlobalConfigSetting, writeConfigSetting } from "../config.js";

/** Returns the persisted anonymous install id, or undefined if not yet set. */
export function getInstallId(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const value = readGlobalConfigSetting("install.id", env);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Returns the anonymous install id, generating and persisting a random UUID to
 * the global config on first call. Idempotent.
 */
export function ensureInstallId(env: NodeJS.ProcessEnv = process.env): string {
  const existing = getInstallId(env);
  if (existing) return existing;
  const id = randomUUID();
  writeConfigSetting("install.id", id, "global", env);
  return id;
}
