import { describe, expect, test } from "bun:test";
import { describeListenError } from "../src/server/server.js";

describe("describeListenError", () => {
  test("explains privileged-port permission failures", () => {
    const result = describeListenError(new Error("permission denied 0.0.0.0:443"), "0.0.0.0", 443);
    expect(result.message).toContain("Ports below 1024 require elevated privileges");
    expect(result.message).toContain("--port");
  });

  test("does not add privileged-port advice for high ports", () => {
    const result = describeListenError(new Error("permission denied 0.0.0.0:3131"), "0.0.0.0", 3131);
    expect(result.message).not.toContain("Ports below 1024");
  });

  test("explains an address-in-use failure", () => {
    const result = describeListenError(new Error("EADDRINUSE: address already in use"), "127.0.0.1", 3131);
    expect(result.message).toContain("already in use");
    expect(result.message).toContain("--port");
  });

  test("passes through unrelated errors unchanged", () => {
    const original = new Error("something else broke");
    expect(describeListenError(original, "127.0.0.1", 3131)).toBe(original);
  });
});
