import { describe, expect, test } from "bun:test";
import { InputProcessor } from "../src/client/connect.js";

describe("InputProcessor", () => {
  test("detach prefix followed by d requests detach without forwarding the chord", () => {
    const processor = new InputProcessor(0x1c);

    expect(processor.process(Buffer.from([0x1c, 0x64]))).toEqual({
      forward: Buffer.alloc(0),
      action: "detach"
    });
  });

  test("detach prefix followed by c requests clamped mode restore without forwarding the chord", () => {
    const processor = new InputProcessor(0x1c);

    expect(processor.process(Buffer.from([0x1c, 0x63]))).toEqual({
      forward: Buffer.alloc(0),
      action: "restore-clamped"
    });
  });

  test("non-command prefixed input is forwarded unchanged", () => {
    const processor = new InputProcessor(0x1c);

    expect(processor.process(Buffer.from([0x1c, 0x78]))).toEqual({
      forward: Buffer.from([0x1c, 0x78]),
      action: "none"
    });
  });
});
