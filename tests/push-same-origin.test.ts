import { describe, expect, test } from "bun:test";
import { isSameOriginRequest } from "../src/server/server.js";

describe("isSameOriginRequest", () => {
  test("accepts JSON when Origin host equals Host (tunnel)", () => {
    expect(
      isSameOriginRequest("application/json", "https://abc-3131.usw2.devtunnels.ms", "abc-3131.usw2.devtunnels.ms"),
    ).toBe(true);
  });

  test("accepts JSON when Origin host equals Host (localhost with port)", () => {
    expect(isSameOriginRequest("application/json", "http://localhost:3131", "localhost:3131")).toBe(true);
  });

  test("rejects a non-JSON content-type", () => {
    expect(isSameOriginRequest("text/plain", "https://x.devtunnels.ms", "x.devtunnels.ms")).toBe(false);
  });

  test("rejects when Origin host differs from Host", () => {
    expect(isSameOriginRequest("application/json", "https://evil.example", "x.devtunnels.ms")).toBe(false);
  });

  test("rejects a missing Origin or Host", () => {
    expect(isSameOriginRequest("application/json", null, "x.devtunnels.ms")).toBe(false);
    expect(isSameOriginRequest("application/json", "https://x.devtunnels.ms", null)).toBe(false);
  });

  test("rejects an unparseable Origin", () => {
    expect(isSameOriginRequest("application/json", "not-a-url", "x.devtunnels.ms")).toBe(false);
  });
});
