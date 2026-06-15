import { describe, expect, test } from "bun:test";
import { compactRecord, redactParams } from "../src/logging/appinsights-transform.js";
import type { Catalog } from "../src/i18n/types.js";

const CAT: Catalog = {
  "srv.connect_failed": {
    id: "0000000c",
    t: "connect to {host}:{port} failed for {user}",
    params: {
      host: { redact: true, category: "hostname" },
      port: { redact: false },
      user: { redact: true, category: "pii" },
    },
  },
  "srv.started": { id: "0000000d", t: "server started", params: {} },
};

describe("redactParams", () => {
  test("replaces redacted params with a typed marker", () => {
    const out = redactParams({ host: "h1", port: 22, user: "alice" }, CAT["srv.connect_failed"]);
    expect(out.host).toBe("[REDACTED:hostname]");
    expect(out.user).toBe("[REDACTED:pii]");
  });

  test("leaves non-redacted params untouched", () => {
    const out = redactParams({ host: "h1", port: 22, user: "alice" }, CAT["srv.connect_failed"]);
    expect(out.port).toBe(22);
  });

  test("uses generic marker when a redacted param has no category", () => {
    const entry = { id: "00000001", t: "x {v}", params: { v: { redact: true } } };
    expect(redactParams({ v: "secret" }, entry).v).toBe("[REDACTED:generic]");
  });

  test("passes the record through unchanged when entry is undefined", () => {
    expect(redactParams({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  test("ignores fields with no matching param meta", () => {
    expect(redactParams({ extra: "x" }, CAT["srv.started"]).extra).toBe("x");
  });
});

describe("compactRecord", () => {
  test("catalogued record: message becomes the hex id and rendered text is dropped", () => {
    const rec = {
      level: 20,
      time: 1,
      role: "server",
      installId: "iid",
      msgId: "0000000c",
      msgKey: "srv.connect_failed",
      host: "h1",
      port: 22,
      user: "alice",
      msg: "connect to h1:22 failed for alice",
    };
    const out = compactRecord(rec, CAT);
    expect(out.msg).toBe("0000000c");
    expect(out.msg).not.toContain("h1");
    expect(out.msg).not.toContain("alice");
  });

  test("catalogued record: redact:true params become markers, others stay flat", () => {
    const rec = {
      msgId: "0000000c",
      msgKey: "srv.connect_failed",
      host: "h1",
      port: 22,
      user: "alice",
      msg: "connect to h1:22 failed for alice",
    };
    const out = compactRecord(rec, CAT);
    expect(out.host).toBe("[REDACTED:hostname]");
    expect(out.user).toBe("[REDACTED:pii]");
    expect(out.port).toBe(22);
  });

  test("catalogued record: preserves installId, role and level", () => {
    const rec = {
      level: 20, role: "server", installId: "iid",
      msgId: "0000000d", msgKey: "srv.started", msg: "server started",
    };
    const out = compactRecord(rec, CAT);
    expect(out.installId).toBe("iid");
    expect(out.role).toBe("server");
    expect(out.level).toBe(20);
  });

  test("uncatalogued record: assigns sentinel id and keeps the text (migration)", () => {
    const rec = { level: 30, role: "server", msg: "legacy interpolated message" };
    const out = compactRecord(rec, CAT);
    expect(out.msgId).toBe("00000000");
    expect(out.msg).toBe("legacy interpolated message");
  });

  test("does not mutate the input record", () => {
    const rec = { msgId: "0000000c", msgKey: "srv.connect_failed", host: "h1", msg: "x" };
    compactRecord(rec, CAT);
    expect(rec.msg).toBe("x");
    expect(rec.host).toBe("h1");
  });
});

import { createCompactingTransform } from "../src/logging/appinsights-transform.js";

describe("createCompactingTransform stream", () => {
  function run(input: string[]): Promise<string> {
    return new Promise((resolve) => {
      const t = createCompactingTransform(CAT);
      const out: string[] = [];
      t.on("data", (c: Buffer) => out.push(c.toString()));
      t.on("end", () => resolve(out.join("")));
      for (const chunk of input) t.write(chunk);
      t.end();
    });
  }

  test("compacts a whole NDJSON line", async () => {
    const line = JSON.stringify({ msgId: "0000000c", msgKey: "srv.connect_failed", host: "h1", port: 22, user: "a", msg: "connect to h1:22 failed for a" }) + "\n";
    const result = await run([line]);
    const rec = JSON.parse(result.trim());
    expect(rec.msg).toBe("0000000c");
    expect(rec.host).toBe("[REDACTED:hostname]");
  });

  test("handles input split across chunk boundaries", async () => {
    const line = JSON.stringify({ msgId: "0000000d", msgKey: "srv.started", msg: "server started" }) + "\n";
    const mid = Math.floor(line.length / 2);
    const result = await run([line.slice(0, mid), line.slice(mid)]);
    const rec = JSON.parse(result.trim());
    expect(rec.msg).toBe("0000000d");
  });

  test("forwards an unparseable line unchanged", async () => {
    const result = await run(["not json\n"]);
    expect(result.trim()).toBe("not json");
  });
});
