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

  test("buildPushPayload titles with the label and uses the terminal title as body", () => {
    const payload = buildPushPayload(
      session({ id: "s1", name: "deploy", status: "needs-attention", terminalTitle: "npm run deploy" }),
    );
    expect(payload.title).toBe("deploy needs attention");
    expect(payload.body).toBe("npm run deploy");
    expect(payload.sessionId).toBe("s1");
  });

  test("buildPushPayload body is empty when there is no terminal title", () => {
    const payload = buildPushPayload(session({ id: "s1", name: "deploy", status: "needs-attention" }));
    expect(payload.title).toBe("deploy needs attention");
    expect(payload.body).toBe("");
  });
});
