import { describe, expect, test } from "bun:test";
import { buildPushPayload, createAttentionTracker } from "../src/server/push/attention.js";
import type { SessionMeta } from "../src/types.js";

function session(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: "s1",
    name: "",
    command: ["bash"],
    displayCommand: "bash",
    status: "running",
    ...overrides,
  } as SessionMeta;
}

describe("attention tracker", () => {
  test("seeds on first update and emits nothing", () => {
    const tracker = createAttentionTracker();
    const out = tracker.update([session({ id: "s1", status: "needs-attention", attentionMatchedAt: "1" })]);
    expect(out).toEqual([]);
  });

  test("emits a session that newly enters needs-attention", () => {
    const tracker = createAttentionTracker();
    tracker.update([session({ id: "s1", status: "running" })]);
    const out = tracker.update([session({ id: "s1", status: "needs-attention", attentionMatchedAt: "2" })]);
    expect(out.map((s) => s.id)).toEqual(["s1"]);
  });

  test("does not re-emit an already-attentive session", () => {
    const tracker = createAttentionTracker();
    tracker.update([session({ id: "s1", status: "running" })]);
    tracker.update([session({ id: "s1", status: "needs-attention", attentionMatchedAt: "2" })]);
    const out = tracker.update([session({ id: "s1", status: "needs-attention", attentionMatchedAt: "2" })]);
    expect(out).toEqual([]);
  });

  test("re-emits when attentionMatchedAt changes", () => {
    const tracker = createAttentionTracker();
    tracker.update([session({ id: "s1", status: "running" })]);
    tracker.update([session({ id: "s1", status: "needs-attention", attentionMatchedAt: "2" })]);
    const out = tracker.update([session({ id: "s1", status: "needs-attention", attentionMatchedAt: "9" })]);
    expect(out.map((s) => s.id)).toEqual(["s1"]);
  });

  test("buildPushPayload includes label, reason, and session id", () => {
    const payload = buildPushPayload(
      session({ id: "s1", name: "deploy", status: "needs-attention", attentionReason: "prompt" }),
    );
    expect(payload.title).toBe("climon needs attention");
    expect(payload.body).toBe("deploy needs attention: prompt");
    expect(payload.sessionId).toBe("s1");
  });
});
