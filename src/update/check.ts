import {
  compareSemver,
  fetchManifest as defaultFetchManifest,
  type Manifest,
} from "./manifest.js";
import {
  clearAvailableVersion,
  recordCheck,
  setAvailableVersion,
} from "./state.js";

/** The manifest URL the background check polls. Override in tests. */
export const DEFAULT_MANIFEST_URL =
  "https://github.com/jackgeek/climon/releases/latest/download/manifest.json";

export type BackgroundCheckOptions = {
  env?: NodeJS.ProcessEnv;
  currentVersion: string;
  manifestUrl?: string;
  fetchManifest?: (url: string) => Promise<Manifest>;
};

/**
 * Fetches the manifest and caches the available version if newer. Records the
 * check time and never throws (offline-safe), so it is safe to fire-and-forget.
 */
export async function runBackgroundCheck(
  opts: BackgroundCheckOptions
): Promise<void> {
  const env = opts.env ?? process.env;
  const fetcher = opts.fetchManifest ?? defaultFetchManifest;
  const url = opts.manifestUrl ?? DEFAULT_MANIFEST_URL;
  try {
    const manifest = await fetcher(url);
    if (compareSemver(manifest.version, opts.currentVersion) > 0) {
      setAvailableVersion(manifest.version, env);
    } else {
      clearAvailableVersion(env);
    }
  } catch {
    // Offline or transient failure: leave state untouched-ish and move on.
  } finally {
    recordCheck(env);
  }
}
