import { describe, expect, test } from "bun:test";
import { resolveNotificationMode } from "../src/web/pwa/push.js";

describe("resolveNotificationMode", () => {
  test("uses push when supported on a tunnel origin", () => {
    expect(resolveNotificationMode({ pushSupported: true, isTunnelOrigin: true })).toBe("push");
  });

  test("uses browser notifications on localhost desktop", () => {
    expect(resolveNotificationMode({ pushSupported: true, isTunnelOrigin: false })).toBe("browser");
    expect(resolveNotificationMode({ pushSupported: false, isTunnelOrigin: true })).toBe("browser");
  });
});
