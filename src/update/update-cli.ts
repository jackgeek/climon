import { dirname } from "node:path";
import { t } from "../i18n/t.js";
import { VERSION } from "../version.js";
import { DEFAULT_MANIFEST_URL } from "./check.js";
import { fetchManifest } from "./manifest.js";
import { UPDATE_PUBLIC_KEY_B64 } from "./pubkey.js";
import { clearAvailableVersion } from "./state.js";
import { runUpdateCommand } from "./update-cmd.js";

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
    });
    if (result.status === "updated") clearAvailableVersion(process.env);
    return result.status === "verify-failed" || result.status === "no-artifact"
      ? 1
      : 0;
  } catch (err) {
    process.stderr.write(t("update.failed", { detail: (err as Error).message }) + "\n");
    return 1;
  }
}
