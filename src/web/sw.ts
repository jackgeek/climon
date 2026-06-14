/// <reference lib="webworker" />
import {
  parsePushData,
  buildNotificationOptions,
  notificationTargetPath,
  OPEN_SESSION_MESSAGE,
  VIEWED_SESSION_QUERY,
  parseViewedSessionResponse,
  shouldSuppressPush,
} from "./pwa/pushData.js";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

/** How long to wait for a client to report its viewed session before showing. */
const VIEWED_SESSION_QUERY_TIMEOUT_MS = 500;

/** Asks one window client which session it is viewing; resolves null on timeout/error. */
function queryViewedSession(client: Client): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let channel: MessageChannel | null = null;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      channel?.port1.close();
      resolve(value);
    };
    try {
      channel = new MessageChannel();
      channel.port1.onmessage = (event: MessageEvent): void => {
        finish(parseViewedSessionResponse(event.data));
      };
      client.postMessage({ type: VIEWED_SESSION_QUERY }, [channel.port2]);
      setTimeout(() => finish(null), VIEWED_SESSION_QUERY_TIMEOUT_MS);
    } catch {
      finish(null);
    }
  });
}

/** Collects the session each open window client reports as currently viewed. */
async function gatherViewedSessions(): Promise<(string | null)[]> {
  const clients = await self.clients.matchAll({ type: "window" });
  return Promise.all(clients.map((client) => queryViewedSession(client)));
}

self.addEventListener("push", (event: PushEvent) => {
  const data = parsePushData(event.data?.text());
  event.waitUntil(
    (async () => {
      if (data.sessionId) {
        const viewed = await gatherViewedSessions();
        if (shouldSuppressPush(data.sessionId, viewed)) {
          return;
        }
      }
      await self.registration.showNotification(data.title, buildNotificationOptions(data));
    })(),
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const sessionId =
    (event.notification.data as { sessionId?: string } | null)?.sessionId ?? undefined;
  const targetPath = notificationTargetPath(sessionId);
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        if ("focus" in client) {
          await client.focus();
          if (sessionId) {
            client.postMessage({ type: OPEN_SESSION_MESSAGE, sessionId });
          }
          return;
        }
      }
      // No focusable client: open the dashboard deep-linked to the session.
      // The freshly opened page reads ?session= on load and pops it.
      await self.clients.openWindow(targetPath);
    })(),
  );
});
