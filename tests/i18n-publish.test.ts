import { describe, expect, test } from "bun:test";
import { toLookupRows, toCsv, toJsonLookup } from "../src/i18n/publish.js";
import type { Catalog } from "../src/i18n/types.js";

const CATALOG: Catalog = {
  "telemetry.seed": { id: "0001a2b3", t: "telemetry catalog initialized", hint: "catalog bootstrap marker", params: {} },
  "daemon.probe": {
    id: "ffaa0011",
    t: "probing {host} on port {port}",
    hint: "daemon health probe of a host/port",
    params: {
      host: { redact: true, category: "hostname" },
      port: { redact: false },
    },
  },
};

describe("toLookupRows", () => {
  test("flattens each entry into id/key/template/hint/params/redacted", () => {
    const rows = toLookupRows(CATALOG);
    expect(rows).toEqual([
      {
        id: "ffaa0011",
        key: "daemon.probe",
        template: "probing {host} on port {port}",
        hint: "daemon health probe of a host/port",
        params: "host,port",
        redacted: "host",
      },
      {
        id: "0001a2b3",
        key: "telemetry.seed",
        template: "telemetry catalog initialized",
        hint: "catalog bootstrap marker",
        params: "",
        redacted: "",
      },
    ]);
  });

  test("sorts rows by key for deterministic output", () => {
    const rows = toLookupRows(CATALOG);
    expect(rows.map((r) => r.key)).toEqual(["daemon.probe", "telemetry.seed"]);
  });
});

describe("toCsv", () => {
  test("emits a header row followed by one row per entry", () => {
    const csv = toCsv(CATALOG);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("id,key,template,hint,params,redacted");
    expect(lines).toHaveLength(3);
  });

  test("quotes and escapes fields containing commas or quotes", () => {
    const catalog: Catalog = {
      tricky: {
        id: "00000001",
        t: 'say "hi", then {name}',
        hint: "greeting with an embedded name",
        params: { name: { redact: false } },
      },
    };
    const csv = toCsv(catalog);
    const line = csv.trimEnd().split("\n")[1];
    expect(line).toBe(
      '00000001,tricky,"say ""hi"", then {name}",greeting with an embedded name,name,',
    );
  });

  test("ends with a trailing newline", () => {
    expect(toCsv(CATALOG).endsWith("\n")).toBe(true);
  });
});

describe("toJsonLookup", () => {
  test("emits a JSON array of lookup rows", () => {
    const parsed = JSON.parse(toJsonLookup(CATALOG));
    expect(parsed).toEqual(toLookupRows(CATALOG));
  });
});
