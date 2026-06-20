import { describe, expect, test } from "bun:test";
import { browserAttentionPayload } from "../src/server/server.js";
import {
  attachKey,
  attachSocketUrlForLocation,
  attentionAckMessage,
  buildSetupScript,
  canSendAttentionAck,
  isDevTunnelHost,
  isLiveStatus,
  TUNNEL_SKIP_ANTI_PHISHING_PARAM,
  withQuery
} from "../src/web/api.js";
import type { SessionMeta } from "../src/types.js";

function session(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: "sess-1",
    command: ["bash"],
    displayCommand: "bash",
    cwd: "/tmp",
    status: "running",
    priorityReason: "none",
    socketPath: "/tmp/sess-1.sock",
    cols: 80,
    rows: 24,
    createdAt: "",
    updatedAt: "",
    lastActivityAt: "",
    ...overrides
  } as SessionMeta;
}

describe("attachKey", () => {
  test("is stable across live-status transitions so the socket is not re-attached", () => {
    // Idle detection flips a live session running <-> needs-attention. Both are
    // "live", so the terminal must keep the same WebSocket (no reset/refit flicker).
    const running = attachKey(session({ status: "running" }), true);
    const acknowledged = attachKey(session({ status: "acknowledged" }), true);
    const attention = attachKey(session({ status: "needs-attention" }), true);
    const paused = attachKey(session({ status: "paused" }), true);
    expect(running).toBe(acknowledged);
    expect(running).toBe(attention);
    expect(running).toBe(paused);
  });

  test("changes when the session stops being live", () => {
    const live = attachKey(session({ status: "running" }), true);
    const done = attachKey(session({ status: "completed" }), true);
    expect(live).not.toBe(done);
  });

  test("changes when the session id changes", () => {
    const a = attachKey(session({ id: "a" }), true);
    const b = attachKey(session({ id: "b" }), true);
    expect(a).not.toBe(b);
  });

  test("changes when visibility toggles", () => {
    const shown = attachKey(session({}), true);
    const hidden = attachKey(session({}), false);
    expect(shown).not.toBe(hidden);
  });

  test("returns a stable sentinel when there is no session", () => {
    expect(attachKey(null, true)).toBe(attachKey(null, false));
  });
});

describe("isLiveStatus", () => {
  test("treats running, acknowledged, needs-attention, and paused as live statuses", () => {
    expect(isLiveStatus("running")).toBe(true);
    expect(isLiveStatus("acknowledged")).toBe(true);
    expect(isLiveStatus("needs-attention")).toBe(true);
    expect(isLiveStatus("paused")).toBe(true);
    expect(isLiveStatus("completed")).toBe(false);
    expect(isLiveStatus("failed")).toBe(false);
    expect(isLiveStatus("disconnected")).toBe(false);
  });
});

describe("browserAttentionPayload", () => {
  test("accepts an acknowledgement payload", () => {
    expect(browserAttentionPayload({ needsAttention: false, attentionMatchedAt: "token-1" })).toEqual({
      needsAttention: false,
      reason: "viewed",
      attentionMatchedAt: "token-1"
    });
  });

  test("rejects browser attempts to set attention", () => {
    expect(browserAttentionPayload({ needsAttention: true })).toBeNull();
  });

  test("rejects messages without an explicit acknowledgement", () => {
    expect(browserAttentionPayload({})).toBeNull();
  });

  test("rejects acknowledgement messages without an attention token", () => {
    expect(browserAttentionPayload({ needsAttention: false })).toBeNull();
  });
});

describe("attentionAckMessage", () => {
  test("serializes a browser attention acknowledgement", () => {
    expect(JSON.parse(attentionAckMessage("token-1"))).toEqual({
      type: "attention",
      needsAttention: false,
      attentionMatchedAt: "token-1"
    });
  });
});

describe("canSendAttentionAck", () => {
  test("sends only when the open socket belongs to the target session", () => {
    expect(canSendAttentionAck("new-session", "new-session", true)).toBe(true);
    expect(canSendAttentionAck("old-session", "new-session", true)).toBe(false);
    expect(canSendAttentionAck(null, "new-session", true)).toBe(false);
    expect(canSendAttentionAck("new-session", "new-session", false)).toBe(false);
  });
});

