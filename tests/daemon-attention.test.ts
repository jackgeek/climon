import { describe, expect, test } from "bun:test";
import { shouldApplyUserAttentionAcknowledgement } from "../src/daemon/daemon.js";

describe("shouldApplyUserAttentionAcknowledgement", () => {
  test("accepts user acknowledgement only for the current outstanding attention token", () => {
    expect(shouldApplyUserAttentionAcknowledgement(true, "token-2", "token-2", "fingerprint-2", "fingerprint-2")).toBe(true);
    expect(shouldApplyUserAttentionAcknowledgement(true, "token-2", "token-1", "fingerprint-2", "fingerprint-2")).toBe(false);
    expect(shouldApplyUserAttentionAcknowledgement(true, "token-2", undefined, "fingerprint-2", "fingerprint-2")).toBe(false);
    expect(shouldApplyUserAttentionAcknowledgement(false, "token-2", "token-2", "fingerprint-2", "fingerprint-2")).toBe(false);
    expect(shouldApplyUserAttentionAcknowledgement(undefined, "token-2", "token-2", "fingerprint-2", "fingerprint-2")).toBe(false);
  });

  test("rejects stale acknowledgement when the screen has changed since attention was flagged", () => {
    expect(shouldApplyUserAttentionAcknowledgement(true, "token-2", "token-2", "fingerprint-2", "fingerprint-3")).toBe(false);
  });
});
