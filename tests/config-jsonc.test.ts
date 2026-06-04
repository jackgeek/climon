import { describe, expect, test } from "bun:test";
import { parseJsoncConfig, renderJsoncConfig } from "../src/config-jsonc.js";

describe("config JSONC helpers", () => {
  test("parses line and block comments", () => {
    const parsed = parseJsoncConfig(`{
      // Dashboard host.
      "server": {
        "host": "127.0.0.1",
        /* Dashboard port. */
        "port": 3131
      }
    }`, "/test/config.jsonc");

    expect(parsed).toEqual({
      server: { host: "127.0.0.1", port: 3131 }
    });
  });

  test("reports path when JSONC parsing fails", () => {
    expect(() => parseJsoncConfig("{", "/test/bad.config.jsonc")).toThrow(/Invalid JSONC in \/test\/bad.config.jsonc/);
  });

  test("renders comments above known settings", () => {
    const rendered = renderJsoncConfig({
      version: 1,
      session: { color: "auto" },
      remote: { tunnelToken: "secret" }
    });

    expect(rendered).toContain("// Schema version for the persisted config.json format. Always 1 for the current release.");
    expect(rendered).toContain('"version": 1');
    expect(rendered).toContain("// Specifies the default accent color for new sessions. Accepts ANSI color names (red, green, etc.), 'none', or 'auto' for automatic assignment.");
    expect(rendered).toContain('"color": "auto"');
    expect(rendered).toContain("// Stores the dev tunnel connect token scoped to this tunnel. Supplied via DEVTUNNEL_ACCESS_TOKEN environment variable.");
    expect(rendered).toContain('"tunnelToken": "secret"');
    expect(rendered.endsWith("\n")).toBe(true);
  });

  test("preserves unknown keys as data without generated comments", () => {
    const rendered = renderJsoncConfig({
      custom: { value: true }
    });

    expect(rendered).toContain('"custom"');
    expect(rendered).toContain('"value": true');
    expect(rendered).not.toContain("// custom");
  });

  test("parses comment-like text inside strings unchanged", () => {
    const parsed = parseJsoncConfig(`{
      "url": "http://example.com/path",
      "lineComment": "// not a comment",
      "blockComment": "/* not a comment */",
      "escapedQuote": "quote: \\" // still text"
    }`, "/test/strings.jsonc");

    expect(parsed).toEqual({
      url: "http://example.com/path",
      lineComment: "// not a comment",
      blockComment: "/* not a comment */",
      escapedQuote: 'quote: " // still text'
    });
  });

  test("rejects non-object root: array", () => {
    expect(() => parseJsoncConfig("[]", "/test/bad-root.config.jsonc"))
      .toThrow(/Invalid JSONC in .*bad-root\.config\.jsonc/);
  });

  test("rejects non-object root: string", () => {
    expect(() => parseJsoncConfig('"value"', "/test/bad-root.config.jsonc"))
      .toThrow(/Invalid JSONC in .*bad-root\.config\.jsonc/);
  });

  test("rejects non-object root: number", () => {
    expect(() => parseJsoncConfig("1", "/test/bad-root.config.jsonc"))
      .toThrow(/Invalid JSONC in .*bad-root\.config\.jsonc/);
  });

  test("rejects non-object root: null", () => {
    expect(() => parseJsoncConfig("null", "/test/bad-root.config.jsonc"))
      .toThrow(/Invalid JSONC in .*bad-root\.config\.jsonc/);
  });

  test("renders known keys in registry order and unknown keys alphabetically after", () => {
    const rendered = renderJsoncConfig({
      zzz: true,
      session: { color: "auto" },
      server: { port: 3131 },
      aaa: true,
      version: 1
    });

    // Extract just the top-level keys in order
    const lines = rendered.split("\n");
    const keyLines = lines.filter(line => line.match(/^\s{2}"[^"]+":/));
    const keys = keyLines.map(line => {
      const match = line.match(/^\s{2}"([^"]+)":/);
      return match ? match[1] : "";
    });

    // version, server, session are known (in that registry order), aaa and zzz are unknown (alphabetical)
    expect(keys.indexOf("version")).toBeLessThan(keys.indexOf("server"));
    expect(keys.indexOf("server")).toBeLessThan(keys.indexOf("session"));
    expect(keys.indexOf("session")).toBeLessThan(keys.indexOf("aaa"));
    expect(keys.indexOf("aaa")).toBeLessThan(keys.indexOf("zzz"));
  });

  test("renders output with trailing newline", () => {
    const rendered = renderJsoncConfig({ version: 1 });
    expect(rendered.endsWith("\n")).toBe(true);
  });
});
