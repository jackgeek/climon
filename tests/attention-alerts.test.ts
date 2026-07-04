import { describe, expect, test } from "bun:test";
import type { SessionMeta } from "../src/types.js";
import {
  browserNotificationPermissionMessage,
  browserNotificationPermissionFailureTitle,
  createAttentionAlertManager,
  formatAttentionTitle,
  notificationsEnabledFromState,
  requestBrowserNotificationPermission,
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
  const vibrations: number[][] = [];
  const attentions: SessionMeta[] = [];
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
    vibrate: (pattern) => {
      vibrations.push(pattern);
    },
    onAttention: (attentive) => {
      attentions.push(attentive);
    }
  });
  return {
    manager,
    soundCalls,
    vibrations,
    attentions,
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

describe("sessionAttentionLabel", () => {
  test("uses name, then displayCommand, then command for the session label", () => {
    expect(sessionAttentionLabel(session({ name: "API server", displayCommand: "bun run server" }))).toBe(
      "API server"
    );
    expect(sessionAttentionLabel(session({ name: "", displayCommand: "bun test" }))).toBe("bun test");
    expect(sessionAttentionLabel(session({ displayCommand: "", command: ["bun", "test"] }))).toBe("bun test");
  });
});

describe("requestBrowserNotificationPermission", () => {
  test("requests permission when browser notification permission is still default", async () => {
    let requested = 0;
    const permission = await requestBrowserNotificationPermission({
      get permission() {
        return "default" as NotificationPermission;
      },
      requestPermission: async () => {
        requested++;
        return "granted";
      }
    });

    expect(permission).toBe("granted");
    expect(requested).toBe(1);
  });

  test("returns the existing permission without prompting again", async () => {
    let requested = 0;
    const permission = await requestBrowserNotificationPermission({
      get permission() {
        return "granted" as NotificationPermission;
      },
      requestPermission: async () => {
        requested++;
        return "denied";
      }
    });

    expect(permission).toBe("granted");
    expect(requested).toBe(0);
  });
});

describe("notificationsEnabledFromState", () => {
  test("requires granted browser permission and enabled climon preference", () => {
    expect(notificationsEnabledFromState("granted", true)).toBe(true);
    expect(notificationsEnabledFromState("default", true)).toBe(false);
    expect(notificationsEnabledFromState("denied", true)).toBe(false);
    expect(notificationsEnabledFromState("granted", false)).toBe(false);
  });

  test("titles permission failures as failed notification enabling", () => {
    expect(browserNotificationPermissionFailureTitle).toBe("Failed to enable notifications");
  });

  test("explains when the browser blocked the notification permission prompt", () => {
    expect(browserNotificationPermissionMessage("denied")).toBe(
      "Notifications are blocked in your browser. Enable them for this site in Edge site settings, then try again."
    );
  });

  test("explains when the dashboard origin cannot request notifications", () => {
    expect(browserNotificationPermissionMessage("insecure-context")).toBe(
      "This dashboard is not on a secure origin, so the browser will not show a notification permission prompt. Open climon from localhost or HTTPS and try again."
    );
  });
});

describe("createAttentionAlertManager", () => {
  test("initial update seeds existing attention sessions without sound, vibration, or toast", () => {
    const h = createHarness();
    h.manager.update([session({ status: "needs-attention", attentionMatchedAt: "token-1", name: "API server" })]);
    expect(h.title()).toBe("climon (!1)");
    expect(h.soundCalls).toEqual([]);
    expect(h.vibrations).toEqual([]);
    expect(h.attentions).toEqual([]);
  });

  test("new transition into needs-attention fires one sound, one vibration, and one toast", () => {
    const h = createHarness();
    h.manager.update([session({ status: "running", name: "API server" })]);
    h.manager.update([
      session({ status: "needs-attention", attentionMatchedAt: "token-1", name: "API server" })
    ]);
    expect(h.title()).toBe("climon (!1)");
    expect(h.soundCalls).toEqual(["play"]);
    expect(h.vibrations.length).toBe(1);
    expect(h.vibrations[0]!.length).toBeGreaterThan(0);
    expect(h.attentions.map((s) => s.id)).toEqual(["sess-1"]);
  });

  test("does not fire for the actively viewed session", () => {
    const h = createHarness();
    h.manager.update([session({ status: "running", name: "API server" })]);
    h.manager.update(
      [session({ status: "needs-attention", attentionMatchedAt: "token-1", name: "API server" })],
      { viewedSessionId: "sess-1" }
    );
    expect(h.attentions).toEqual([]);
    expect(h.soundCalls).toEqual([]);
    // Viewed session is excluded from the attention count too.
    expect(h.title()).toBe("climon");
  });

  test("does not fire when alerts are not visible (mobile session-list), but records it as seen", () => {
    const h = createHarness();
    h.manager.update([session({ status: "running", name: "API server" })]);
    // On the mobile session list: alertsVisible=false, so no toast/sound/vibration.
    h.manager.update(
      [session({ status: "needs-attention", attentionMatchedAt: "token-1", name: "API server" })],
      { alertsVisible: false }
    );
    expect(h.attentions).toEqual([]);
    expect(h.soundCalls).toEqual([]);
    expect(h.vibrations).toEqual([]);
    // Navigating into a session (alertsVisible=true) must not retroactively toast
    // the same attention episode.
    h.manager.update(
      [session({ status: "needs-attention", attentionMatchedAt: "token-1", name: "API server" })],
      { alertsVisible: true }
    );
    expect(h.attentions).toEqual([]);
  });

  test("repeated updates for the same attention token do not duplicate toasts", () => {
    const h = createHarness();
    h.manager.update([session({ status: "running", name: "API server" })]);
    h.manager.update([session({ status: "needs-attention", attentionMatchedAt: "token-1", name: "API server" })]);
    h.manager.update([session({ status: "needs-attention", attentionMatchedAt: "token-1", name: "API server" })]);
    expect(h.attentions.map((s) => s.id)).toEqual(["sess-1"]);
    expect(h.soundCalls).toEqual(["play"]);
  });

  test("a later distinct attention token toasts again", () => {
    const h = createHarness();
    h.manager.update([session({ status: "running", name: "API server" })]);
    h.manager.update([session({ status: "needs-attention", attentionMatchedAt: "token-1", name: "API server" })]);
    h.manager.update([session({ status: "needs-attention", attentionMatchedAt: "token-2", name: "API server" })]);
    expect(h.attentions.length).toBe(2);
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

  test("multiple newly attentive sessions produce one toast per session", () => {
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
    expect(h.attentions.map((s) => s.id)).toEqual(["a", "b"]);
  });

  test("works without a vibrate adapter (no throw)", () => {
    let currentTitle = "climon";
    const attentions: SessionMeta[] = [];
    const manager = createAttentionAlertManager({
      title: { get: () => currentTitle, set: (t) => { currentTitle = t; } },
      sound: { play: () => {} },
      onAttention: (s) => { attentions.push(s); }
    });
    manager.update([session({ status: "running", name: "API" })]);
    manager.update([session({ status: "needs-attention", attentionMatchedAt: "t1", name: "API" })]);
    expect(attentions.map((s) => s.id)).toEqual(["sess-1"]);
  });

  test("dispose restores the base title", () => {
    const h = createHarness();
    h.manager.update([session({ status: "needs-attention", attentionMatchedAt: "t1", name: "API" })]);
    expect(h.title()).toBe("climon (!1)");
    h.manager.dispose();
    expect(h.title()).toBe("climon");
  });
});
