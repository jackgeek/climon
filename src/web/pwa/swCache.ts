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

/** Substring present in the real dashboard shell but not a relay login page. */
const APP_SHELL_MARKER = 'id="root"';

/**
 * Whether a refetched navigation response is genuinely the dashboard shell (safe
 * to cache). Rejects redirects/opaque responses and, crucially, an inline
 * `text/html` dev-tunnel login page — which is a same-origin 200 but lacks the
 * app-shell marker — so an expired session can never poison the cached shell.
 */
export function shouldCacheShellResponse(
  res: { ok: boolean; redirected: boolean; type: string; contentType: string },
  body: string,
): boolean {
  if (!res.ok || res.redirected || res.type === "opaqueredirect") {
    return false;
  }
  if (!res.contentType.toLowerCase().includes("text/html")) {
    return false;
  }
  return body.includes(APP_SHELL_MARKER);
}

/**
 * Whether a network asset response is a real asset (safe to cache). Rejects
 * redirects/opaque responses and any `text/html` body (an inline dev-tunnel
 * login page served for an asset path), so HTML is never cached as JS/CSS.
 */
export function shouldCacheAssetResponse(res: {
  ok: boolean;
  redirected: boolean;
  type: string;
  contentType: string;
}): boolean {
  if (!res.ok || res.redirected || res.type === "opaqueredirect") {
    return false;
  }
  return !res.contentType.toLowerCase().includes("text/html");
}
