import { readGlobalConfigSetting } from "../config.js";

/**
 * The Application Insights connection string shipped with release builds. Empty
 * by default; the release pipeline can replace this constant (or operators can
 * set APPLICATIONINSIGHTS_CONNECTION_STRING). Telemetry only flows when the user
 * has opted in via `telemetry.enabled`.
 */
export const EMBEDDED_TELEMETRY_CONNECTION = "";

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
