import { describe, expect, test } from "bun:test";
import { t } from "../src/i18n/t.js";
import { loadCatalog } from "../src/i18n/catalog.js";

describe("i18n user-facing messages (t)", () => {
  test("returns the catalogued English string for a known key", () => {
    expect(t("eula.acceptPrompt")).toBe(loadCatalog()["eula.acceptPrompt"].t);
  });

  test("interpolates named params", () => {
    expect(t("update.banner", { current: "0.12.1", next: "0.13.0" })).toBe(
      "Update 0.12.1 → 0.13.0 available — run `climon --update`"
    );
  });

  test("missing key falls back to the key itself", () => {
    expect(t("does.not.exist")).toBe("does.not.exist");
  });
});
