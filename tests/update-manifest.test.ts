import { describe, expect, test } from "bun:test";
import { compareSemver, isNewer, type Manifest } from "../src/update/manifest.js";

describe("compareSemver", () => {
  test("orders by major, minor, patch", () => {
    expect(compareSemver("0.13.0", "0.12.9")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("0.12.1", "0.12.10")).toBeLessThan(0);
  });

  test("tolerates a leading v", () => {
    expect(compareSemver("v0.13.0", "0.13.0")).toBe(0);
  });
});

describe("isNewer", () => {
  test("true when manifest version exceeds current", () => {
    const m: Manifest = {
      version: "0.13.0",
      artifacts: { "linux-x64": { url: "u", sig: "s" } },
    };
    expect(isNewer(m, "0.12.1")).toBe(true);
    expect(isNewer(m, "0.13.0")).toBe(false);
    expect(isNewer(m, "0.14.0")).toBe(false);
  });
});
