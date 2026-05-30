import { describe, expect, test } from "bun:test";
import { VERSION } from "../src/version.js";
import pkg from "../package.json";

describe("VERSION", () => {
  test("matches the package.json version", () => {
    expect(VERSION).toBe(pkg.version);
  });

  test("is a non-empty semver-ish string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
