import { describe, expect, test } from "bun:test";
import { detectPwaPlatform, pwaInstallInstructions } from "../src/web/pwa/install.js";
import { installPwaMenuLabel } from "../src/web/sidebar-utils.js";

describe("pwa install helpers", () => {
  test("detects iOS from a Safari user agent", () => {
    expect(detectPwaPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15")).toBe("ios");
  });

  test("detects Android from a Chrome user agent", () => {
    expect(detectPwaPlatform("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120")).toBe("android");
  });

  test("falls back to other for desktop", () => {
    expect(detectPwaPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120")).toBe("other");
  });

  test("ios instructions mention Add to Home Screen, android mentions Install", () => {
    expect(pwaInstallInstructions("ios")).toContain("Add to Home Screen");
    expect(pwaInstallInstructions("android")).toContain("Install");
  });

  test("menu label is stable", () => {
    expect(installPwaMenuLabel).toBe("Install as PWA");
  });
});
