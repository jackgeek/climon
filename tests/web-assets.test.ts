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
