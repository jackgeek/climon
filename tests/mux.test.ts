import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { encodeControl, encodeData, MuxDecoder, MAX_MUX_PAYLOAD } from "../src/remote/mux.js";
import type { ControlMessage } from "../src/remote/mux.js";
import type { SessionMeta } from "../src/types.js";

const meta = { id: "s1", displayCommand: "npm test" } as unknown as SessionMeta;

describe("mux round-trip", () => {
  test("encodes and decodes a control message", () => {
    const decoder = new MuxDecoder();
    const out = decoder.push(encodeControl({ kind: "session-added", meta }));
    expect(out).toEqual([{ type: "control", message: { kind: "session-added", meta } }]);
  });

  test("encodes and decodes a data message", () => {
    const decoder = new MuxDecoder();
    const out = decoder.push(encodeData("sess-1", Buffer.from([1, 2, 3, 4])));
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ type: "data", sessionId: "sess-1" });
    expect((out[0] as { data: Buffer }).data).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("reassembles a frame split across chunks", () => {
    const frame = encodeData("x", Buffer.from("hello", "utf8"));
    const decoder = new MuxDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    const out = decoder.push(frame.subarray(3));
    expect((out[0] as { data: Buffer }).data.toString()).toBe("hello");
  });

  test("decodes multiple frames in one chunk", () => {
    const decoder = new MuxDecoder();
    const buf = Buffer.concat([
      encodeControl({ kind: "session-removed", id: "a" }),
      encodeData("b", Buffer.from("z", "utf8"))
    ]);
    const out = decoder.push(buf);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ type: "control", message: { kind: "session-removed", id: "a" } });
    expect(out[1]).toMatchObject({ type: "data", sessionId: "b" });
  });

  test("rejects an oversized frame", () => {
    const decoder = new MuxDecoder();
    const header = Buffer.alloc(5);
    header.writeUInt32BE(MAX_MUX_PAYLOAD + 1, 0);
    header.writeUInt8(2, 4);
    expect(() => decoder.push(header)).toThrow();
  });

  test("encodes and decodes attach/detach control", () => {
    const decoder = new MuxDecoder();
    const out = decoder.push(Buffer.concat([
      encodeControl({ kind: "attach", id: "s1" }),
      encodeControl({ kind: "detach", id: "s1" })
    ]));
    expect(out).toEqual([
      { type: "control", message: { kind: "attach", id: "s1" } },
      { type: "control", message: { kind: "detach", id: "s1" } }
    ]);
  });

  test("encodes and decodes a hello control frame", () => {
    const decoder = new MuxDecoder();
    const frame = encodeControl({ kind: "hello", clientId: "devbox-abc" });
    const msgs = decoder.push(frame);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: "control", message: { kind: "hello", clientId: "devbox-abc" } });
  });

  test("encodes and decodes spawn, spawn-result and signed control frames", () => {
    const decoder = new MuxDecoder();
    const spawn: ControlMessage = {
      kind: "spawn",
      requestId: "r1",
      command: ["bash", "-lc", "top"],
      cwd: "/home/me",
      cols: 80,
      rows: 24,
      name: "build",
      priority: 5,
      color: "red",
      headless: false
    };
    const result: ControlMessage = { kind: "spawn-result", requestId: "r1", id: "dev~abc" };
    const signed: ControlMessage = {
      kind: "signed",
      payload: '{"kind":"ping"}',
      nonce: "deadbeef",
      ts: 1718900000000,
      sig: "abc123"
    };
    const buf = Buffer.concat([encodeControl(spawn), encodeControl(result), encodeControl(signed)]);
    const out = decoder.push(buf);
    expect(out).toEqual([
      { type: "control", message: spawn },
      { type: "control", message: result },
      { type: "control", message: signed }
    ]);
  });
});
