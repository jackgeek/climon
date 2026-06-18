import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { encodeFrame, FrameType } from "../src/ipc/frame.js";
import type { SessionMeta } from "../src/types.js";

describe("proto golden fixtures", () => {
  test("frame encodings match the shared corpus", () => {
    const entries = JSON.parse(readFileSync("fixtures/proto/frames.json", "utf8")) as Array<{
      name: string;
      type: number;
      payloadJson: string;
      hex: string;
    }>;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const frame = encodeFrame(entry.type as FrameType, entry.payloadJson);
      expect(Buffer.from(frame).toString("hex")).toBe(entry.hex);
    }
  });

  test("metadata fixtures parse and preserve the color three-state", () => {
    const minimal = JSON.parse(readFileSync("fixtures/proto/session-meta/minimal.json", "utf8")) as SessionMeta;
    expect(minimal.status).toBe("running");
    expect("color" in minimal).toBe(false);

    const full = JSON.parse(readFileSync("fixtures/proto/session-meta/full.json", "utf8")) as SessionMeta;
    expect(full.color).toBe("cyan");
    expect(full.priority).toBe(250);

    const nullColor = JSON.parse(readFileSync("fixtures/proto/session-meta/color-null.json", "utf8")) as SessionMeta;
    expect(nullColor.color).toBeNull();
    expect("color" in nullColor).toBe(true);
  });
});
