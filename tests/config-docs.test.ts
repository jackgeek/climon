import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderConfigDocsSection } from "../scripts/generate-config-docs.js";
import { renderConfigSettingsTable } from "../src/config-settings.js";

describe("generated config docs", () => {
  test("renders the registry-backed docs section", () => {
    const section = renderConfigDocsSection();

    expect(section).toContain("### `climon config`");
    expect(section).toContain("config.jsonc");
    expect(section).toContain("config.json.bak");
    expect(section).toContain(renderConfigSettingsTable());
    expect(section).toContain("Legacy `config.json` files are read for backward compatibility");
  });

  test("usage docs contain the generated config section", () => {
    const usage = readFileSync("docs/usage.md", "utf8");

    expect(usage).toContain("<!-- BEGIN GENERATED CONFIG SETTINGS -->");
    expect(usage).toContain(renderConfigDocsSection().trimEnd());
    expect(usage).toContain("<!-- END GENERATED CONFIG SETTINGS -->");
  });
});
