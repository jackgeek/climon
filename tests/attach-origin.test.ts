import { describe, expect, it } from "bun:test";
import { isAllowedDashboardHost, isAllowedAttachUpgrade } from "../src/server/server.js";

describe("isAllowedDashboardHost", () => {
  it("accepts loopback hosts", () => {
    expect(isAllowedDashboardHost("127.0.0.1:3131")).toBe(true);
    expect(isAllowedDashboardHost("localhost:3131")).toBe(true);
    expect(isAllowedDashboardHost("[::1]:3131")).toBe(true);
  });
  it("accepts the dev tunnel domain", () => {
    expect(isAllowedDashboardHost("abc123-3131.uks1.devtunnels.ms")).toBe(true);
  });
  it("rejects arbitrary / rebinding hosts", () => {
    expect(isAllowedDashboardHost("evil.com:3131")).toBe(false);
    expect(isAllowedDashboardHost("notdevtunnels.ms.evil.com")).toBe(false);
    expect(isAllowedDashboardHost(null)).toBe(false);
  });
});

describe("isAllowedAttachUpgrade", () => {
  it("accepts a same-origin loopback browser", () => {
    expect(isAllowedAttachUpgrade("http://127.0.0.1:3131", "127.0.0.1:3131")).toBe(true);
  });
  it("accepts a same-origin tunnel viewer", () => {
    expect(
      isAllowedAttachUpgrade("https://abc-3131.uks1.devtunnels.ms", "abc-3131.uks1.devtunnels.ms")
    ).toBe(true);
  });
  it("rejects a cross-site origin (WS hijack)", () => {
    expect(isAllowedAttachUpgrade("https://evil.com", "127.0.0.1:3131")).toBe(false);
  });
  it("rejects a missing origin", () => {
    expect(isAllowedAttachUpgrade(null, "127.0.0.1:3131")).toBe(false);
  });
  it("rejects a rebinding host even when same-origin", () => {
    expect(isAllowedAttachUpgrade("http://evil.com:3131", "evil.com:3131")).toBe(false);
  });
});
