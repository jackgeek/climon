import { describe, expect, test } from "bun:test";
import { shouldApplyUserAttentionAcknowledgement } from "../src/daemon/daemon.js";

describe("shouldApplyUserAttentionAcknowledgement", () => {
  test("accepts user acknowledgement only while attention is outstanding", () => {
    expect(shouldApplyUserAttentionAcknowledgement(true)).toBe(true);
    expect(shouldApplyUserAttentionAcknowledgement(false)).toBe(false);
    expect(shouldApplyUserAttentionAcknowledgement(undefined)).toBe(false);
  });
});
