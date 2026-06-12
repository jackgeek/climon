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
      remote: { tunnelId: "abc123" }
    });

    expect(rendered).toContain("// Schema version for the persisted config.json format. Always 1 for the current release.");
    expect(rendered).toContain('"version": 1');
    expect(rendered).toContain("// Specifies the default accent color for new sessions. Accepts ANSI color names (red, green, etc.), 'none', or 'auto' for automatic assignment.");
    expect(rendered).toContain('"color": "auto"');
    expect(rendered).toContain("// Dev tunnel id");
    expect(rendered).toContain('"tunnelId": "abc123"');
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

  test("reports unterminated block comment with path", () => {
    expect(() => parseJsoncConfig('{"a": 1 /* unterminated', "/tmp/bad-comment.config.jsonc"))
      .toThrow(/Unterminated block comment/);
    expect(() => parseJsoncConfig('{"a": 1 /* unterminated', "/tmp/bad-comment.config.jsonc"))
      .toThrow(/\/tmp\/bad-comment\.config\.jsonc/);
  });

  test("parent container keys do not get generated comments", () => {
    const rendered = renderJsoncConfig({
      server: { host: "127.0.0.1" }
    });

    const lines = rendered.split("\n");
    const serverLineIndex = lines.findIndex(line => line.includes('"server":'));
    expect(serverLineIndex).toBeGreaterThanOrEqual(0);
    
    // The line before "server": should not be a comment
    const previousLine = lines[serverLineIndex - 1];
    expect(previousLine).not.toMatch(/^\s*\/\//);
    
    // But the host setting should have its purpose comment
    expect(rendered).toContain("// IP address the dashboard server binds to");
    expect(rendered).toContain('"host": "127.0.0.1"');
  });

  test("renders empty nested objects without errors", () => {
    const rendered = renderJsoncConfig({
      server: {},
      custom: {}
    });

    expect(rendered).toContain('"server": {}');
    expect(rendered).toContain('"custom": {}');
    expect(rendered.endsWith("\n")).toBe(true);
  });

  test("renders known top-level keys in exact registry order", () => {
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
    expect(keys).toEqual(["version", "server", "session", "aaa", "zzz"]);
  });

  test("omits object keys with undefined values to prevent invalid JSONC", () => {
    const rendered = renderJsoncConfig({ version: 1, remote: undefined });
    
    expect(rendered).not.toContain("undefined");
    expect(rendered).not.toContain('"remote"');
    
    // Verify it can be parsed back successfully
    const parsed = parseJsoncConfig(rendered, "/test/round-trip.jsonc");
    expect(parsed.version).toBe(1);
    expect("remote" in parsed).toBe(false);
  });
});
