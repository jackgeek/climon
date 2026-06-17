import { dirname } from "node:path";
import { readGlobalConfigSetting } from "../config.js";
import { t } from "../i18n/t.js";
import { VERSION } from "../version.js";
import { DEFAULT_MANIFEST_URL } from "./check.js";
import { fetchManifest } from "./manifest.js";
import { UPDATE_PUBLIC_KEY_B64 } from "./pubkey.js";
import { clearAvailableVersion } from "./state.js";
import { runUpdateCommand } from "./update-cmd.js";

/**
 * Reads the shared decryption password from the global config (per-machine;
 * never shadowed by a project-local config). Returns undefined when unset.
 */
export function getConfiguredUpdatePassword(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const value = readGlobalConfigSetting("update.password", env);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `climon update` entrypoint: resolves install dir and applies an update. */
export async function runUpdateCli(_argv: string[]): Promise<number> {
  const installDir = dirname(process.execPath);
  try {
    const manifest = await fetchManifest(DEFAULT_MANIFEST_URL);
    const result = await runUpdateCommand({
      installDir,
      currentVersion: VERSION,
      manifest,
      publicKeyB64: UPDATE_PUBLIC_KEY_B64,
      decryptPassword: getConfiguredUpdatePassword(process.env),
    });
    if (result.status === "updated") clearAvailableVersion(process.env);
    return result.status === "verify-failed" ||
      result.status === "decrypt-failed" ||
      result.status === "no-artifact"
      ? 1
      : 0;
  } catch (err) {
    process.stderr.write(t("update.failed", { detail: (err as Error).message }) + "\n");
    return 1;
  }
}
