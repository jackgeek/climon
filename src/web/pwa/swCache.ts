/**
 * Pure, DOM-free helpers for the service-worker asset cache. Kept separate from
 * `sw.ts` (which wires these to the real Cache API) so the decision logic is
 * unit-testable, matching the `pwaContext.ts` / `api.ts` split.
 */

export const CACHE_NAME = "climon-shell-v3";

/**
 * Boot assets precached on install so the PWA's JS/CSS load fast (and survive a
 * brief offline blip) once the dev tunnel is authenticated.
 *
 * The top-level document (`/`) is deliberately NOT cached. An installed iOS PWA
 * runs as a standalone WKWebView that blocks *script-initiated* cross-origin
 * navigations, so a dev tunnel can only be (re)authenticated by the browser's
 * own launch navigation following the cross-origin dev-tunnel → Microsoft
 * sign-in redirect. Serving a cached shell for that navigation suppressed the
 * redirect and stranded the PWA on a permanent "Session expired" screen. The
 * service worker therefore never intercepts navigations (see `chooseCacheStrategy`):
 * every top-level navigation hits the network, so a cold relaunch re-authenticates
 * exactly like a fresh install.
 */
export const SHELL_ASSETS = ["/assets/app.js", "/assets/xterm.css"];

export type CacheStrategy = "asset" | "passthrough";

/**
 * Picks the caching strategy for a request:
 * - `asset`: network-first with cache fallback (fresh bundle when authed, cached
 *   copy when the tunnel auth-blocks or the network is down).
 * - `passthrough`: do not intercept — including every top-level navigation, so
 *   the browser natively follows the dev-tunnel sign-in redirect.
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
    return "passthrough";
  }
  return SHELL_ASSETS.includes(req.path) ? "asset" : "passthrough";
}

/** True for a climon shell cache from a previous version that `activate` should delete. */
export function isStaleCacheName(name: string): boolean {
  return name.startsWith("climon-shell-") && name !== CACHE_NAME;
}

/**
 * Whether a network asset response is a real asset (safe to cache). Rejects
 * opaque/non-ok responses and any `text/html` body (an inline dev-tunnel login
 * page served for an asset path), so HTML is never cached as JS/CSS.
 *
 * A `redirected` response is trusted as long as it is `ok` and not `text/html`:
 * an authenticated dev tunnel resolves each asset request through a redirect
 * chain that lands on the genuine bundle. Rejecting redirects here would pin the
 * SW to its cached copy, so a once-poisoned (e.g. broken build) cache entry
 * could never self-heal even after the server is fixed.
 */
export function shouldCacheAssetResponse(res: {
  ok: boolean;
  redirected: boolean;
  type: string;
  contentType: string;
}): boolean {
  if (!res.ok || res.type === "opaqueredirect") {
    return false;
  }
  return !res.contentType.toLowerCase().includes("text/html");
}
