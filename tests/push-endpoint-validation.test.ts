import { describe, expect, it } from "bun:test";
import { isAllowedPushEndpoint, isValidSubscription } from "../src/server/push/subscriptions.js";

describe("isAllowedPushEndpoint", () => {
  it("accepts a normal https push endpoint", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/xyz")).toBe(true);
    expect(isAllowedPushEndpoint("https://172.15.0.1/x")).toBe(true);
    expect(isAllowedPushEndpoint("https://172.32.0.1/x")).toBe(true);
  });

  it("rejects non-https", () => {
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("file:///etc/passwd")).toBe(false);
  });

  it("rejects loopback / private / link-local IP-literal hosts", () => {
    expect(isAllowedPushEndpoint("https://0.0.0.0/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://127.0.0.1/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://127.1/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://2130706433/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://10.0.0.5:8443/internal")).toBe(false);
    expect(isAllowedPushEndpoint("https://172.16.0.1/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://172.31.255.254/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://192.168.1.1/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedPushEndpoint("https://[::1]/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://[::ffff:127.0.0.1]/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://[::ffff:10.0.0.5]/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://[::ffff:a00:1]/")).toBe(false);
    expect(isAllowedPushEndpoint("https://[::ffff:ac10:1]/")).toBe(false);
    expect(isAllowedPushEndpoint("https://[::ffff:c0a8:101]/")).toBe(false);
  });

  it("rejects IPv6 unique-local IP literals without rejecting fd-prefixed DNS names", () => {
    expect(isAllowedPushEndpoint("https://[fc00::1]/")).toBe(false);
    expect(isAllowedPushEndpoint("https://[fd00::1]/")).toBe(false);
    expect(isAllowedPushEndpoint("https://[febf::1]/")).toBe(false);
    expect(isAllowedPushEndpoint("https://[::ffff:127.0.0.1]/")).toBe(false);
    expect(isAllowedPushEndpoint("https://fd-cdn.example.com/")).toBe(true);
  });

  it("rejects IPv4-compatible IPv6 literals for internal hosts", () => {
    expect(isAllowedPushEndpoint("https://[::127.0.0.1]/")).toBe(false);
    expect(isAllowedPushEndpoint("https://[::10.0.0.1]/")).toBe(false);
    expect(isAllowedPushEndpoint("https://[::192.168.1.1]/")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isAllowedPushEndpoint("not-a-url")).toBe(false);
  });
});

describe("isValidSubscription enforces endpoint policy", () => {
  it("rejects a subscription whose endpoint targets an internal host", () => {
    expect(isValidSubscription({ endpoint: "https://10.0.0.5/x", keys: { p256dh: "a", auth: "b" } })).toBe(
      false,
    );
  });

  it("accepts a well-formed public subscription", () => {
    expect(isValidSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "a", auth: "b" } })).toBe(
      true,
    );
  });
});
