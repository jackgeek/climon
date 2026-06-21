import {
  parsePushData,
  buildNotificationOptions,
  notificationTargetPath,
  VIEWED_SESSION_QUERY,
  parseViewedSessionResponse,
  shouldSuppressPush,
  type PushNotificationOptions,
} from "./pushData.js";

/** Minimal slice of a window `Client` the push glue needs. */
export interface PushClient {
  postMessage: (message: unknown, transfer: Transferable[]) => void;
}

/** Minimal slice of a `MessageChannel` used to ask a client what it is viewing. */
export interface ViewedSessionChannel {
  port1: { onmessage: ((event: { data: unknown }) => void) | null; close: () => void };
  port2: unknown;
}

export interface QueryViewedSessionDeps {
  /** Creates a fresh channel for one query. */
  createChannel: () => ViewedSessionChannel;
  /** Schedules the timeout fallback (injected for tests). */
  schedule: (callback: () => void, delayMs: number) => void;
  /** How long to wait for a client reply before resolving null. */
  timeoutMs: number;
}

/**
 * Asks one window client which session it is viewing. Resolves the reported
 * session id, or null on timeout/error. The reply port is always closed once
 * the query settles so a slow client cannot leak channels.
 */
export function queryViewedSession(
  client: PushClient,
  deps: QueryViewedSessionDeps,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let channel: ViewedSessionChannel | null = null;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      channel?.port1.close();
      resolve(value);
    };
    try {
      channel = deps.createChannel();
      channel.port1.onmessage = (event): void => {
        finish(parseViewedSessionResponse(event.data));
      };
      client.postMessage({ type: VIEWED_SESSION_QUERY }, [channel.port2 as Transferable]);
      deps.schedule(() => finish(null), deps.timeoutMs);
    } catch {
      finish(null);
    }
  });
}

export interface HandlePushDeps {
  /** Raw push payload text (or null/undefined when absent). */
  raw: string | null | undefined;
  /** Returns the currently open window clients. */
  matchWindowClients: () => Promise<readonly PushClient[]>;
  /** Asks one client which session it is viewing. */
  queryClient: (client: PushClient) => Promise<string | null>;
  /** Displays the notification. */
  showNotification: (title: string, options: PushNotificationOptions) => Promise<void> | void;
}

/**
 * Core push-event behavior: shows the notification unless the push targets a
 * specific session that at least one open client reports actively viewing.
 * Generic pushes (no session id) are always shown without querying clients.
 */
export async function handlePush(deps: HandlePushDeps): Promise<void> {
  const data = parsePushData(deps.raw);
  if (data.sessionId) {
    const clients = await deps.matchWindowClients();
    const viewed = await Promise.all(clients.map((client) => deps.queryClient(client)));
    if (shouldSuppressPush(data.sessionId, viewed)) {
      return;
    }
  }
  await deps.showNotification(data.title, buildNotificationOptions(data));
}

/** Minimal slice of a window `WindowClient` the notification-click glue needs. */
export interface NotificationClickClient {
  id: string;
  focused: boolean;
  visibilityState: "hidden" | "visible" | "prerender" | "unloaded";
}

/**
 * Chooses which open client a notification tap should target. Prefers a
 * `focused` client, then a `visible` one, then the first client — so a stale or
 * hidden client never wins over the live PWA. Returns null when there are none.
 */
export function pickNotificationClient<T extends NotificationClickClient>(
  clients: readonly T[],
): T | null {
  return (
    clients.find((c) => c.focused) ??
    clients.find((c) => c.visibilityState === "visible") ??
    clients[0] ??
    null
  );
}

/** What the service worker should do when a notification is tapped. */
export type NotificationClickAction =
  | { kind: "open"; url: string }
  | { kind: "focus"; clientId: string }
  | { kind: "post"; clientId: string; sessionId: string }
  | { kind: "navigate"; clientId: string; url: string };

/**
 * Decides how a notification tap should reach the originating session.
 *
 * - No open client: open a deep-linked window (`/?session=<id>`).
 * - No session id: just focus the chosen client (nothing to deep-link to).
 * - Foreground client (focused or visible): post `OPEN_SESSION_MESSAGE` — instant
 *   and keeps live terminal state.
 * - Backgrounded/hidden client: navigate it to the deep-link URL, because a
 *   message posted to a frozen page can be dropped on resume and strand the user
 *   on the session list.
 */
export function resolveNotificationClick(
  sessionId: string | undefined,
  clients: readonly NotificationClickClient[],
): NotificationClickAction {
  const target = pickNotificationClient(clients);
  const url = notificationTargetPath(sessionId);
  if (!target) {
    return { kind: "open", url };
  }
  if (!sessionId) {
    return { kind: "focus", clientId: target.id };
  }
  if (target.focused || target.visibilityState === "visible") {
    return { kind: "post", clientId: target.id, sessionId };
  }
  return { kind: "navigate", clientId: target.id, url };
}
