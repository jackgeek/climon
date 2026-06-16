import type { ClimonConfig } from "./types.js";

/**
 * Development maturity of a feature, ordered least -> most production-ready.
 * Only `ready` is considered safe; enabling any other status warns.
 */
export type FeatureStatus =
  | "experimental"
  | "incomplete"
  | "untested"
  | "known-issues"
  | "ready";

export interface FeatureFlag {
  /** Flag name; the config key is `feature.<name>`. */
  name: string;
  /** Effective value when config does not set the flag. */
  default: "enabled" | "disabled";
  /** Development maturity; surfaced in docs/help/dashboard and drives the enable warning. */
  status: FeatureStatus;
  /** Human-readable description for docs/help. */
  description: string;
  /**
   * Application-level override shipped with the binary. When set, this value
   * wins over config.jsonc and the default, locking the flag.
   */
  override?: "enabled" | "disabled";
}

export type FeatureFlagName = "sessionSpawning";

export const FEATURE_FLAGS: readonly (FeatureFlag & { name: FeatureFlagName })[] = [
  {
    name: "sessionSpawning",
    default: "disabled",
    status: "experimental",
    description: "Allow spawning new sessions from the dashboard."
  }
] as const;

export interface FeatureFlagState {
  enabled: boolean;
  locked: boolean;
  status: FeatureStatus;
}

export const FEATURE_CONFIG_PREFIX = "feature.";

function findFlag(name: string): FeatureFlag | undefined {
  return FEATURE_FLAGS.find((flag) => flag.name === name);
}

/** Resolves one flag against a raw config value. Precedence: override > config > default. */
export function resolveFlagState(flag: FeatureFlag, configValue: string | undefined): FeatureFlagState {
  const locked = flag.override !== undefined;
  const effective = flag.override ?? configValue ?? flag.default;
  return { enabled: effective === "enabled", locked, status: flag.status };
}

function rawConfigValue(config: ClimonConfig, name: string): string | undefined {
  const feature = (config as { feature?: Record<string, unknown> }).feature;
  const value = feature?.[name];
  return typeof value === "string" ? value : undefined;
}

export function isFeatureEnabled(config: ClimonConfig, name: FeatureFlagName): boolean {
  const flag = findFlag(name);
  if (!flag) return false;
  return resolveFlagState(flag, rawConfigValue(config, name)).enabled;
}

export function isFeatureLocked(name: FeatureFlagName): boolean {
  return findFlag(name)?.override !== undefined;
}

export function getFeatureStatus(name: FeatureFlagName): FeatureStatus {
  const flag = findFlag(name);
  if (!flag) {
    throw new Error(`Unknown feature flag: ${name}`);
  }
  return flag.status;
}

export function resolveFeatureFlags(config: ClimonConfig): Record<FeatureFlagName, FeatureFlagState> {
  const map = {} as Record<FeatureFlagName, FeatureFlagState>;
  for (const flag of FEATURE_FLAGS) {
    map[flag.name as FeatureFlagName] = resolveFlagState(flag, rawConfigValue(config, flag.name));
  }
  return map;
}

/** Returns the flag name if `key` is `feature.<known>`, else undefined. */
export function parseFeatureConfigKey(key: string): FeatureFlagName | undefined {
  if (!key.startsWith(FEATURE_CONFIG_PREFIX)) return undefined;
  const name = key.slice(FEATURE_CONFIG_PREFIX.length);
  return findFlag(name) ? (name as FeatureFlagName) : undefined;
}
