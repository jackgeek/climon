import { describe, expect, test } from "bun:test";
import type { SessionMeta } from "../src/types.js";
import { computeViewedSessionId, viewedSessionAttentionAck } from "../src/web/viewedSession.js";

function session(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: "sess-1",
    command: ["bash"],
    displayCommand: "bash",
    cwd: "/tmp",
    status: "running",
    priorityReason: "running",
    socketPath: "/tmp/sess-1.sock",
    cols: 80,
    rows: 24,
    createdAt: "2026-06-04T10:00:00.000Z",
    updatedAt: "2026-06-04T10:00:00.000Z",
    lastActivityAt: "2026-06-04T10:00:00.000Z",
    ...overrides
  };
}

describe("computeViewedSessionId", () => {
  const sessions = [session({ id: "a" })];

  test("returns the active id when visible on desktop", () => {
    expect(
      computeViewedSessionId({ activeId: "a", sessions, pageVisible: true, isMobile: false, maximized: false })
    ).toBe("a");
  });

  test("requires the active id to exist in the session list", () => {
    expect(
      computeViewedSessionId({ activeId: "missing", sessions, pageVisible: true, isMobile: false, maximized: false })
    ).toBeNull();
  });

  test("returns null when no session is active", () => {
    expect(
      computeViewedSessionId({ activeId: null, sessions, pageVisible: true, isMobile: false, maximized: false })
    ).toBeNull();
  });

  test("returns null when the page is hidden", () => {
    expect(
      computeViewedSessionId({ activeId: "a", sessions, pageVisible: false, isMobile: false, maximized: false })
    ).toBeNull();
  });

  test("on mobile requires maximized", () => {
    expect(
      computeViewedSessionId({ activeId: "a", sessions, pageVisible: true, isMobile: true, maximized: false })
    ).toBeNull();
    expect(
      computeViewedSessionId({ activeId: "a", sessions, pageVisible: true, isMobile: true, maximized: true })
    ).toBe("a");
  });
});

describe("viewedSessionAttentionAck", () => {
  test("returns an ack when the viewed session needs attention", () => {
    const sessions = [session({ id: "a", status: "needs-attention", attentionMatchedAt: "a-1" })];
    expect(viewedSessionAttentionAck("a", sessions, null)).toEqual({
      sessionId: "a",
      attentionMatchedAt: "a-1",
      key: "a:a-1"
    });
  });

  test("returns null when nothing is viewed", () => {
    const sessions = [session({ id: "a", status: "needs-attention", attentionMatchedAt: "a-1" })];
    expect(viewedSessionAttentionAck(null, sessions, null)).toBeNull();
  });

  test("returns null when the viewed session is not in the list", () => {
    const sessions = [session({ id: "a", status: "needs-attention", attentionMatchedAt: "a-1" })];
    expect(viewedSessionAttentionAck("missing", sessions, null)).toBeNull();
  });

  test("returns null when the viewed session does not need attention", () => {
    const sessions = [session({ id: "a", status: "running" })];
    expect(viewedSessionAttentionAck("a", sessions, null)).toBeNull();
  });

  test("returns null when needs-attention but attentionMatchedAt is absent", () => {
    const sessions = [session({ id: "a", status: "needs-attention" })];
    expect(viewedSessionAttentionAck("a", sessions, null)).toBeNull();
  });

  test("returns null when the same attention key was already acknowledged", () => {
    const sessions = [session({ id: "a", status: "needs-attention", attentionMatchedAt: "a-1" })];
    expect(viewedSessionAttentionAck("a", sessions, "a:a-1")).toBeNull();
  });

  test("returns a new ack when the attention key changes", () => {
    const sessions = [session({ id: "a", status: "needs-attention", attentionMatchedAt: "a-2" })];
    expect(viewedSessionAttentionAck("a", sessions, "a:a-1")).toEqual({
      sessionId: "a",
      attentionMatchedAt: "a-2",
      key: "a:a-2"
    });
  });
});
