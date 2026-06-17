import {
  compareSemver,
  currentArtifactKey,
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
  "https://github.com/jackgeek/climon-releases/releases/latest/download/manifest.json";

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
    // Only cache a version we could actually install on this platform: an
    // appliable artifact must exist for the current OS/arch. This avoids
    // advertising (and, in auto mode, repeatedly attempting) updates that have
    // no matching download here.
    const hasArtifact = manifest.artifacts?.[currentArtifactKey()] !== undefined;
    if (hasArtifact && compareSemver(manifest.version, opts.currentVersion) > 0) {
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
