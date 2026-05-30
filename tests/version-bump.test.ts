import { describe, expect, test } from "bun:test";
import { bumpVersion, parseLevel } from "../src/release/version-bump.js";

describe("parseLevel", () => {
  test("defaults to patch when no argument is given", () => {
    expect(parseLevel(undefined)).toBe("patch");
  });

  test("accepts patch, minor, and major", () => {
    expect(parseLevel("patch")).toBe("patch");
    expect(parseLevel("minor")).toBe("minor");
    expect(parseLevel("major")).toBe("major");
  });

  test("rejects unknown levels", () => {
    expect(() => parseLevel("huge")).toThrow();
    expect(() => parseLevel("")).toThrow();
  });
});

describe("bumpVersion", () => {
  test("patch increments the patch number", () => {
    expect(bumpVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  test("minor increments minor and resets patch", () => {
    expect(bumpVersion("0.1.5", "minor")).toBe("0.2.0");
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
  });

  test("major increments major and resets minor and patch", () => {
    expect(bumpVersion("0.1.5", "major")).toBe("1.0.0");
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });

  test("rejects versions that are not strict X.Y.Z", () => {
    expect(() => bumpVersion("1.2", "patch")).toThrow();
    expect(() => bumpVersion("1.2.3-beta.1", "patch")).toThrow();
    expect(() => bumpVersion("v1.2.3", "patch")).toThrow();
  });
});
