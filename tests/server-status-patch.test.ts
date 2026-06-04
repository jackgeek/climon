import { describe, expect, test } from "bun:test";
import { parseBrowserStatusPatch } from "../src/server/server.js";

describe("parseBrowserStatusPatch", () => {
  test("accepts the browser pause status", () => {
    expect(parseBrowserStatusPatch("paused")).toBe("paused");
  });

  test("accepts the browser resume status", () => {
    expect(parseBrowserStatusPatch("running")).toBe("running");
  });

  test("rejects terminal and automation-owned statuses", () => {
    expect(() => parseBrowserStatusPatch("completed")).toThrow(/Invalid status/);
    expect(() => parseBrowserStatusPatch("failed")).toThrow(/Invalid status/);
    expect(() => parseBrowserStatusPatch("disconnected")).toThrow(/Invalid status/);
    expect(() => parseBrowserStatusPatch("available")).toThrow(/Invalid status/);
    expect(() => parseBrowserStatusPatch("needs-attention")).toThrow(/Invalid status/);
  });

  test("rejects non-string status values", () => {
    expect(() => parseBrowserStatusPatch(123)).toThrow(/Invalid status/);
    expect(() => parseBrowserStatusPatch(null)).toThrow(/Invalid status/);
  });
});
