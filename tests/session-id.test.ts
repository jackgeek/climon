import { describe, it, expect } from "bun:test";
import { validateSessionId } from "../src/session-id.js";

describe("validateSessionId", () => {
  it("accepts a well-formed local id", () => {
    expect(() => validateSessionId("rare-geckos-jam")).not.toThrow();
  });

  it("accepts a well-formed remote-namespaced id", () => {
    expect(() =>
      validateSessionId("rare-geckos-jam~laptop.example-1"),
    ).not.toThrow();
  });

  it("accepts uppercase and underscore in the remote component", () => {
    expect(() => validateSessionId("rare-geckos-jam~Laptop_01")).not.toThrow();
  });

  it("accepts a 64-char remote but rejects 65", () => {
    expect(() => validateSessionId(`rare-geckos-jam~${"a".repeat(64)}`)).not.toThrow();
    expect(() => validateSessionId(`rare-geckos-jam~${"a".repeat(65)}`)).toThrow();
  });

  it("rejects path traversal and separators", () => {
    const bad = [
      "..",
      ".",
      "a/b",
      "a\\b",
      "rare-geckos",
      "Rare-Geckos-Jam",
      "rare-geckos-jam~",
      "~remote",
      "rare-geckos-jam~bad/id",
      "rare-geckos-jam~..",
      "rare-geckos-jam\0x",
      "a--b-c",
      "",
    ];
    for (const id of bad) {
      expect(() => validateSessionId(id), `should reject ${JSON.stringify(id)}`).toThrow();
    }
  });
});
