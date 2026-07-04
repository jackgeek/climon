import { describe, expect, test } from "bun:test";
import {
  handlePush,
  anyClientForeground,
  pickNotificationClient,
  resolveNotificationClick,
  type PushWindowClient,
  type NotificationClickClient,
} from "../src/web/pwa/swPush.js";

function sessionPush(sessionId: string): string {
  return JSON.stringify({ title: "climon session x needs attention", body: "", sessionId });
}

function windowClient(overrides: Partial<PushWindowClient> = {}): PushWindowClient {
  return { focused: false, visibilityState: "hidden", ...overrides };
}

describe("anyClientForeground", () => {
  test("true when a client is focused or visible", () => {
    expect(anyClientForeground([windowClient({ focused: true })])).toBe(true);
    expect(anyClientForeground([windowClient({ visibilityState: "visible" })])).toBe(true);
  });

  test("false when there are no clients or all are hidden", () => {
    expect(anyClientForeground([])).toBe(false);
    expect(anyClientForeground([windowClient(), windowClient()])).toBe(false);
  });
});

describe("handlePush", () => {
  test("shows the notification when there are no open clients", async () => {
    const shown: string[] = [];
    await handlePush({
      raw: sessionPush("sess-1"),
      matchWindowClients: async () => [],
      showNotification: (title) => {
        shown.push(title);
      },
    });
    expect(shown).toEqual(["climon session x needs attention"]);
  });

  test("shows the notification when all clients are hidden (backgrounded)", async () => {
    const shown: string[] = [];
    await handlePush({
      raw: sessionPush("sess-1"),
      matchWindowClients: async () => [windowClient(), windowClient()],
      showNotification: (title) => {
        shown.push(title);
      },
    });
    expect(shown).toEqual(["climon session x needs attention"]);
  });

  test("suppresses the notification when a client is visible (foreground handles it via toast)", async () => {
    const shown: string[] = [];
    await handlePush({
      raw: sessionPush("sess-1"),
      matchWindowClients: async () => [windowClient({ visibilityState: "visible" })],
      showNotification: (title) => {
        shown.push(title);
      },
    });
    expect(shown).toEqual([]);
  });

  test("suppresses the notification when a client is focused", async () => {
    const shown: string[] = [];
    await handlePush({
      raw: sessionPush("sess-1"),
      matchWindowClients: async () => [windowClient({ focused: true })],
      showNotification: (title) => {
        shown.push(title);
      },
    });
    expect(shown).toEqual([]);
  });
});

function client(
  id: string,
  overrides: Partial<NotificationClickClient> = {},
): NotificationClickClient {
  return { id, focused: false, visibilityState: "hidden", ...overrides };
}

describe("pickNotificationClient", () => {
  test("returns null when there are no clients", () => {
    expect(pickNotificationClient([])).toBeNull();
  });

  test("prefers a focused client over a visible or hidden one", () => {
    const picked = pickNotificationClient([
      client("hidden"),
      client("visible", { visibilityState: "visible" }),
      client("focused", { focused: true, visibilityState: "visible" }),
    ]);
    expect(picked?.id).toBe("focused");
  });

  test("prefers a visible client when none is focused", () => {
    const picked = pickNotificationClient([
      client("hidden-1"),
      client("visible", { visibilityState: "visible" }),
      client("hidden-2"),
    ]);
    expect(picked?.id).toBe("visible");
  });

  test("falls back to the first client when none is focused or visible", () => {
    const picked = pickNotificationClient([client("a"), client("b")]);
    expect(picked?.id).toBe("a");
  });
});

describe("resolveNotificationClick", () => {
  test("opens a deep-linked window when there are no clients", () => {
    expect(resolveNotificationClick("sess-1", [])).toEqual({
      kind: "open",
      url: "/?session=sess-1",
    });
  });

  test("opens the dashboard root when there are no clients and no session", () => {
    expect(resolveNotificationClick(undefined, [])).toEqual({ kind: "open", url: "/" });
  });

  test("posts to a focused client (foreground, instant, no reload)", () => {
    const action = resolveNotificationClick("sess-1", [
      client("focused", { focused: true, visibilityState: "visible" }),
    ]);
    expect(action).toEqual({ kind: "post", clientId: "focused", sessionId: "sess-1" });
  });

  test("posts to a visible-but-not-focused client", () => {
    const action = resolveNotificationClick("sess-1", [
      client("visible", { visibilityState: "visible" }),
    ]);
    expect(action).toEqual({ kind: "post", clientId: "visible", sessionId: "sess-1" });
  });

  test("navigates a backgrounded (hidden) client through the URL", () => {
    const action = resolveNotificationClick("sess-1", [client("hidden")]);
    expect(action).toEqual({
      kind: "navigate",
      clientId: "hidden",
      url: "/?session=sess-1",
    });
  });

  test("targets the focused client when a hidden one is also present", () => {
    const action = resolveNotificationClick("sess-1", [
      client("hidden"),
      client("focused", { focused: true, visibilityState: "visible" }),
    ]);
    expect(action).toEqual({ kind: "post", clientId: "focused", sessionId: "sess-1" });
  });

  test("just focuses an existing client when there is no session id", () => {
    const action = resolveNotificationClick(undefined, [client("hidden")]);
    expect(action).toEqual({ kind: "focus", clientId: "hidden" });
  });
});
