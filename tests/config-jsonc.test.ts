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
});
