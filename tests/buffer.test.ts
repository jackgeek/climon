import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { ScrollbackBuffer } from "../src/daemon/buffer.js";

describe("ScrollbackBuffer", () => {
  test("accumulates appended data", () => {
    const buffer = new ScrollbackBuffer(1024);
    buffer.append("hello ");
    buffer.append("world");
    expect(buffer.snapshot().toString("utf8")).toBe("hello world");
    expect(buffer.byteLength).toBe(11);
  });

  test("trims oldest bytes beyond capacity", () => {
    const buffer = new ScrollbackBuffer(10);
    buffer.append("0123456789");
    buffer.append("ABCDE");
    const snapshot = buffer.snapshot().toString("utf8");
    expect(snapshot.length).toBe(10);
    expect(snapshot).toBe("56789ABCDE");
  });

  test("ignores empty appends", () => {
    const buffer = new ScrollbackBuffer(10);
    buffer.append("");
    buffer.append(Buffer.alloc(0));
    expect(buffer.byteLength).toBe(0);
  });

  test("trims a partial leading chunk", () => {
    const buffer = new ScrollbackBuffer(4);
    buffer.append("abcdef");
    expect(buffer.snapshot().toString("utf8")).toBe("cdef");
  });
});
