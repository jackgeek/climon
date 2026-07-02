import { describe, expect, test } from "bun:test";
import { DEFAULT_MANIFEST_URL } from "../src/update/check.js";

describe("DEFAULT_MANIFEST_URL", () => {
  test("points at the public climon repo", () => {
    expect(DEFAULT_MANIFEST_URL).toContain("jackgeek/climon/");
    expect(DEFAULT_MANIFEST_URL.endsWith("manifest.json")).toBe(true);
  });
});
