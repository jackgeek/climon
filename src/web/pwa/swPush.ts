import {
  parsePushData,
  buildNotificationOptions,
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
