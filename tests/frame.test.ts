import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  encodeFrame,
  encodeJsonFrame,
  FrameDecoder,
  FrameType,
  parseJsonPayload,
  type ResizePayload,
  type AttentionPayload
} from "../src/ipc/frame.js";

describe("frame codec", () => {
  test("round-trips a single frame", () => {
    const frame = encodeFrame(FrameType.Output, "hello");
    const decoded = new FrameDecoder().push(frame);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].type).toBe(FrameType.Output);
    expect(decoded[0].payload.toString("utf8")).toBe("hello");
  });

  test("decodes multiple frames in one chunk", () => {
    const combined = Buffer.concat([
      encodeFrame(FrameType.Output, "a"),
      encodeFrame(FrameType.Input, "b")
    ]);
    const decoded = new FrameDecoder().push(combined);
    expect(decoded.map((f) => f.payload.toString("utf8"))).toEqual(["a", "b"]);
  });

  test("handles frames split across chunks", () => {
    const frame = encodeFrame(FrameType.Output, "splitme");
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toHaveLength(0);
    const rest = decoder.push(frame.subarray(3));
    expect(rest).toHaveLength(1);
    expect(rest[0].payload.toString("utf8")).toBe("splitme");
  });

  test("encodes and parses json frames", () => {
    const frame = encodeJsonFrame(FrameType.Resize, { cols: 100, rows: 40 });
    const decoded = new FrameDecoder().push(frame)[0];
    expect(decoded.type).toBe(FrameType.Resize);
    expect(parseJsonPayload<ResizePayload>(decoded.payload)).toEqual({ cols: 100, rows: 40 });
  });

  test("handles empty payloads", () => {
    const frame = encodeFrame(FrameType.Exit);
    const decoded = new FrameDecoder().push(frame)[0];
    expect(decoded.payload.length).toBe(0);
  });

  test("round-trips an attention frame payload", () => {
    const frame = encodeJsonFrame(FrameType.Attention, {
      needsAttention: true,
      reason: "Screen idle for 10s"
    });
    const decoded = new FrameDecoder().push(frame)[0];
    expect(decoded.type).toBe(FrameType.Attention);
    expect(parseJsonPayload<AttentionPayload>(decoded.payload)).toEqual({
      needsAttention: true,
      reason: "Screen idle for 10s"
    });
  });

  test("round-trips a Title frame", () => {
    const frame = encodeJsonFrame(FrameType.Title, { name: "dev server" });
    const decoded = new FrameDecoder().push(frame);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].type).toBe(FrameType.Title);
    expect(parseJsonPayload<{ name: string }>(decoded[0].payload)).toEqual({ name: "dev server" });
  });
});
