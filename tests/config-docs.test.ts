import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderConfigDocsSection, replaceGeneratedConfigSection } from "../scripts/generate-config-docs.js";
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

  test("usage docs use config.jsonc not config.json for user-facing references", () => {
    const usage = readFileSync("docs/usage.md", "utf8");

    // Should not contain stale ~/.climon/config.json reference (exact path)
    expect(usage).not.toMatch(/~\/\.climon\/config\.json(?!c)/);
    
    // Should contain the correct ~/.climon/config.jsonc reference
    expect(usage).toContain("~/.climon/config.jsonc");
  });

  test("replaceGeneratedConfigSection throws on duplicate START markers", () => {
    const START = "<!-- BEGIN GENERATED CONFIG SETTINGS -->";
    const END = "<!-- END GENERATED CONFIG SETTINGS -->";
    const duplicateStart = `${START}\nSome content\n${START}\nMore content\n${END}`;

    expect(() => replaceGeneratedConfigSection(duplicateStart, "New content")).toThrow(/duplicate.*START/i);
  });

  test("replaceGeneratedConfigSection throws on duplicate END markers", () => {
    const START = "<!-- BEGIN GENERATED CONFIG SETTINGS -->";
    const END = "<!-- END GENERATED CONFIG SETTINGS -->";
    const duplicateEnd = `${START}\nSome content\n${END}\nMore content\n${END}`;

    expect(() => replaceGeneratedConfigSection(duplicateEnd, "New content")).toThrow(/duplicate.*END/i);
  });

  test("replaceGeneratedConfigSection is idempotent", () => {
    const usage = readFileSync("docs/usage.md", "utf8");
    const START = "<!-- BEGIN GENERATED CONFIG SETTINGS -->";
    const END = "<!-- END GENERATED CONFIG SETTINGS -->";
    
    // Extract current generated section
    const startIdx = usage.indexOf(START);
    const endIdx = usage.indexOf(END);
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    
    const currentGenerated = usage.slice(startIdx + START.length, endIdx).trim();
    const expectedGenerated = renderConfigDocsSection().trimEnd();
    
    // Current generated section should match what we would generate
    expect(currentGenerated).toBe(expectedGenerated);
  });
});
