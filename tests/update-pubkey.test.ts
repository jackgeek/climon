import { describe, expect, test } from "bun:test";
import { UPDATE_PUBLIC_KEY_B64 } from "../src/update/pubkey.js";

describe("update public key", () => {
  test("is a string (may be empty until a real key is provisioned)", () => {
    expect(typeof UPDATE_PUBLIC_KEY_B64).toBe("string");
  });

  test("when set, decodes to 32 raw bytes", () => {
    if (UPDATE_PUBLIC_KEY_B64.length === 0) return;
    const bytes = Buffer.from(UPDATE_PUBLIC_KEY_B64, "base64");
    expect(bytes.length).toBe(32);
  });
});
