import { describe, expect, test } from "bun:test";
import pino from "pino";
import { createPrettyStream, setTerminalSuspended } from "../src/logging/pretty.js";

function capture() {
  const data: string[] = [];
  return {
    data,
    stream: { write(c: string) { data.push(c); return true; } } as unknown as NodeJS.WritableStream,
  };
}

describe("createPrettyStream", () => {
  test("routes info/warn to out, error/fatal to err", async () => {
    setTerminalSuspended(false);
    const out = capture();
    const err = capture();
    const pretty = createPrettyStream({ out: out.stream, err: err.stream });
    const log = pino({ level: "trace" }, pino.multistream([{ stream: pretty, level: "info" }]));
    log.info("an info");
    log.warn("a warn");
    log.error("an error");
    log.debug("a debug");
    await new Promise((r) => setTimeout(r, 50));
    expect(out.data.join("")).toContain("an info");
    expect(out.data.join("")).toContain("a warn");
    expect(out.data.join("")).not.toContain("an error");
    expect(err.data.join("")).toContain("an error");
    expect(out.data.join("")).not.toContain("a debug");
  });

  test("suspended terminal mutes both streams", async () => {
    const out = capture();
    const err = capture();
    const pretty = createPrettyStream({ out: out.stream, err: err.stream });
    const log = pino({ level: "trace" }, pino.multistream([{ stream: pretty, level: "info" }]));
    setTerminalSuspended(true);
    log.info("hidden");
    log.error("hidden too");
    await new Promise((r) => setTimeout(r, 50));
    expect(out.data.join("")).toBe("");
    expect(err.data.join("")).toBe("");
    setTerminalSuspended(false);
  });
});
