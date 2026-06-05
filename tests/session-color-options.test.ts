import { describe, expect, test } from "bun:test";
import { sessionColorDropdownOptions } from "../src/web/session-color-options.js";

describe("sessionColorDropdownOptions", () => {
  test("includes auto as the first option when requested", () => {
    expect(sessionColorDropdownOptions(true)[0]).toBe("auto");
  });

  test("always includes none and ANSI colors", () => {
    const options = sessionColorDropdownOptions(false);
    expect(options).toContain("none");
    expect(options).toContain("blue");
    expect(options).not.toContain("auto");
  });
});
