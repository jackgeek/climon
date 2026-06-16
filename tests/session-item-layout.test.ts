import { describe, expect, test } from "bun:test";
import { bottomRowRightOffsets } from "../src/web/components/session-item-layout.js";

describe("bottomRowRightOffsets", () => {
  test("includes the new button slot when enabled (8/36/64/92)", () => {
    expect(bottomRowRightOffsets(true)).toEqual({
      new: 8,
      edit: 36,
      pause: 64,
      lock: 92
    });
  });

  test("omits the new button and shifts the rest left to fill the gap (8/36/64)", () => {
    const offsets = bottomRowRightOffsets(false);
    expect(offsets.new).toBeUndefined();
    expect(offsets).toEqual({
      edit: 8,
      pause: 36,
      lock: 64
    });
  });
});
