import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { parseTitleReply, queryTerminalTitle } from "../src/client/query-title.js";

describe("parseTitleReply", () => {
  test("parses an ST-terminated reply", () => {
    expect(parseTitleReply(Buffer.from("\x1b]lmy title\x1b\\"))).toBe("my title");
  });

  test("parses a BEL-terminated reply", () => {
    expect(parseTitleReply(Buffer.from("\x1b]lmy title\x07"))).toBe("my title");
  });

  test("returns undefined when the reply is incomplete", () => {
    expect(parseTitleReply(Buffer.from("\x1b]lmy tit"))).toBeUndefined();
  });

  test("returns undefined when there is no reply marker", () => {
    expect(parseTitleReply(Buffer.from("garbage"))).toBeUndefined();
  });
});

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this { this.isRaw = value; return this; }
  resume(): this { return this; }
  pause(): this { return this; }
}

function fakeStdout() {
  const writes: string[] = [];
  return { isTTY: true, writes, write: (s: string) => { writes.push(s); return true; } };
}

describe("queryTerminalTitle", () => {
  test("resolves the title from a terminal reply and writes the query", async () => {
    const stdin = new FakeStdin();
    const stdout = fakeStdout();
    const promise = queryTerminalTitle({ stdin, stdout, timeoutMs: 1000 });
    expect(stdout.writes).toEqual(["\x1b[21t"]);
    stdin.emit("data", Buffer.from("\x1b]lwindow title\x1b\\"));
    expect(await promise).toBe("window title");
    expect(stdin.isRaw).toBe(false); // restored
  });

  test("resolves undefined on timeout", async () => {
    const stdin = new FakeStdin();
    const stdout = fakeStdout();
    expect(await queryTerminalTitle({ stdin, stdout, timeoutMs: 20 })).toBeUndefined();
  });

  test("resolves undefined when not a TTY", async () => {
    const stdin = new FakeStdin();
    stdin.isTTY = false;
    const stdout = fakeStdout();
    expect(await queryTerminalTitle({ stdin, stdout, timeoutMs: 1000 })).toBeUndefined();
    expect(stdout.writes).toEqual([]);
  });
});
