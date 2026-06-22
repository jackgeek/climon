import { describe, expect, test } from "bun:test";
import {
  handlePush,
  queryViewedSession,
  pickNotificationClient,
  resolveNotificationClick,
  type PushClient,
  type ViewedSessionChannel,
  type NotificationClickClient,
} from "../src/web/pwa/swPush.js";
import { VIEWED_SESSION_QUERY, viewedSessionResponse } from "../src/web/pwa/pushData.js";

function sessionPush(sessionId: string): string {
  return JSON.stringify({ title: "climon needs attention", body: "x", sessionId });
}

describe("handlePush", () => {
  test("shows the notification for a generic push without querying clients", async () => {
    let queried = 0;
    const shown: string[] = [];
    await handlePush({
      raw: JSON.stringify({ title: "climon", body: "A session needs attention" }),
      matchWindowClients: async () => {
        queried += 1;
        return [];
      },
      queryClient: async () => null,
      showNotification: (title) => {
        shown.push(title);
      },
    });
    expect(shown).toEqual(["climon"]);
    expect(queried).toBe(0);
  });

  test("suppresses the push when a client is viewing the pushed session", async () => {
    const shown: string[] = [];
    await handlePush({
      raw: sessionPush("sess-1"),
      matchWindowClients: async () => [{ postMessage: () => {} }, { postMessage: () => {} }],
      queryClient: async (client) => (client === undefined ? null : "sess-1"),
      showNotification: (title) => {
        shown.push(title);
      },
    });
    expect(shown).toEqual([]);
  });

  test("shows the push when no client is viewing the pushed session", async () => {
    const shown: string[] = [];
    await handlePush({
      raw: sessionPush("sess-1"),
      matchWindowClients: async () => [{ postMessage: () => {} }],
      queryClient: async () => "sess-2",
      showNotification: (title) => {
        shown.push(title);
      },
    });
    expect(shown).toEqual(["climon needs attention"]);
  });

  test("shows the push when there are no open clients", async () => {
    const shown: string[] = [];
    await handlePush({
      raw: sessionPush("sess-1"),
      matchWindowClients: async () => [],
      queryClient: async () => null,
      showNotification: (title) => {
        shown.push(title);
      },
    });
    expect(shown).toEqual(["climon needs attention"]);
  });
});

/** Builds a fake MessageChannel whose port1 can be driven from the test. */
function fakeChannel(): ViewedSessionChannel & { reply: (data: unknown) => void; closed: boolean } {
  const channel = {
    port1: { onmessage: null as ((event: { data: unknown }) => void) | null, close: () => {} },
    port2: {} as unknown,
    closed: false,
    reply(data: unknown) {
      this.port1.onmessage?.({ data });
    },
  };
  channel.port1.close = () => {
    channel.closed = true;
  };
  return channel;
}

describe("queryViewedSession", () => {
  test("resolves the session id the client reports and closes the port", async () => {
    const channel = fakeChannel();
    let sentMessage: unknown;
    const client: PushClient = {
      postMessage: (message) => {
        sentMessage = message;
        channel.reply(viewedSessionResponse("sess-9"));
      },
    };
    const result = await queryViewedSession(client, {
      createChannel: () => channel,
      schedule: () => {},
      timeoutMs: 500,
    });
    expect(result).toBe("sess-9");
    expect((sentMessage as { type: string }).type).toBe(VIEWED_SESSION_QUERY);
    expect(channel.closed).toBe(true);
  });

  test("resolves null when the client does not reply before the timeout", async () => {
    const channel = fakeChannel();
    const timer: { fire: (() => void) | null } = { fire: null };
    const client: PushClient = { postMessage: () => {} };
    const pending = queryViewedSession(client, {
      createChannel: () => channel,
      schedule: (callback) => {
        timer.fire = callback;
      },
      timeoutMs: 500,
    });
    timer.fire?.();
    expect(await pending).toBeNull();
    expect(channel.closed).toBe(true);
  });

  test("a late reply after timeout does not override the resolved value", async () => {
    const channel = fakeChannel();
    const timer: { fire: (() => void) | null } = { fire: null };
    const client: PushClient = { postMessage: () => {} };
    const pending = queryViewedSession(client, {
      createChannel: () => channel,
      schedule: (callback) => {
        timer.fire = callback;
      },
      timeoutMs: 500,
    });
    timer.fire?.();
    channel.reply(viewedSessionResponse("sess-late"));
    expect(await pending).toBeNull();
  });

  test("resolves null when creating the channel throws", async () => {
    const client: PushClient = { postMessage: () => {} };
    const result = await queryViewedSession(client, {
      createChannel: () => {
        throw new Error("no channels");
      },
      schedule: () => {},
      timeoutMs: 500,
    });
    expect(result).toBeNull();
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
