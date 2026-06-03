import { describe, expect, test } from "bun:test";
import { describeDetachKey } from "../src/client/detach-key.js";

describe("describeDetachKey", () => {
  test("0x1c renders as Ctrl-\\", () => {
    expect(describeDetachKey(0x1c)).toBe("Ctrl-\\");
  });

  test("0x01 renders as Ctrl-A", () => {
    expect(describeDetachKey(0x01)).toBe("Ctrl-A");
  });

  test("0x1d renders as Ctrl-]", () => {
    expect(describeDetachKey(0x1d)).toBe("Ctrl-]");
  });

  test("a printable byte renders as a hex code", () => {
    expect(describeDetachKey(0x41)).toBe("0x41");
  });
});
