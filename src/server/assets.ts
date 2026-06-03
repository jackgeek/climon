import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildWebBundle } from "./web-build.js";

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
  "/favicon.png": { relPath: "../web/assets/favicon.png", contentType: "image/png", embeddedKey: "FAVICON_PNG" }
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
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>climon</title>
<link rel="icon" type="image/png" href="/favicon.png" />
<link rel="stylesheet" href="/assets/xterm.css" />
<style>
  html, body, #root { height: 100%; }
  body { margin: 0; }
</style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>`;
}
