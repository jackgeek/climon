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

  test("usage docs do not contain stale --lan flag", () => {
    const usage = readFileSync("docs/usage.md", "utf8");
    
    // Should not document --lan flag
    expect(usage).not.toContain("climon server --lan");
  });

  test("usage docs do not contain stale token query parameter", () => {
    const usage = readFileSync("docs/usage.md", "utf8");
    
    // Should not document ?token=<token> URL behavior
    expect(usage).not.toContain("?token=<token>");
  });

  test("setup docs contain complete default config example", () => {
    const setup = readFileSync("docs/setup.md", "utf8");
    
    // Should contain all default config fields with correct values
    expect(setup).toContain('"detachPrefix": 28');
    expect(setup).toContain('"setTitle": true');
    expect(setup).toContain('"idleSeconds": 10');
    expect(setup).toContain('"priority": 500');
  });

  test("setup docs do not contain stale server.lan or server.token fields", () => {
    const setup = readFileSync("docs/setup.md", "utf8");
    
    // Should not contain removed config fields in the config example
    expect(setup).not.toContain('"lan"');
    expect(setup).not.toContain('"token"');
  });

  test("troubleshooting docs do not contain stale LAN/token references", () => {
    const troubleshooting = readFileSync("docs/troubleshooting.md", "utf8");
    
    // Should not document removed --lan flag
    expect(troubleshooting).not.toContain("climon server --lan");
    
    // Should not document removed ?token= query parameter behavior
    expect(troubleshooting).not.toContain("?token=");
    expect(troubleshooting).not.toContain("?token=<token>");
  });
});
