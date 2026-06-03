import { describe, expect, test } from "bun:test";
import { shouldApplyUserAttentionAcknowledgement } from "../src/daemon/daemon.js";

describe("shouldApplyUserAttentionAcknowledgement", () => {
  test("accepts user acknowledgement only for the current outstanding attention token", () => {
    expect(shouldApplyUserAttentionAcknowledgement(true, "token-2", "token-2")).toBe(true);
    expect(shouldApplyUserAttentionAcknowledgement(true, "token-2", "token-1")).toBe(false);
    expect(shouldApplyUserAttentionAcknowledgement(true, "token-2", undefined)).toBe(false);
    expect(shouldApplyUserAttentionAcknowledgement(false, "token-2", "token-2")).toBe(false);
    expect(shouldApplyUserAttentionAcknowledgement(undefined, "token-2", "token-2")).toBe(false);
  });
});
