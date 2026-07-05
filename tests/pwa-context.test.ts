import { describe, expect, test } from "bun:test";
import {
  buildTunnelReauthUrl,
  canInstallPwa,
  computeIsStandalone,
  computeIsTunnelOrigin,
  reauthenticateTunnel,
} from "../src/web/pwa/pwaContext.js";

describe("pwa context", () => {
  test("tunnel origin requires a devtunnels host and https", () => {
    expect(computeIsTunnelOrigin("abc-3131.usw2.devtunnels.ms", "https:")).toBe(true);
    expect(computeIsTunnelOrigin("abc-3131.usw2.devtunnels.ms", "http:")).toBe(false);
    expect(computeIsTunnelOrigin("localhost", "http:")).toBe(false);
    expect(computeIsTunnelOrigin("192.168.1.5", "https:")).toBe(false);
  });

  test("standalone detection reads the display-mode match and iOS standalone flag", () => {
    expect(computeIsStandalone(true, undefined)).toBe(true);
    expect(computeIsStandalone(false, true)).toBe(true);
    expect(computeIsStandalone(false, false)).toBe(false);
    expect(computeIsStandalone(false, undefined)).toBe(false);
  });

  test("canInstallPwa requires a tunnel origin and not-yet-standalone", () => {
    expect(canInstallPwa({ isTunnelOrigin: true, isStandalone: false })).toBe(true);
    expect(canInstallPwa({ isTunnelOrigin: true, isStandalone: true })).toBe(false);
    expect(canInstallPwa({ isTunnelOrigin: false, isStandalone: false })).toBe(false);
  });

  test("buildTunnelReauthUrl builds a clean reauth url without the anti-phishing skip param", () => {
    const url = buildTunnelReauthUrl("https://abc-3131.usw2.devtunnels.ms");
    expect(url).toBe("https://abc-3131.usw2.devtunnels.ms/?reauth=1");
    expect(url).not.toContain("X-Tunnel-Skip-AntiPhishing-Page");
  });

  test("reauthenticateTunnel navigates the current window in place to the reauth url", () => {
    const calls: string[] = [];
    reauthenticateTunnel({
      origin: "https://abc-3131.usw2.devtunnels.ms",
      navigate: (url) => calls.push(url),
    });
    expect(calls).toEqual(["https://abc-3131.usw2.devtunnels.ms/?reauth=1"]);
  });
});
