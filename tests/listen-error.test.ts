import { describe, expect, test } from "bun:test";
import { chooseAvailablePort } from "../src/port-choice.js";
import { describeListenError } from "../src/server/server.js";

describe("describeListenError", () => {
  test("explains privileged-port permission failures", () => {
    const result = describeListenError(new Error("permission denied 0.0.0.0:443"), "0.0.0.0", 443);
    expect(result.message).toContain("Ports below 1024 require elevated privileges");
    expect(result.message).toContain("--port");
  });

  describe("chooseAvailablePort", () => {
    test("returns the first port that can be bound", async () => {
      const attempted: number[] = [];
      const result = await chooseAvailablePort(3131, {
        maxAttempts: 4,
        canBind: async (port) => {
          attempted.push(port);
          return port === 3133;
        }
      });

      expect(result).toEqual({ port: 3133, changed: true });
      expect(attempted).toEqual([3131, 3132, 3133]);
    });

    test("throws the last bind error when no candidate port can be bound", async () => {
      await expect(
        chooseAvailablePort(3131, {
          maxAttempts: 2,
          canBind: async () => false
        })
      ).rejects.toThrow("No available port found from 3131 to 3132.");
    });
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
