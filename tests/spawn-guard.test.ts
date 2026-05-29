import { describe, expect, test } from "bun:test";
import { isAllowedSpawnRequest } from "../src/server/server.js";

describe("isAllowedSpawnRequest", () => {
  test("allows JSON content-type with no origin and loopback host", () => {
    expect(isAllowedSpawnRequest("application/json", null, "127.0.0.1:3131")).toBe(true);
  });

  test("allows JSON with loopback origin and host (IPv4)", () => {
    expect(isAllowedSpawnRequest("application/json; charset=utf-8", "http://127.0.0.1:3131", "127.0.0.1:3131")).toBe(true);
  });

  test("allows JSON with localhost origin and host", () => {
    expect(isAllowedSpawnRequest("application/json", "http://localhost:3131", "localhost:3131")).toBe(true);
  });

  test("allows JSON with IPv6 loopback origin and host", () => {
    expect(isAllowedSpawnRequest("application/json", "http://[::1]:3131", "[::1]:3131")).toBe(true);
  });

  test("rejects non-JSON content-type (blocks simple-request CSRF)", () => {
    expect(isAllowedSpawnRequest("text/plain", null, "127.0.0.1:3131")).toBe(false);
    expect(isAllowedSpawnRequest("text/plain;charset=UTF-8", "http://127.0.0.1:3131", "127.0.0.1:3131")).toBe(false);
  });

  test("rejects missing content-type", () => {
    expect(isAllowedSpawnRequest(null, null, "127.0.0.1:3131")).toBe(false);
  });

  test("rejects a non-loopback Origin (cross-site)", () => {
    expect(isAllowedSpawnRequest("application/json", "http://evil.com", "127.0.0.1:3131")).toBe(false);
  });

  test("rejects a non-loopback Host (DNS rebinding)", () => {
    expect(isAllowedSpawnRequest("application/json", null, "attacker.example:3131")).toBe(false);
  });

  test("rejects a malformed Origin", () => {
    expect(isAllowedSpawnRequest("application/json", "not-a-url", "127.0.0.1:3131")).toBe(false);
  });
});
