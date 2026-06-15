import { describe, expect, test } from "bun:test";
import { logMsg, SENTINEL_MSG_ID } from "../src/i18n/log-msg.js";
import type { Catalog } from "../src/i18n/types.js";

const CAT: Catalog = {
  "srv.probe": {
    id: "0000000b",
    t: "probing {url}health",
    params: { url: { redact: false } },
  },
  "srv.connect_failed": {
    id: "0000000c",
    t: "connect to {host} failed",
    params: { host: { redact: true, category: "hostname" } },
  },
};

interface Call {
  level: string;
  obj: Record<string, unknown>;
  msg: string;
}

function fakeLogger(calls: Call[]) {
  const make = (level: string) => (obj: Record<string, unknown>, msg: string) =>
    calls.push({ level, obj, msg });
  return {
    trace: make("trace"),
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    fatal: make("fatal"),
  };
}

describe("logMsg", () => {
  test("renders the full message text for local streams", () => {
    const calls: Call[] = [];
    logMsg(fakeLogger(calls) as never, "debug", "srv.probe", { url: "https://x/" }, CAT);
    expect(calls[0].msg).toBe("probing https://x/health");
  });

  test("calls the matching level method", () => {
    const calls: Call[] = [];
    logMsg(fakeLogger(calls) as never, "warn", "srv.probe", { url: "u" }, CAT);
    expect(calls[0].level).toBe("warn");
  });

  test("attaches the catalog msgId and key", () => {
    const calls: Call[] = [];
    logMsg(fakeLogger(calls) as never, "debug", "srv.connect_failed", { host: "h" }, CAT);
    expect(calls[0].obj.msgId).toBe("0000000c");
    expect(calls[0].obj.msgKey).toBe("srv.connect_failed");
  });

  test("attaches the raw args under 'args' for the AI emitter", () => {
    const calls: Call[] = [];
    logMsg(fakeLogger(calls) as never, "debug", "srv.connect_failed", { host: "h" }, CAT);
    expect(calls[0].obj.args).toEqual({ host: "h" });
  });

  test("uses the sentinel id for an uncatalogued key and keeps the key as text", () => {
    const calls: Call[] = [];
    logMsg(fakeLogger(calls) as never, "info", "not.in.catalog", {}, CAT);
    expect(calls[0].obj.msgId).toBe(SENTINEL_MSG_ID);
    expect(calls[0].msg).toBe("not.in.catalog");
  });

  test("works with no params argument", () => {
    const calls: Call[] = [];
    const cat: Catalog = { "x.static": { id: "00000abc", t: "hi", params: {} } };
    logMsg(fakeLogger(calls) as never, "info", "x.static", undefined, cat);
    expect(calls[0].msg).toBe("hi");
    expect(calls[0].obj.args).toEqual({});
  });
});
