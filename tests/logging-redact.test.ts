import { describe, expect, test } from "bun:test";
import pino from "pino";
import { REDACT_OPTIONS } from "../src/logging/redact.js";

function capture(): { lines: string[]; stream: NodeJS.WritableStream } {
  const lines: string[] = [];
  const stream = {
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { lines, stream };
}

describe("REDACT_OPTIONS", () => {
  test("censors known sensitive keys to [REDACTED]", () => {
    const { lines, stream } = capture();
    const log = pino({ level: "info", redact: REDACT_OPTIONS }, stream);
    log.info({ connectionString: "InstrumentationKey=secret", nested: { token: "abc" } }, "hi");
    const record = JSON.parse(lines.join(""));
    expect(record.connectionString).toBe("[REDACTED]");
    expect(record.nested.token).toBe("[REDACTED]");
    expect(record.msg).toBe("hi");
  });
});
