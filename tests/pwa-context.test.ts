import { describe, expect, test } from "bun:test";
import {
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

  test("reauthenticateTunnel opens the tunnel URL in the system browser when standalone", () => {
    const calls: Array<[string, string]> = [];
    reauthenticateTunnel({
      isStandalone: true,
      href: "https://abc-3131.usw2.devtunnels.ms/",
      openBrowser: (url) => calls.push(["open", url]),
      navigate: (url) => calls.push(["navigate", url]),
    });
    expect(calls).toEqual([["open", "https://abc-3131.usw2.devtunnels.ms/"]]);
  });

  test("reauthenticateTunnel reloads in place in a normal browser tab", () => {
    const calls: Array<[string, string]> = [];
    reauthenticateTunnel({
      isStandalone: false,
      href: "https://abc-3131.usw2.devtunnels.ms/",
      openBrowser: (url) => calls.push(["open", url]),
      navigate: (url) => calls.push(["navigate", url]),
    });
    expect(calls).toEqual([["navigate", "https://abc-3131.usw2.devtunnels.ms/"]]);
  });
});
