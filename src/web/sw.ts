/// <reference lib="webworker" />
import { OPEN_SESSION_MESSAGE } from "./pwa/pushData.js";
import {
  CACHE_NAME,
  NAVIGATION_SHELL_URL,
  SHELL_ASSETS,
  chooseCacheStrategy,
  isStaleCacheName,
  shouldCacheShellResponse,
  shouldCacheAssetResponse,
} from "./pwa/swCache.js";
import {
  handlePush,
  resolveNotificationClick,
  type NotificationClickClient,
} from "./pwa/swPush.js";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          url === NAVIGATION_SHELL_URL ? refreshShell(cache) : precacheAsset(cache, url),
        ),
      );
    })(),
  );
  void self.skipWaiting();
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter(isStaleCacheName).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/**
 * App-shell caching so an installed PWA boots on cold launch even when the dev
 * tunnel would auth-redirect. Navigations are served cache-first (the app always
 * boots); the app bundle is network-first with a cache fallback (fresh when authed,
 * cached when auth-blocked/offline). A startup auth probe in the page then surfaces
 * the re-auth overlay.
 */
self.addEventListener("fetch", (event: FetchEvent) => {
  const request = event.request;
  const url = new URL(request.url);
  const strategy = chooseCacheStrategy({
    method: request.method,
    mode: request.mode,
    sameOrigin: url.origin === self.location.origin,
    path: url.pathname,
  });
  if (strategy === "passthrough") {
    return;
  }
  event.respondWith(strategy === "navigation" ? navigationResponse() : assetResponse(request));
});

/** Cache-first shell: serve the cached document, refreshing it in the background. */
async function navigationResponse(): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(NAVIGATION_SHELL_URL);
  void refreshShell(cache);
  if (cached) {
    return cached;
  }
  return fetch(NAVIGATION_SHELL_URL);
}

async function refreshShell(cache: Cache): Promise<void> {
  try {
    const res = await fetch(NAVIGATION_SHELL_URL, { cache: "no-store", redirect: "manual" });
    const body = res.type === "opaqueredirect" ? "" : await res.clone().text();
    const meta = {
      ok: res.ok,
      redirected: res.redirected,
      type: res.type,
      contentType: res.headers.get("content-type") ?? "",
    };
    if (shouldCacheShellResponse(meta, body)) {
      await cache.put(NAVIGATION_SHELL_URL, res.clone());
    }
  } catch {
    // Offline or auth-blocked: keep the existing cached shell.
  }
}

/** Network-first asset: fresh copy when reachable, cached fallback otherwise. */
async function assetResponse(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  try {
    // `cache: "no-store"` bypasses the browser HTTP cache so "network-first"
    // truly hits the network — otherwise a stale HTTP-cached bundle (these assets
    // are served under fixed URLs) would be handed back as if it were fresh,
    // pinning the app to an outdated/broken build. Matches refreshShell/precacheAsset.
    const res = await fetch(request, { cache: "no-store" });
    const meta = {
      ok: res.ok,
      redirected: res.redirected,
      type: res.type,
      contentType: res.headers.get("content-type") ?? "",
    };
    if (shouldCacheAssetResponse(meta)) {
      await cache.put(request, res.clone());
      return res;
    }
    // Auth-blocked or not a real asset: prefer the last known-good cached copy so
    // a login page is never returned in place of the app bundle.
    const cached = await cache.match(request);
    return cached ?? res;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw new Error("asset unavailable");
  }
}

/** Guarded precache for a single non-shell asset: only stores a genuine asset. */
async function precacheAsset(cache: Cache, url: string): Promise<void> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const meta = {
      ok: res.ok,
      redirected: res.redirected,
      type: res.type,
      contentType: res.headers.get("content-type") ?? "",
    };
    if (shouldCacheAssetResponse(meta)) {
      await cache.put(url, res.clone());
    }
  } catch {
    // Offline or auth-blocked: keep any existing cached entry (do not overwrite).
  }
}

self.addEventListener("push", (event: PushEvent) => {
  event.waitUntil(
    handlePush({
      raw: event.data?.text(),
      showNotification: (title, options) => self.registration.showNotification(title, options),
    }),
  );
});

/** Projects a live `WindowClient` onto the descriptor the decision uses. */
function toClickClient(client: WindowClient): NotificationClickClient {
  return { id: client.id, focused: client.focused, visibilityState: client.visibilityState };
}

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const sessionId =
    (event.notification.data as { sessionId?: string } | null)?.sessionId ?? undefined;
  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const action = resolveNotificationClick(sessionId, windowClients.map(toClickClient));
      const byId = (id: string): WindowClient | undefined =>
        windowClients.find((client) => client.id === id);
      switch (action.kind) {
        case "open":
          await self.clients.openWindow(action.url);
          return;
        case "focus":
          await byId(action.clientId)?.focus();
          return;
        case "post": {
          const client = byId(action.clientId);
          if (!client) return;
          await client.focus();
          client.postMessage({ type: OPEN_SESSION_MESSAGE, sessionId: action.sessionId });
          return;
        }
        case "navigate": {
          const client = byId(action.clientId);
          if (!client) return;
          await client.focus();
          try {
            await client.navigate(action.url);
          } catch {
            // Some platforms reject navigate() on an uncontrolled client. Opening
            // a deep-linked window is more reliable than a postMessage a frozen
            // page could drop — which is the failure this handler prevents.
            await self.clients.openWindow(action.url);
          }
          return;
        }
        default: {
          const exhaustive: never = action;
          return exhaustive;
        }
      }
    })(),
  );
});
