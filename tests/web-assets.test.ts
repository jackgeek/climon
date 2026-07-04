import { describe, expect, test } from "bun:test";
import { getStaticAsset, renderDashboard } from "../src/server/assets.js";

describe("static image assets", () => {
  test("serves the splash logo as JPEG", async () => {
    const asset = await getStaticAsset("/assets/logo.jpg");
    expect(asset).toBeDefined();
    expect(asset?.contentType).toBe("image/jpeg");
    expect(asset?.body.length).toBeGreaterThan(0);
  });

  test("serves the favicon as PNG", async () => {
    const asset = await getStaticAsset("/favicon.png");
    expect(asset).toBeDefined();
    expect(asset?.contentType).toBe("image/png");
    // PNG magic number.
    expect(asset?.body.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  test("returns undefined for unknown asset paths", async () => {
    const asset = await getStaticAsset("/assets/nope.png");
    expect(asset).toBeUndefined();
  });
});

describe("renderDashboard", () => {
  test("links the favicon", () => {
    expect(renderDashboard()).toContain('<link rel="icon" type="image/png" href="/favicon.png" />');
  });
});

describe("cache-control for mutable code assets", () => {
  // A stale HTTP-cached copy of these unhashed, frequently-rebuilt assets is what
  // previously pinned an installed PWA to a broken bundle. `no-cache` forces the
  // browser to revalidate every load, so a new build is never masked.
  test("the app bundle is served no-cache", async () => {
    const asset = await getStaticAsset("/assets/app.js");
    expect(asset?.cacheControl).toBe("no-cache");
  });

  test("the service worker is served no-cache so updates are detected", async () => {
    const asset = await getStaticAsset("/sw.js");
    expect(asset?.cacheControl).toBe("no-cache");
  });

  test("the web manifest is served no-cache", async () => {
    const asset = await getStaticAsset("/manifest.webmanifest");
    expect(asset?.cacheControl).toBe("no-cache");
  });

  test("stable binary assets are not forced to revalidate", async () => {
    const asset = await getStaticAsset("/favicon.png");
    expect(asset?.cacheControl).toBeUndefined();
  });
});
