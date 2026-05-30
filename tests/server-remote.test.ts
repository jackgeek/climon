import { describe, expect, test } from "bun:test";
import { isAllowedSpawnRequest } from "../src/server/server.js";

// The remote-client mutation endpoints reuse the same guard as session spawn.
describe("remote endpoint gating", () => {
  test("requires JSON content-type and loopback origin/host", () => {
    expect(isAllowedSpawnRequest("application/json", "http://127.0.0.1:3131", "127.0.0.1:3131")).toBe(true);
    expect(isAllowedSpawnRequest("text/plain", null, null)).toBe(false);
    expect(isAllowedSpawnRequest("application/json", "http://evil.example", "127.0.0.1:3131")).toBe(false);
    expect(isAllowedSpawnRequest("application/json", null, "evil.example")).toBe(false);
  });
});
