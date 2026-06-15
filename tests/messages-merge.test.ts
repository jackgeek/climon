import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeFragments } from "../scripts/extract-messages.js";
import type { Catalog } from "../src/i18n/types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "frag-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFragment(name: string, body: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(body));
}

describe("mergeFragments", () => {
  test("allocates an id for a new key and keeps t/params", () => {
    writeFragment("a.json", {
      "remote.connect": { t: "connecting to {host}", params: { host: { redact: true, category: "hostname" } } },
    });
    const { catalog, merged } = mergeFragments({}, dir);
    expect(merged).toBe(1);
    expect(catalog["remote.connect"].t).toBe("connecting to {host}");
    expect(catalog["remote.connect"].params.host).toEqual({ redact: true, category: "hostname" });
    expect(catalog["remote.connect"].id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("preserves an existing key's id while updating t/params", () => {
    const existing: Catalog = { "remote.connect": { id: "abcdef01", t: "old", params: {} } };
    writeFragment("a.json", { "remote.connect": { t: "new {host}", params: { host: { redact: true, category: "hostname" } } } });
    const { catalog } = mergeFragments(existing, dir);
    expect(catalog["remote.connect"].id).toBe("abcdef01");
    expect(catalog["remote.connect"].t).toBe("new {host}");
  });

  test("assigns distinct ids across multiple fragments", () => {
    writeFragment("a.json", { "k.one": { t: "one", params: {} } });
    writeFragment("b.json", { "k.two": { t: "two", params: {} } });
    const { catalog, merged } = mergeFragments({}, dir);
    expect(merged).toBe(2);
    expect(catalog["k.one"].id).not.toBe(catalog["k.two"].id);
  });

  test("returns the input unchanged when the fragment dir is empty", () => {
    const { catalog, merged } = mergeFragments({}, dir);
    expect(merged).toBe(0);
    expect(catalog).toEqual({});
  });
});
