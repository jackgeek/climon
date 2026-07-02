import { describe, expect, test } from "bun:test";
import {
  allocateId,
  checkDrift,
  findMessageKeys,
  reconcile,
  sensitiveParamWarnings,
} from "../scripts/extract-messages.js";
import type { Catalog } from "../src/i18n/types.js";

describe("findMessageKeys", () => {
  test("extracts the key (3rd arg) from logMsg calls", () => {
    const src = `
      logMsg(getLogger(), "debug", "srv.probe", { url });
      logMsg(log, "info", "srv.started");
    `;
    expect(findMessageKeys(src).sort()).toEqual(["srv.probe", "srv.started"]);
  });

  test("ignores the level literal and unrelated strings", () => {
    const src = `const x = "info"; logMsg(l, "warn", "a.b", { y: "z" });`;
    expect(findMessageKeys(src)).toEqual(["a.b"]);
  });

  test("handles whitespace and newlines between args", () => {
    const src = `logMsg(\n  logger,\n  "error",\n  "deep.key",\n  { e }\n);`;
    expect(findMessageKeys(src)).toEqual(["deep.key"]);
  });

  test("returns empty for source with no logMsg", () => {
    expect(findMessageKeys(`const a = 1;`)).toEqual([]);
  });

  test("extracts the key from t() user-facing calls", () => {
    const src = `print(t("telemetry.prompt")); const s = t("update.banner", { current, next });`;
    expect(findMessageKeys(src).sort()).toEqual(["telemetry.prompt", "update.banner"]);
  });

  test("extracts keys from both logMsg and t in the same source", () => {
    const src = `logMsg(l, "info", "srv.started"); print(t("autoUpdate.prompt"));`;
    expect(findMessageKeys(src).sort()).toEqual(["autoUpdate.prompt", "srv.started"]);
  });

  test("does not match identifiers that merely end in t", () => {
    const src = `const a = split("x.y"); assert("nope"); await fetch("z");`;
    expect(findMessageKeys(src)).toEqual([]);
  });
});

describe("allocateId", () => {
  test("returns an 8 hex digit id", () => {
    expect(allocateId(new Set())).toMatch(/^[0-9a-f]{8}$/);
  });

  test("never returns an id already in use", () => {
    const used = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = allocateId(used);
      expect(used.has(id)).toBe(false);
      used.add(id);
    }
  });
});

describe("reconcile", () => {
  test("adds new keys with a freshly allocated id and key-as-template", () => {
    const cat: Catalog = {};
    const result = reconcile(cat, ["new.key"]);
    expect(result.catalog["new.key"].id).toMatch(/^[0-9a-f]{8}$/);
    expect(result.catalog["new.key"].t).toBe("new.key");
    expect(result.added).toEqual(["new.key"]);
  });

  test("preserves the id of an existing key", () => {
    const cat: Catalog = { "keep": { id: "0000abcd", t: "kept", hint: "h", params: {} } };
    const result = reconcile(cat, ["keep"]);
    expect(result.catalog["keep"].id).toBe("0000abcd");
    expect(result.added).toEqual([]);
  });

  test("reports orphaned keys (in catalog but unreferenced)", () => {
    const cat: Catalog = { "gone": { id: "0000abcd", t: "x", hint: "h", params: {} } };
    const result = reconcile(cat, []);
    expect(result.orphaned).toEqual(["gone"]);
  });

  test("does not allocate a colliding id for multiple new keys", () => {
    const cat: Catalog = {};
    const result = reconcile(cat, Array.from({ length: 50 }, (_, i) => `k.${i}`));
    const ids = Object.values(result.catalog).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("checkDrift", () => {
  test("returns keys referenced in source but missing from catalog", () => {
    const cat: Catalog = { "present": { id: "0000abcd", t: "x", hint: "h", params: {} } };
    expect(checkDrift(cat, ["present", "missing"])).toEqual(["missing"]);
  });

  test("returns empty when all referenced keys are present", () => {
    const cat: Catalog = { "a": { id: "0000abcd", t: "x", hint: "h", params: {} } };
    expect(checkDrift(cat, ["a"])).toEqual([]);
  });
});

describe("sensitiveParamWarnings", () => {
  test("warns when a sensitive-looking param is not redacted", () => {
    const cat: Catalog = {
      "x": { id: "0000abcd", t: "to {host}", hint: "h", params: { host: { redact: false } } },
    };
    const warns = sensitiveParamWarnings(cat);
    expect(warns.some((w) => w.includes("host"))).toBe(true);
  });

  test("does not warn when the sensitive param is redacted", () => {
    const cat: Catalog = {
      "x": { id: "0000abcd", t: "to {host}", hint: "h", params: { host: { redact: true, category: "hostname" } } },
    };
    expect(sensitiveParamWarnings(cat)).toEqual([]);
  });

  test("does not warn for a clearly non-sensitive param", () => {
    const cat: Catalog = {
      "x": { id: "0000abcd", t: "count {n}", hint: "h", params: { n: { redact: false } } },
    };
    expect(sensitiveParamWarnings(cat)).toEqual([]);
  });
});