describe("Tunnel Link dashboard URLs", () => {
  test("detects Microsoft dev tunnel dashboard hosts", () => {
    expect(isDevTunnelHost("climon-test-3131.eun1.devtunnels.ms")).toBe(true);
    expect(isDevTunnelHost("devtunnels.ms")).toBe(true);
    expect(isDevTunnelHost("localhost")).toBe(false);
  });

  test("adds the anti-phishing bypass query to tunneled API URLs", () => {
    expect(
      withQuery("/api/events", {
        hostname: "climon-test-3131.eun1.devtunnels.ms",
        search: ""
      })
    ).toBe(`/api/events?${TUNNEL_SKIP_ANTI_PHISHING_PARAM}=true`);
  });

  test("preserves path and tunnel query params for DELETE requests", () => {
    expect(
      withQuery("/api/sessions/s1?kill=force", {
        hostname: "climon-test-3131.eun1.devtunnels.ms",
        search: "?existing=1"
      })
    ).toBe(`/api/sessions/s1?kill=force&existing=1&${TUNNEL_SKIP_ANTI_PHISHING_PARAM}=true`);
  });

  test("leaves ordinary loopback API URLs query-free", () => {
    expect(
      withQuery("/api/events", {
        hostname: "localhost",
        search: "?ignored=1"
      })
    ).toBe("/api/events");
  });

  test("adds the anti-phishing bypass query to tunneled WebSocket attach URLs", () => {
    expect(
      attachSocketUrlForLocation("s1", {
        protocol: "https:",
        host: "climon-test-3131.eun1.devtunnels.ms",
        hostname: "climon-test-3131.eun1.devtunnels.ms",
        search: ""
      })
    ).toBe(
      `wss://climon-test-3131.eun1.devtunnels.ms/api/sessions/s1/attach?${TUNNEL_SKIP_ANTI_PHISHING_PARAM}=true`
    );
  });
});

describe("buildSetupScript", () => {
  const BASE = {
    tunnelId: "abc123",
    ingestPort: 3132
  };

  test("emits the two required remote settings", () => {
    const script = buildSetupScript(BASE);
    expect(script).toContain("climon config remote.enabled true");
    expect(script).toContain("climon config remote.tunnelId abc123");
    expect(script).not.toContain("remote.port");
  });

  test("omits color and priority when not chosen", () => {
    const script = buildSetupScript(BASE);
    expect(script).not.toContain("session.color");
    expect(script).not.toContain("session.priority");
  });

  test("includes color and priority when chosen", () => {
    const script = buildSetupScript({ ...BASE, color: "green", priority: 20 });
    expect(script).toContain("climon config session.color green");
    expect(script).toContain("climon config session.priority 20");
  });

  test("emits the 'none' color so it overrides the auto default", () => {
    const script = buildSetupScript({ ...BASE, color: "none" });
    expect(script).toContain("climon config session.color none");
  });

  test("emits the 'auto' color when selected", () => {
    const script = buildSetupScript({ ...BASE, color: "auto" });
    expect(script).toContain("climon config session.color auto");
  });

  test("returns guidance when the tunnel id is missing", () => {
    const script = buildSetupScript({ ...BASE, tunnelId: "" });
    expect(script).toContain("# Create or paste a dev tunnel");
    expect(script).not.toContain("remote.enabled true");
  });

  test("quotes the tunnel id so shell metacharacters are safe", () => {
    const script = buildSetupScript({ ...BASE, tunnelId: "a b$c" });
    expect(script).toContain("climon config remote.tunnelId 'a b$c'");
  });

  test("appends remoteSpawn lines when enabled with a secret", () => {
    const script = buildSetupScript({ ...BASE, clientId: "dev", remoteSpawn: true, spawnSecret: "deadbeef" });
    expect(script).toContain("climon config feature.remoteSpawn enabled");
    expect(script).toContain("climon config remote.spawnSecret deadbeef");
  });

  test("omits remoteSpawn lines when disabled", () => {
    const script = buildSetupScript(BASE);
    expect(script).not.toContain("remoteSpawn");
    expect(script).not.toContain("spawnSecret");
  });
});
