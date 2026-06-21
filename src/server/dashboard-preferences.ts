import type { ClimonConfig } from "../types.js";
import { dashboardWritableSettings, findConfigSetting } from "../config-settings.js";

/**
 * Splits a dotted config path into its `section.field` parts. All
 * dashboard-writable settings use exactly two segments; anything else is a
 * programming error (a malformed registry entry) rather than user input, so we
 * fail loudly instead of silently writing to `undefined`.
 */
function splitDottedPath(path: string): [string, string] {
  const segments = path.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new Error(`Dashboard preference path must be "section.field", got: ${path}`);
  }
  return [segments[0], segments[1]];
}

/** Reads a dotted key (e.g. "dashboard.theme") from a config object, or undefined. */
function readDotted(config: ClimonConfig, path: string): unknown {
  const [section, field] = splitDottedPath(path);
  const sub = (config as unknown as Record<string, unknown>)[section];
  if (!sub || typeof sub !== "object") {
    return undefined;
  }
  return (sub as Record<string, unknown>)[field];
}

/** Sets a dotted key on a config object, creating the section if needed. */
function writeDotted(config: ClimonConfig, path: string, value: unknown): void {
  const [section, field] = splitDottedPath(path);
  const record = config as unknown as Record<string, unknown>;
  const existing = record[section];
  const sub =
    existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  sub[field] = value;
  record[section] = sub;
}

/** Effective values for every dashboard-writable setting (config value or default). */
export function collectDashboardPreferences(config: ClimonConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const setting of dashboardWritableSettings()) {
    const value = readDotted(config, setting.path);
    out[setting.path] = value === undefined ? setting.defaultValue : value;
  }
  return out;
}

export type ApplyResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Validates and applies one dashboard preference to the config (in place).
 * Enforces the allowlist (dashboardWritable), the declared type, and the
 * setting's own validator. Returns a discriminated result; the caller persists.
 */
export function applyDashboardPreference(
  config: ClimonConfig,
  key: string,
  value: unknown
): ApplyResult {
  const setting = findConfigSetting(key);
  if (!setting || setting.dashboardWritable !== true) {
    return { ok: false, status: 400, error: `Unknown or non-writable preference: ${key}` };
  }
  if (typeof value !== setting.type) {
    return { ok: false, status: 400, error: `${key} must be a ${setting.type}` };
  }
  try {
    setting.validate?.(value);
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : String(error) };
  }
  writeDotted(config, key, value);
  return { ok: true };
}

/**
 * Serializes config read-modify-write bursts within this process. Concurrent
 * preference writes would otherwise race (load A, load B, save A, save B → A's
 * change lost), so every persist runs through a single promise chain. Failures
 * do not break the chain for subsequent writers.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export type PersistResult =
  | { result: { ok: true }; config: ClimonConfig }
  | { result: { ok: false; status: number; error: string }; config: null };

/**
 * Loads the latest config, validates+applies one preference, and persists it —
 * all serialized so concurrent writers cannot clobber each other. On success
 * returns the saved config so the caller can refresh any in-memory copy; on
 * rejection returns the discriminated error and a null config (nothing saved).
 */
export function persistDashboardPreference(
  key: string,
  value: unknown,
  load: () => Promise<ClimonConfig>,
  save: (config: ClimonConfig) => Promise<void>
): Promise<PersistResult> {
  return serializeWrite(async () => {
    const latest = await load();
    const result = applyDashboardPreference(latest, key, value);
    if (!result.ok) {
      return { result, config: null };
    }
    await save(latest);
    return { result, config: latest };
  });
}
