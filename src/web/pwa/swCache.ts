/**
 * Pure, DOM-free helpers for the service-worker app-shell cache. Kept separate
 * from `sw.ts` (which wires these to the real Cache API) so the decision logic
 * is unit-testable, matching the `pwaContext.ts` / `api.ts` split.
 */

export const CACHE_NAME = "climon-shell-v1";

/** The document served for every navigation (the dashboard HTML shell). */
export const NAVIGATION_SHELL_URL = "/";

/** Assets precached on install so the PWA can boot when the tunnel auth-blocks. */
export const SHELL_ASSETS = [NAVIGATION_SHELL_URL, "/assets/app.js", "/assets/xterm.css"];

export type CacheStrategy = "navigation" | "asset" | "passthrough";

/**
 * Picks the caching strategy for a request:
 * - `navigation`: cache-first (serve the cached shell so the app always boots).
 * - `asset`: network-first with cache fallback (fresh bundle when authed, cached
 *   copy when the tunnel auth-blocks or the network is down).
 * - `passthrough`: do not intercept.
 */
export function chooseCacheStrategy(req: {
  method: string;
  mode: string;
  sameOrigin: boolean;
  path: string;
}): CacheStrategy {
  if (req.method !== "GET" || !req.sameOrigin) {
    return "passthrough";
  }
  if (req.mode === "navigate") {
    return "navigation";
  }
  if (req.path !== NAVIGATION_SHELL_URL && SHELL_ASSETS.includes(req.path)) {
    return "asset";
  }
  return "passthrough";
}

/** True for a climon shell cache from a previous version that `activate` should delete. */
export function isStaleCacheName(name: string): boolean {
  return name.startsWith("climon-shell-") && name !== CACHE_NAME;
}
