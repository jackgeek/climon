import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsoncConfig, renderJsoncConfig } from "../src/config-jsonc.js";
import {
  buildDefaultConfigFromSettings,
  renderConfigSettingsHelp,
  renderConfigSettingsTable,
} from "../src/config-settings.js";
import { renderConfigDocsSection } from "../scripts/generate-config-docs.js";

const DIR = join("fixtures", "config");
const read = (name: string): string => readFileSync(join(DIR, name), "utf8");
const readJson = <T>(name: string): T => JSON.parse(read(name)) as T;

describe("config cross-language golden fixtures", () => {
  test("parse cases match the shared corpus", () => {
    const cases = readJson<Array<{ name: string; input: string; expected: Record<string, unknown> }>>(
      "parse-cases.json"
    );
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(parseJsoncConfig(c.input, `/fixtures/${c.name}.jsonc`)).toEqual(c.expected);
    }
  });

  test("parse error cases reproduce the shared messages", () => {
    const cases = readJson<Array<{ name: string; input: string; errorContains: string }>>(
      "parse-error-cases.json"
    );
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(() => parseJsoncConfig(c.input, `/fixtures/${c.name}.jsonc`)).toThrow(
        new RegExp(c.errorContains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      );
    }
  });

  test("render cases match the shared corpus byte-for-byte", () => {
    const cases = readJson<Array<{ name: string; input: Record<string, unknown>; expected: string }>>(
      "render-cases.json"
    );
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(renderJsoncConfig(c.input)).toBe(c.expected);
    }
  });

  test("default config + rendered output match the fixtures", () => {
    expect(buildDefaultConfigFromSettings()).toEqual(readJson("default-config.json"));
    expect(renderJsoncConfig(buildDefaultConfigFromSettings() as unknown as Record<string, unknown>)).toBe(
      read("default-rendered.jsonc")
    );
  });

  test("settings table, help, and docs section match the fixtures", () => {
    expect(renderConfigSettingsTable()).toBe(read("settings-table.md"));
    expect(renderConfigSettingsHelp()).toBe(read("settings-help.txt"));
    expect(renderConfigDocsSection()).toBe(read("docs-section.md"));
  });
});
