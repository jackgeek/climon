import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import pino from "pino";
import { REDACT_OPTIONS } from "../src/logging/redact.js";

interface RedactCase {
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

interface RedactFixture {
  censor: string;
  cases: RedactCase[];
}

/** Logs `input` through pino with REDACT_OPTIONS and returns the parsed record. */
function logAndCapture(input: Record<string, unknown>): Record<string, unknown> {
  let captured = "";
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      captured += chunk.toString();
      cb();
    },
  }) as unknown as NodeJS.WritableStream;
  const log = pino({ level: "info", redact: REDACT_OPTIONS }, stream);
  log.info(input, "fixture");
  const record = JSON.parse(captured.trim().split("\n").pop() as string);
  // Drop pino-added fields so only the (redacted) merge object remains.
  for (const key of ["level", "time", "pid", "hostname", "msg"]) delete record[key];
  return record;
}

describe("redaction golden fixtures (Bun ⇄ Rust)", () => {
  const fixture = JSON.parse(
    readFileSync("fixtures/logging/redact.json", "utf8"),
  ) as RedactFixture;

  test("corpus is non-empty", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixture.cases) {
    test(`pino redaction matches expected: ${c.name}`, () => {
      const record = logAndCapture(c.input);
      expect(record).toEqual(c.expected);
    });
  }
});
