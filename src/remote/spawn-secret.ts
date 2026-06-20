/**
 * Lazy generation + retrieval of `remote.spawnSecret` on the dashboard host.
 *
 * The secret is the pre-shared HMAC key authenticating dashboard→devbox spawn
 * commands. It is created only when `feature.remoteSpawn` is enabled here, then
 * persisted globally and reused for the life of the remote setup.
 */
import { randomBytes } from "node:crypto";
import { isFeatureEnabled } from "../features.js";
import { loadConfig, resolveConfigSetting, writeConfigSetting } from "../config.js";

/** Returns the persisted spawn secret, or undefined if none is set. */
export async function getSpawnSecret(
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  const value = resolveConfigSetting("remote.spawnSecret", env);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Ensures a spawn secret exists when `feature.remoteSpawn` is enabled, creating
 * and persisting one (32 random bytes, hex) on first use. Returns the secret, or
 * undefined when the feature is disabled (in which case nothing is created).
 */
export async function ensureSpawnSecret(
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  const config = await loadConfig(env);
  if (!isFeatureEnabled(config, "remoteSpawn")) return undefined;
  const existing = await getSpawnSecret(env);
  if (existing) return existing;
  const secret = randomBytes(32).toString("hex");
  writeConfigSetting("remote.spawnSecret", secret, "global", env);
  return secret;
}
