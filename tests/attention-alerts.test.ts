import { describe, expect, test } from "bun:test";
import type { SessionMeta } from "../src/types.js";
import {
  buildAttentionNotification,
  createAttentionAlertManager,
  formatAttentionTitle,
  sessionAttentionLabel
} from "../src/web/attentionAlerts.js";

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

function createHarness() {
  let currentTitle = "climon";
  const soundCalls: string[] = [];
  const notifications: { title: string; body: string; sessionId: string; key: string }[] = [];
  const manager = createAttentionAlertManager({
    title: {
      get: () => currentTitle,
      set: (title) => {
        currentTitle = title;
      }
    },
    sound: {
      play: () => {
        soundCalls.push("play");
      }
    },
    notifications: {
      notify: (alert) => {
        notifications.push(alert);
      }
    }
  });
  return {
    manager,
    soundCalls,
    notifications,
    title: () => currentTitle
  };
}

describe("formatAttentionTitle", () => {
  test("uses climon when no sessions need attention", () => {
    expect(formatAttentionTitle("climon", 0)).toBe("climon");
  });

  test("adds a compact attention count after climon", () => {
    expect(formatAttentionTitle("climon", 1)).toBe("climon (!1)");
    expect(formatAttentionTitle("climon", 2)).toBe("climon (!2)");
  });

  test("preserves a custom base title", () => {
    expect(formatAttentionTitle("climon dev", 3)).toBe("climon dev (!3)");
  });
});

describe("attention notification content", () => {
  test("uses name, then displayCommand, then command for the session label", () => {
    expect(sessionAttentionLabel(session({ name: "API server", displayCommand: "bun run server" }))).toBe(
      "API server"
    );
    expect(sessionAttentionLabel(session({ name: "", displayCommand: "bun test" }))).toBe("bun test");
    expect(sessionAttentionLabel(session({ displayCommand: "", command: ["bun", "test"] }))).toBe("bun test");
  });

  test("builds notification title and body without a reason", () => {
    expect(buildAttentionNotification(session({ name: "API server", status: "needs-attention" }))).toEqual({
      title: "climon needs attention",
      body: "API server needs attention",
      sessionId: "sess-1",
      key: "sess-1:attention"
    });
  });

  test("appends attentionReason when present", () => {
    expect(
      buildAttentionNotification(
        session({
          name: "API server",
          status: "needs-attention",
          attentionMatchedAt: "token-1",
          attentionReason: "Screen idle for 10s"
        })
      )
    ).toEqual({
      title: "climon needs attention",
      body: "API server needs attention: Screen idle for 10s",
      sessionId: "sess-1",
      key: "sess-1:token-1"
    });
  });
});

