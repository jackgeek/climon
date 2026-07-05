import { describe, expect, test } from "bun:test";
import {
  CACHE_NAME,
  SHELL_ASSETS,
  chooseCacheStrategy,
  isStaleCacheName,
  shouldCacheAssetResponse,
} from "../src/web/pwa/swCache.js";

const base = { method: "GET", mode: "no-cors", sameOrigin: true, path: "/other" };

describe("chooseCacheStrategy", () => {
  test("navigations are never intercepted, so the browser follows the auth redirect", () => {
    expect(chooseCacheStrategy({ ...base, mode: "navigate", path: "/" })).toBe("passthrough");
    expect(chooseCacheStrategy({ ...base, mode: "navigate", path: "/anything" })).toBe("passthrough");
  });

  test("precached assets use the asset (network-first) strategy", () => {
    expect(chooseCacheStrategy({ ...base, path: "/assets/app.js" })).toBe("asset");
    expect(chooseCacheStrategy({ ...base, path: "/assets/xterm.css" })).toBe("asset");
  });

  test("the root document is never treated as an asset", () => {
    expect(chooseCacheStrategy({ ...base, path: "/" })).toBe("passthrough");
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

  test("flags a previous cache version so activate purges the stale cached shell", () => {
    expect(isStaleCacheName("climon-shell-v2")).toBe(true);
    expect(CACHE_NAME).not.toBe("climon-shell-v2");
  });
});

describe("SHELL_ASSETS", () => {
  test("precaches the boot assets but not the root document", () => {
    expect(SHELL_ASSETS).toContain("/assets/app.js");
    expect(SHELL_ASSETS).toContain("/assets/xterm.css");
    expect(SHELL_ASSETS).not.toContain("/");
  });
});

describe("shouldCacheAssetResponse", () => {
  test("caches a real JS/CSS asset", () => {
    expect(shouldCacheAssetResponse({ ok: true, redirected: false, type: "basic", contentType: "text/javascript; charset=utf-8" })).toBe(true);
    expect(shouldCacheAssetResponse({ ok: true, redirected: false, type: "basic", contentType: "text/css; charset=utf-8" })).toBe(true);
  });
  test("caches a redirected JS/CSS asset (authed dev-tunnel resolves via a redirect)", () => {
    // A dev tunnel authenticates each asset request through a redirect chain that
    // resolves to the real bundle. Rejecting these would pin the SW to a stale
    // (possibly broken) cached copy that can never self-heal.
    expect(shouldCacheAssetResponse({ ok: true, redirected: true, type: "basic", contentType: "text/javascript; charset=utf-8" })).toBe(true);
  });
  test("rejects an inline text/html login page served for an asset path", () => {
    expect(shouldCacheAssetResponse({ ok: true, redirected: false, type: "basic", contentType: "text/html; charset=utf-8" })).toBe(false);
    expect(shouldCacheAssetResponse({ ok: true, redirected: true, type: "basic", contentType: "text/html; charset=utf-8" })).toBe(false);
  });
  test("rejects opaque and non-ok responses", () => {
    expect(shouldCacheAssetResponse({ ok: true, redirected: false, type: "opaqueredirect", contentType: "" })).toBe(false);
    expect(shouldCacheAssetResponse({ ok: false, redirected: false, type: "basic", contentType: "text/javascript" })).toBe(false);
    expect(shouldCacheAssetResponse({ ok: false, redirected: true, type: "opaque", contentType: "" })).toBe(false);
  });
});
