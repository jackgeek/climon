import { describe, expect, test } from "bun:test";
import { encodeControl, MuxDecoder, type ControlMessage } from "../src/remote/mux.js";

describe("read-file mux frames", () => {
  test("round-trips a read-file request", () => {
    const msg: ControlMessage = {
      kind: "read-file",
      requestId: "r1",
      sessionId: "s1",
      path: "src/a.ts",
      maxBytes: 2048
    };
    const decoded = new MuxDecoder().push(encodeControl(msg));
    expect(decoded[0]).toEqual({ type: "control", message: msg });
  });

  test("round-trips a read-file-result", () => {
    const msg: ControlMessage = {
      kind: "read-file-result",
      requestId: "r1",
      result: { status: "ok", path: "/abs/src/a.ts", content: "x" }
    };
    const decoded = new MuxDecoder().push(encodeControl(msg));
    expect(decoded[0]).toEqual({ type: "control", message: msg });
  });
});