describe("createAttentionAlertManager", () => {
  test("initial update seeds existing attention sessions without sound or notifications", () => {
    const h = createHarness();
    h.manager.update([
      session({
        status: "needs-attention",
        attentionMatchedAt: "token-1",
        name: "API server"
      })
    ]);
    expect(h.title()).toBe("climon (!1)");
    expect(h.soundCalls).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  test("new transition into needs-attention fires one sound and one notification", () => {
    const h = createHarness();
    h.manager.update([session({ status: "running", name: "API server" })]);
    h.manager.update([
      session({
        status: "needs-attention",
        attentionMatchedAt: "token-1",
        attentionReason: "Screen idle for 10s",
        name: "API server"
      })
    ]);
    expect(h.title()).toBe("climon (!1)");
    expect(h.soundCalls).toEqual(["play"]);
    expect(h.notifications).toEqual([
      {
        title: "climon needs attention",
        body: "API server needs attention: Screen idle for 10s",
        sessionId: "sess-1",
        key: "sess-1:token-1"
      }
    ]);
  });

  test("repeated updates for the same attention token do not duplicate alerts", () => {
    const h = createHarness();
    const attentive = session({
      status: "needs-attention",
      attentionMatchedAt: "token-1",
      name: "API server"
    });
    h.manager.update([session({ status: "running", name: "API server" })]);
    h.manager.update([attentive]);
    h.manager.update([attentive]);
    expect(h.soundCalls).toEqual(["play"]);
    expect(h.notifications).toHaveLength(1);
  });

  test("a later distinct attention token alerts again", () => {
    const h = createHarness();
    h.manager.update([session({ status: "running", name: "API server" })]);
    h.manager.update([session({ status: "needs-attention", attentionMatchedAt: "token-1", name: "API server" })]);
    h.manager.update([session({ status: "running", name: "API server" })]);
    h.manager.update([session({ status: "needs-attention", attentionMatchedAt: "token-2", name: "API server" })]);
    expect(h.soundCalls).toEqual(["play", "play"]);
    expect(h.notifications.map((n) => n.key)).toEqual(["sess-1:token-1", "sess-1:token-2"]);
  });

  test("title returns to climon after all sessions leave needs-attention", () => {
    const h = createHarness();
    h.manager.update([session({ status: "running", name: "API server" })]);
    expect(h.title()).toBe("climon");
    h.manager.update([session({ status: "needs-attention", attentionMatchedAt: "token-1", name: "API server" })]);
    expect(h.title()).toBe("climon (!1)");
    h.manager.update([session({ status: "running", name: "API server" })]);
    expect(h.title()).toBe("climon");
  });

  test("multiple newly attentive sessions produce one notification per session", () => {
    const h = createHarness();
    h.manager.update([
      session({ id: "a", status: "running", name: "API server" }),
      session({ id: "b", status: "running", name: "Worker" })
    ]);
    h.manager.update([
      session({ id: "a", status: "needs-attention", attentionMatchedAt: "a-1", name: "API server" }),
      session({ id: "b", status: "needs-attention", attentionMatchedAt: "b-1", name: "Worker" })
    ]);
    expect(h.title()).toBe("climon (!2)");
    expect(h.soundCalls).toEqual(["play", "play"]);
    expect(h.notifications.map((n) => n.body)).toEqual([
      "API server needs attention",
      "Worker needs attention"
    ]);
  });

  test("dispose restores title and calls sound.dispose when provided", () => {
    let currentTitle = "climon";
    let disposeCount = 0;
    const manager = createAttentionAlertManager({
      title: { get: () => currentTitle, set: (t) => { currentTitle = t; } },
      sound: {
        play: () => { soundCalls.push("play"); },
        dispose: () => { disposeCount++; }
      },
      notifications: { notify: () => {} }
    });
    const soundCalls: string[] = [];
    manager.update([session({ status: "needs-attention", attentionMatchedAt: "t1", name: "API" })]);
    expect(currentTitle).toBe("climon (!1)");
    manager.dispose();
    expect(currentTitle).toBe("climon");
    expect(disposeCount).toBe(1);
  });

  test("dispose restores title even when sound.dispose throws", () => {
    let currentTitle = "climon";
    const manager = createAttentionAlertManager({
      title: { get: () => currentTitle, set: (t) => { currentTitle = t; } },
      sound: {
        play: () => {},
        dispose: () => { throw new Error("audio close failed"); }
      },
      notifications: { notify: () => {} }
    });
    manager.update([session({ status: "needs-attention", attentionMatchedAt: "t1", name: "API" })]);
    expect(() => manager.dispose()).not.toThrow();
    expect(currentTitle).toBe("climon");
  });

  test("dispose works without sound.dispose (plain SoundAdapter)", () => {
    const h = createHarness();
    h.manager.update([session({ status: "needs-attention", attentionMatchedAt: "t1", name: "API" })]);
    expect(() => h.manager.dispose()).not.toThrow();
    expect(h.title()).toBe("climon");
  });

  test("adapter errors do not prevent title updates", () => {
    let currentTitle = "climon";
    let soundCallCount = 0;
    let notificationCallCount = 0;
    const manager = createAttentionAlertManager({
      title: {
        get: () => currentTitle,
        set: (title) => {
          currentTitle = title;
        }
      },
      sound: {
        play: () => {
          soundCallCount++;
          throw new Error("audio blocked");
        }
      },
      notifications: {
        notify: () => {
          notificationCallCount++;
          throw new Error("notifications blocked");
        }
      }
    });
    manager.update([session({ status: "running", name: "API server" })]);
    manager.update([session({ status: "needs-attention", attentionMatchedAt: "token-1", name: "API server" })]);
    expect(currentTitle).toBe("climon (!1)");
    expect(soundCallCount).toBe(1);
    expect(notificationCallCount).toBe(1);
  });
});
