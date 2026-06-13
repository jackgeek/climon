import { describe, expect, test } from "bun:test";
import { shouldShowTunnelDownBanner, urlBase64ToUint8Array } from "../src/web/pwa/push.js";

describe("urlBase64ToUint8Array", () => {
  test("decodes a base64url VAPID key to bytes", () => {
    const bytes = urlBase64ToUint8Array("SGVsbG8gV29ybGQ");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe("shouldShowTunnelDownBanner", () => {
  test("shows only after reaching the failure threshold", () => {
    expect(shouldShowTunnelDownBanner(2, 3)).toBe(false);
    expect(shouldShowTunnelDownBanner(3, 3)).toBe(true);
    expect(shouldShowTunnelDownBanner(4, 3)).toBe(true);
  });
});
