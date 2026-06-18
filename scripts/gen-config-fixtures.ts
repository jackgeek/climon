// Generates the cross-language config golden corpus under `fixtures/config/`.
// Both the Bun suite (`tests/config-fixtures.test.ts`) and the Rust integration
// test (`rust/climon-config/tests/fixtures.rs`) assert against these files, so
// the corpus is the single source of truth for Rust<->Bun config parity.
//
// Run from the repo root: `bun scripts/gen-config-fixtures.ts`
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsoncConfig, renderJsoncConfig } from "../src/config-jsonc.js";
import {
  buildDefaultConfigFromSettings,
  renderConfigSettingsTable,
  renderConfigSettingsHelp,
} from "../src/config-settings.js";
import { renderConfigDocsSection } from "./generate-config-docs.js";

const OUT_DIR = join("fixtures", "config");
mkdirSync(OUT_DIR, { recursive: true });

function writeText(name: string, content: string): void {
  writeFileSync(join(OUT_DIR, name), content);
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(OUT_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
}

// --- parse cases: JSONC input -> parsed value -----------------------------
const parseInputs: Array<{ name: string; input: string }> = [
  {
    name: "line-and-block-comments",
    input: `{
      // Dashboard host.
      "server": {
        "host": "127.0.0.1",
        /* Dashboard port. */
        "port": 3131
      }
    }`,
  },
  {
    name: "comment-like-text-in-strings",
    input: `{
      "url": "http://example.com/path",
      "lineComment": "// not a comment",
      "blockComment": "/* not a comment */",
      "escapedQuote": "quote: \\" // still text"
    }`,
  },
  {
    name: "nested-and-unknown-keys",
    input: `{
      "version": 1,
      "remote": { "enabled": true, "tunnelId": "abc123", "port": 3132 },
      "custom": { "value": true, "nested": { "deep": [1, 2, 3] } }
    }`,
  },
  {
    name: "empty-object",
    input: `{}`,
  },
];
const parseCases = parseInputs.map(({ name, input }) => ({
  name,
  input,
  expected: parseJsoncConfig(input, `/fixtures/${name}.jsonc`),
}));
writeJson("parse-cases.json", parseCases);

// --- parse error cases: JSONC input -> error substring --------------------
const parseErrorInputs: Array<{ name: string; input: string; errorContains: string }> = [
  { name: "truncated-object", input: "{", errorContains: "Invalid JSONC in" },
  { name: "array-root", input: "[]", errorContains: "Invalid JSONC in" },
  { name: "string-root", input: '"value"', errorContains: "Invalid JSONC in" },
  { name: "number-root", input: "1", errorContains: "Invalid JSONC in" },
  { name: "null-root", input: "null", errorContains: "Invalid JSONC in" },
  {
    name: "unterminated-block-comment",
    input: '{"a": 1 /* unterminated',
    errorContains: "Unterminated block comment",
  },
];
const parseErrorCases = parseErrorInputs.map(({ name, input, errorContains }) => {
  let message = "";
  try {
    parseJsoncConfig(input, `/fixtures/${name}.jsonc`);
    throw new Error(`expected parse failure for ${name}`);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (!message.includes(errorContains)) {
    throw new Error(`fixture ${name}: message "${message}" missing "${errorContains}"`);
  }
  return { name, input, errorContains };
});
writeJson("parse-error-cases.json", parseErrorCases);

// --- render cases: config object -> rendered JSONC ------------------------
const renderInputs: Array<{ name: string; input: Record<string, unknown> }> = [
  { name: "default-config", input: buildDefaultConfigFromSettings() as Record<string, unknown> },
  {
    name: "known-and-unknown-ordering",
    input: { zzz: true, session: { color: "auto" }, server: { port: 3131 }, aaa: true, version: 1 },
  },
  { name: "unknown-only", input: { custom: { value: true } } },
  { name: "empty-nested", input: { server: {}, custom: {} } },
  { name: "sparse-remote", input: { version: 1, remote: { tunnelId: "abc123" } } },
];
const renderCases = renderInputs.map(({ name, input }) => ({
  name,
  input,
  expected: renderJsoncConfig(input),
}));
writeJson("render-cases.json", renderCases);

// --- standalone golden artifacts ------------------------------------------
const defaultConfig = buildDefaultConfigFromSettings();
writeJson("default-config.json", defaultConfig);
writeText("default-rendered.jsonc", renderJsoncConfig(defaultConfig as Record<string, unknown>));
writeText("settings-table.md", renderConfigSettingsTable());
writeText("settings-help.txt", renderConfigSettingsHelp());
writeText("docs-section.md", renderConfigDocsSection());

console.log("wrote config fixtures to", OUT_DIR);
