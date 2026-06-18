import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { encodeFrame, encodeJsonFrame, FrameType } from "../src/ipc/frame.js";
import {
  buildMousePrivateModeReplaySuffix,
  TRACKED_MOUSE_PRIVATE_MODES,
} from "../src/daemon/daemon.js";

interface FrameFixture {
  name: string;
  type: number;
  payloadJson?: string;
  payloadHex?: string;
  hex: string;
}

interface SuffixFixture {
  name: string;
  enabledModes: string[];
  suffixHex: string;
}

describe("session golden fixtures", () => {
  test("session frame encodings match the shared corpus", () => {
    const entries = JSON.parse(
      readFileSync("fixtures/session/frames.json", "utf8")
    ) as FrameFixture[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      let frame: Buffer;
      if (entry.payloadJson !== undefined) {
        frame = encodeJsonFrame(entry.type as FrameType, JSON.parse(entry.payloadJson));
      } else {
        frame = encodeFrame(entry.type as FrameType, Buffer.from(entry.payloadHex ?? "", "hex"));
      }
      expect(Buffer.from(frame).toString("hex")).toBe(entry.hex);
    }
  });

  test("mouse-mode replay suffixes match the shared corpus", () => {
    const entries = JSON.parse(
      readFileSync("fixtures/session/replay-suffix.json", "utf8")
    ) as SuffixFixture[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const state = new Map<string, boolean>(entry.enabledModes.map((m) => [m, true]));
      const suffix = buildMousePrivateModeReplaySuffix(state, TRACKED_MOUSE_PRIVATE_MODES);
      expect(Buffer.from(suffix).toString("hex")).toBe(entry.suffixHex);
    }
  });
});
