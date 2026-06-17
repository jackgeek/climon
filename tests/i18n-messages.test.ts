import { describe, expect, test } from "bun:test";
import { t, MESSAGES } from "../src/i18n/messages.js";

describe("i18n messages", () => {
  test("returns the English string for a known key", () => {
    expect(t("eula.acceptPrompt")).toBe(MESSAGES.en["eula.acceptPrompt"]);
  });

  test("interpolates named params", () => {
    expect(t("update.banner", { current: "0.12.1", next: "0.13.0" })).toBe(
      "Update 0.12.1 → 0.13.0 available — run `climon --update`"
    );
  });

  test("missing key falls back to the key itself", () => {
    // @ts-expect-error intentionally unknown key
    expect(t("does.not.exist")).toBe("does.not.exist");
  });
});
