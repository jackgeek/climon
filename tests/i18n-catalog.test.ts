import { describe, expect, test } from "bun:test";
import {
  loadCatalog,
  lookupByKey,
  renderTemplate,
  renderMessage,
  validateCatalog,
} from "../src/i18n/catalog.js";
import type { Catalog } from "../src/i18n/types.js";

const FIXTURE: Catalog = {
  "test.simple": { id: "0000000a", t: "a static message", hint: "a simple static log line", params: {} },
  "test.one_param": {
    id: "0000000b",
    t: "probing {url}health",
    hint: "health-probe diagnostic",
    params: { url: { redact: false } },
  },
  "test.multi": {
    id: "0000000c",
    t: "connect to {host}:{port} failed",
    hint: "connection failure to a remote host",
    params: {
      host: { redact: true, category: "hostname" },
      port: { redact: false },
    },
  },
};

describe("i18n catalog render", () => {
  test("renderTemplate substitutes named params", () => {
    expect(renderTemplate("probing {url}health", { url: "https://x/" })).toBe(
      "probing https://x/health",
    );
  });

  test("renderTemplate leaves a placeholder intact when param missing", () => {
    expect(renderTemplate("hi {name}", {})).toBe("hi {name}");
  });

  test("renderTemplate stringifies non-string params", () => {
    expect(renderTemplate("port {port}", { port: 8080 })).toBe("port 8080");
  });

  test("renderTemplate handles a param used twice", () => {
    expect(renderTemplate("{x}-{x}", { x: "z" })).toBe("z-z");
  });

  test("lookupByKey returns the entry", () => {
    expect(lookupByKey(FIXTURE, "test.one_param")?.id).toBe("0000000b");
  });

  test("lookupByKey returns undefined for unknown key", () => {
    expect(lookupByKey(FIXTURE, "nope")).toBeUndefined();
  });

  test("renderMessage resolves key + params to full text", () => {
    expect(renderMessage(FIXTURE, "test.multi", { host: "h", port: 22 })).toBe(
      "connect to h:22 failed",
    );
  });

  test("renderMessage falls back to the key when key is unknown", () => {
    expect(renderMessage(FIXTURE, "missing.key", {})).toBe("missing.key");
  });

  test("validateCatalog passes for a well-formed catalog", () => {
    expect(() => validateCatalog(FIXTURE)).not.toThrow();
  });

  test("validateCatalog rejects duplicate ids", () => {
    const bad = {
      "a": { id: "0000000a", t: "x", hint: "h", params: {} },
      "b": { id: "0000000a", t: "y", hint: "h", params: {} },
    };
    expect(() => validateCatalog(bad)).toThrow(/duplicate id/i);
  });

  test("validateCatalog rejects ids that are not 8 hex digits", () => {
    const bad = { "a": { id: "xyz", t: "x", hint: "h", params: {} } };
    expect(() => validateCatalog(bad)).toThrow(/8 hex/i);
  });

  test("validateCatalog rejects a template placeholder with no param metadata", () => {
    const bad = { "a": { id: "0000000a", t: "hi {name}", hint: "h", params: {} } };
    expect(() => validateCatalog(bad)).toThrow(/name/);
  });

  test("validateCatalog rejects an entry with a missing or blank hint", () => {
    const bad = { "a": { id: "0000000a", t: "x", hint: "  ", params: {} } };
    expect(() => validateCatalog(bad)).toThrow(/hint/i);
  });

  test("validateCatalog skips the hint requirement when requireHints is false", () => {
    const noHint = { "a": { id: "0000000a", t: "x", hint: "", params: {} } };
    expect(() => validateCatalog(noHint, false)).not.toThrow();
  });

  test("loadCatalog reads and validates the real en catalog", () => {
    const cat = loadCatalog();
    expect(() => validateCatalog(cat)).not.toThrow();
  });
});
