import { describe, expect, test } from "bun:test";
import { EULA_TEXTS, EULA_VERSION, getEula } from "../src/eula/text.js";

describe("eula text", () => {
  test("EULA_VERSION is a non-empty string", () => {
    expect(typeof EULA_VERSION).toBe("string");
    expect(EULA_VERSION.length).toBeGreaterThan(0);
  });

  test("english text mentions licensor, Ireland, and AS IS", () => {
    const { text } = getEula("en");
    expect(text).toContain("Brodie Jack Allan");
    expect(text).toContain("Ireland");
    expect(text).toContain("AS IS");
  });

  test("getEula falls back to en for unknown locale", () => {
    // @ts-expect-error unknown locale on purpose
    expect(getEula("xx").text).toBe(EULA_TEXTS.en.text);
  });
});
