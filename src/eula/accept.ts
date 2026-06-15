import { readGlobalConfigSetting, writeConfigSetting } from "../config.js";
import { EULA_VERSION } from "./text.js";

/**
 * True only when the user has accepted the EULA AND the accepted version matches
 * the currently embedded EULA_VERSION. A bumped version re-triggers acceptance.
 */
export function isEulaAccepted(env: NodeJS.ProcessEnv = process.env): boolean {
  const accepted = readGlobalConfigSetting("eula.accepted", env) === true;
  const version = readGlobalConfigSetting("eula.version", env);
  return accepted && version === EULA_VERSION;
}

/** Records acceptance of the current EULA version in the global config. */
export function recordEulaAcceptance(
  env: NodeJS.ProcessEnv = process.env
): void {
  writeConfigSetting("eula.accepted", "true", "global", env);
  writeConfigSetting("eula.version", EULA_VERSION, "global", env);
  writeConfigSetting("eula.acceptedAt", new Date().toISOString(), "global", env);
}
