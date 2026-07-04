import { describe, expect, test } from "bun:test";
import {
  CACHE_NAME,
  NAVIGATION_SHELL_URL,
  SHELL_ASSETS,
  chooseCacheStrategy,
  isStaleCacheName,
  shouldCacheShellResponse,
  shouldCacheAssetResponse,
} from "../src/web/pwa/swCache.js";

const base = { method: "GET", mode: "no-cors", sameOrigin: true, path: "/other" };

describe("chooseCacheStrategy", () => {
  test("navigation requests use the navigation (cache-first) strategy", () => {
    expect(chooseCacheStrategy({ ...base, mode: "navigate", path: "/" })).toBe("navigation");
    expect(chooseCacheStrategy({ ...base, mode: "navigate", path: "/anything" })).toBe("navigation");
  });

  test("precached assets use the asset (network-first) strategy", () => {
    expect(chooseCacheStrategy({ ...base, path: "/assets/app.js" })).toBe("asset");
    expect(chooseCacheStrategy({ ...base, path: "/assets/xterm.css" })).toBe("asset");
  });

  test("the navigation shell url is never treated as an asset", () => {
    expect(chooseCacheStrategy({ ...base, path: NAVIGATION_SHELL_URL })).toBe("passthrough");
  });

  test("non-GET, cross-origin, and unknown same-origin requests pass through", () => {
    expect(chooseCacheStrategy({ ...base, method: "POST", mode: "navigate", path: "/" })).toBe("passthrough");
    expect(chooseCacheStrategy({ ...base, sameOrigin: false, mode: "navigate", path: "/" })).toBe("passthrough");
    expect(chooseCacheStrategy({ ...base, path: "/events" })).toBe("passthrough");
  });
});

describe("isStaleCacheName", () => {
  test("flags climon shell caches other than the current one", () => {
    expect(isStaleCacheName("climon-shell-v0")).toBe(true);
    expect(isStaleCacheName(CACHE_NAME)).toBe(false);
    expect(isStaleCacheName("some-other-cache")).toBe(false);
  });
});

describe("SHELL_ASSETS", () => {
  test("includes the navigation shell and the boot assets", () => {
    expect(SHELL_ASSETS).toContain(NAVIGATION_SHELL_URL);
    expect(SHELL_ASSETS).toContain("/assets/app.js");
    expect(SHELL_ASSETS).toContain("/assets/xterm.css");
  });
});

describe("shouldCacheShellResponse", () => {
  const good = { ok: true, redirected: false, type: "basic", contentType: "text/html; charset=utf-8" };
  test("caches the real dashboard shell", () => {
    expect(shouldCacheShellResponse(good, '<div id="root"></div>')).toBe(true);
  });
  test("rejects an inline text/html login page (no app-shell marker)", () => {
    expect(shouldCacheShellResponse(good, "<html><body>Sign in to Microsoft</body></html>")).toBe(false);
  });
  test("rejects redirected, opaque, non-ok, and non-html responses", () => {
    expect(shouldCacheShellResponse({ ...good, redirected: true }, '<div id="root"></div>')).toBe(false);
    expect(shouldCacheShellResponse({ ...good, type: "opaqueredirect" }, "")).toBe(false);
    expect(shouldCacheShellResponse({ ...good, ok: false }, '<div id="root"></div>')).toBe(false);
    expect(shouldCacheShellResponse({ ...good, contentType: "application/json" }, '<div id="root"></div>')).toBe(false);
  });
});

describe("shouldCacheAssetResponse", () => {
  test("caches a real JS/CSS asset", () => {
    expect(shouldCacheAssetResponse({ ok: true, redirected: false, type: "basic", contentType: "text/javascript; charset=utf-8" })).toBe(true);
    expect(shouldCacheAssetResponse({ ok: true, redirected: false, type: "basic", contentType: "text/css; charset=utf-8" })).toBe(true);
  });
  test("rejects an inline text/html login page served for an asset path", () => {
    expect(shouldCacheAssetResponse({ ok: true, redirected: false, type: "basic", contentType: "text/html; charset=utf-8" })).toBe(false);
  });
  test("rejects redirected, opaque, and non-ok responses", () => {
    expect(shouldCacheAssetResponse({ ok: true, redirected: true, type: "basic", contentType: "text/javascript" })).toBe(false);
    expect(shouldCacheAssetResponse({ ok: true, redirected: false, type: "opaqueredirect", contentType: "" })).toBe(false);
    expect(shouldCacheAssetResponse({ ok: false, redirected: false, type: "basic", contentType: "text/javascript" })).toBe(false);
  });
});
