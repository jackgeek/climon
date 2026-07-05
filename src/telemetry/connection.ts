import { readGlobalConfigSetting } from "../config.js";

/**
 * Build-time define for the shipped Application Insights connection string. The
 * release compile step injects it via `bun build --define`
 * (see `telemetryDefineArgs` in `scripts/compile.ts`) from the
 * `APPLICATIONINSIGHTS_CONNECTION_STRING` CI secret. Undefined in source mode and
 * in builds without the secret, so nothing is embedded there.
 */
declare const __CLIMON_TELEMETRY_CONNECTION__: string | undefined;

/**
 * The Application Insights connection string shipped with release builds. Empty
 * by default; the release pipeline replaces it at compile time via the
 * `__CLIMON_TELEMETRY_CONNECTION__` define (or operators can set
 * APPLICATIONINSIGHTS_CONNECTION_STRING at runtime). Telemetry only flows when the
 * user has opted in via `telemetry.enabled`.
 */
export const EMBEDDED_TELEMETRY_CONNECTION: string =
  typeof __CLIMON_TELEMETRY_CONNECTION__ !== "undefined"
    ? __CLIMON_TELEMETRY_CONNECTION__
    : "";

/**
 * Returns the telemetry connection string only when the user has opted in.
 * Precedence (when enabled): explicit env var, then the embedded constant.
 * Returns undefined when telemetry is disabled.
 */
export function resolveTelemetryConnection(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const enabled = readGlobalConfigSetting("telemetry.enabled", env) === true;
  if (!enabled) return undefined;
  const fromEnv = env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim();
  if (fromEnv) return fromEnv;
  return EMBEDDED_TELEMETRY_CONNECTION;
}
