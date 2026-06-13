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

  test("accepts acknowledgement when dimensions differ (resize occurred)", () => {
    const attFp = "80x24\nhello world";
    const curFp = "120x30\nhello world reflowed";
    expect(shouldApplyUserAttentionAcknowledgement(true, "token-1", "token-1", attFp, curFp)).toBe(true);
  });

  test("rejects acknowledgement when dimensions match but content differs", () => {
    const attFp = "80x24\nhello world";
    const curFp = "80x24\ngoodbye world";
    expect(shouldApplyUserAttentionAcknowledgement(true, "token-1", "token-1", attFp, curFp)).toBe(false);
  });

  test("accepts acknowledgement when dimensions and content match", () => {
    const fp = "80x24\nhello world";
    expect(shouldApplyUserAttentionAcknowledgement(true, "token-1", "token-1", fp, fp)).toBe(true);
  });

  test("browser input (source=user) transitions needs-attention to acknowledged before screen change", () => {
    // When browser sends input, shouldApplyUserAttentionAcknowledgement is called with source="user"
    // (unlike detector mode which continues to monitor). This causes the status to transition:
    // needs-attention -> acknowledged (on browser input)
    // acknowledged -> running (when screen changes on next idle detection cycle)
    const currentToken = "2026-06-13T23:34:00.000Z";
    const attentionFp = "80x24\n$ waiting for input";
    
    // Browser sends input while session is in needs-attention
    expect(shouldApplyUserAttentionAcknowledgement(true, currentToken, currentToken, attentionFp, attentionFp)).toBe(true);
  });
});

