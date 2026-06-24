import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildWebBundle, buildServiceWorkerBundle } from "./web-build.js";

interface StaticAsset {
  contentType: string;
  body: Buffer;
}

const assetSpecifiers: Record<string, { specifier: string; contentType: string; embeddedKey?: string }> = {
  "/assets/xterm.css": { specifier: "@xterm/xterm/css/xterm.css", contentType: "text/css; charset=utf-8", embeddedKey: "XTERM_CSS" }
};

// Project-owned binary assets served from `src/web/assets` in source mode and
// from base64-embedded buffers in the compiled binary (see embed-assets.ts).
const fileAssetSpecifiers: Record<string, { relPath: string; contentType: string; embeddedKey: string }> = {
  "/assets/logo.jpg": { relPath: "../web/assets/logo.jpg", contentType: "image/jpeg", embeddedKey: "LOGO_JPG" },
  "/favicon.png": { relPath: "../web/assets/favicon.png", contentType: "image/png", embeddedKey: "FAVICON_PNG" },
  "/assets/icon-192.png": { relPath: "../web/assets/icon-192.png", contentType: "image/png", embeddedKey: "ICON_192_PNG" },
  "/assets/icon-512.png": { relPath: "../web/assets/icon-512.png", contentType: "image/png", embeddedKey: "ICON_512_PNG" },
  "/assets/icon-maskable-512.png": { relPath: "../web/assets/icon-maskable-512.png", contentType: "image/png", embeddedKey: "ICON_MASKABLE_512_PNG" },
  "/assets/apple-touch-icon-180.png": { relPath: "../web/assets/apple-touch-icon-180.png", contentType: "image/png", embeddedKey: "APPLE_TOUCH_ICON_180_PNG" }
};

// Embedded assets are compiled into the standalone binary via
// `scripts/embed-assets.ts` + `bun build --compile`. The compile step sets the
// `__CLIMON_EMBEDDED__` define so this code path is active ONLY in the binary.
// In source mode the define is absent, so we always build the dashboard on the
// fly — even if a stale `embedded-assets.ts` is left on disk from a prior
// `compile` run (which previously caused `climon server` to serve an outdated
// bundle).
declare const __CLIMON_EMBEDDED__: boolean | undefined;

let embedded: Record<string, Buffer> | null = null;
if (typeof __CLIMON_EMBEDDED__ !== "undefined" && __CLIMON_EMBEDDED__) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./embedded-assets.js");
    embedded = mod as Record<string, Buffer>;
  } catch {
    // Should not happen in a correctly compiled binary; fall back to a build.
  }
}

const assetCache = new Map<string, StaticAsset>();

const APP_JS_PATH = "/assets/app.js";
const APP_JS_CONTENT_TYPE = "text/javascript; charset=utf-8";

const SW_JS_PATH = "/sw.js";
const SW_JS_CONTENT_TYPE = "text/javascript; charset=utf-8";

async function getServiceWorkerBundle(): Promise<StaticAsset | undefined> {
  const cached = assetCache.get(SW_JS_PATH);
  if (cached) {
    return cached;
  }
  let body: Buffer;
  const embeddedSw = embedded ? (embedded as Record<string, Buffer>).WEB_SW_JS : undefined;
  if (embeddedSw) {
    body = embeddedSw;
  } else {
    try {
      body = Buffer.from(await buildServiceWorkerBundle(), "utf8");
    } catch {
      return undefined;
    }
  }
  const asset: StaticAsset = { contentType: SW_JS_CONTENT_TYPE, body };
  assetCache.set(SW_JS_PATH, asset);
  return asset;
}

export function renderManifest(): string {
  return JSON.stringify({
    name: "climon",
    short_name: "climon",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#242424",
    icons: [
      { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/assets/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  });
}

/**
 * Returns the bundled React dashboard. In the compiled binary it comes from the
 * base64-embedded `WEB_APP_JS`; running from source it is built on demand via
 * `buildWebBundle()` and cached, so `bun run server` needs no separate build.
 */
async function getAppBundle(): Promise<StaticAsset | undefined> {
  const cached = assetCache.get(APP_JS_PATH);
  if (cached) {
    return cached;
  }
  let body: Buffer;
  const embeddedApp = embedded ? (embedded as Record<string, Buffer>).WEB_APP_JS : undefined;
  if (embeddedApp) {
    body = embeddedApp;
  } else {
    try {
      body = Buffer.from(await buildWebBundle(), "utf8");
    } catch {
      return undefined;
    }
  }
  const asset: StaticAsset = { contentType: APP_JS_CONTENT_TYPE, body };
  assetCache.set(APP_JS_PATH, asset);
  return asset;
}

export async function getStaticAsset(pathname: string): Promise<StaticAsset | undefined> {
  if (pathname === SW_JS_PATH) {
    return getServiceWorkerBundle();
  }
  if (pathname === "/manifest.webmanifest") {
    return {
      contentType: "application/manifest+json; charset=utf-8",
      body: Buffer.from(renderManifest(), "utf8")
    };
  }
  if (pathname === APP_JS_PATH) {
    return getAppBundle();
  }

  const fileEntry = fileAssetSpecifiers[pathname];
  if (fileEntry) {
    const cached = assetCache.get(pathname);
    if (cached) {
      return cached;
    }
    try {
      let body: Buffer;
      if (embedded && embedded[fileEntry.embeddedKey]) {
        body = embedded[fileEntry.embeddedKey];
      } else {
        body = readFileSync(resolve(import.meta.dir, fileEntry.relPath)) as Buffer;
      }
      const asset: StaticAsset = { contentType: fileEntry.contentType, body };
      assetCache.set(pathname, asset);
      return asset;
    } catch {
      return undefined;
    }
  }

  const entry = assetSpecifiers[pathname];
  if (!entry) {
    return undefined;
  }
  const cached = assetCache.get(pathname);
  if (cached) {
    return cached;
  }
  try {
    let body: Buffer;
    if (embedded && entry.embeddedKey && embedded[entry.embeddedKey]) {
      body = embedded[entry.embeddedKey];
    } else {
      const resolved = Bun.resolveSync(entry.specifier, import.meta.dir);
      body = readFileSync(resolved) as Buffer;
    }
    const asset: StaticAsset = { contentType: entry.contentType, body };
    assetCache.set(pathname, asset);
    return asset;
  } catch {
    return undefined;
  }
}

export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no" />
<title>climon</title>
<link rel="icon" type="image/png" href="/favicon.png" />
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="apple-touch-icon" href="/assets/apple-touch-icon-180.png" />
<meta name="theme-color" content="#242424" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<link rel="stylesheet" href="/assets/xterm.css" />
<style>
  html, body, #root { height: 100%; }
  /* Lock the PWA to a 1:1 view: block rubber-band/overscroll page movement on
     swipe and pinch-zoom. The terminal and lists manage their own internal
     scrolling, so the page itself never needs to scroll or zoom. */
  html, body { overscroll-behavior: none; }
  body { margin: 0; overflow: hidden; touch-action: pan-x pan-y; }
</style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>`;
}
