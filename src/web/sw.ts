/// <reference lib="webworker" />
import { OPEN_SESSION_MESSAGE } from "./pwa/pushData.js";
import {
  handlePush,
  queryViewedSession,
  resolveNotificationClick,
  type NotificationClickClient,
  type ViewedSessionChannel,
} from "./pwa/swPush.js";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

/** How long to wait for a client to report its viewed session before showing. */
const VIEWED_SESSION_QUERY_TIMEOUT_MS = 500;

self.addEventListener("push", (event: PushEvent) => {
  event.waitUntil(
    handlePush({
      raw: event.data?.text(),
      matchWindowClients: () => self.clients.matchAll({ type: "window" }),
      queryClient: (client) =>
        queryViewedSession(client, {
          createChannel: () => new MessageChannel() as unknown as ViewedSessionChannel,
          schedule: (callback, delayMs) => setTimeout(callback, delayMs),
          timeoutMs: VIEWED_SESSION_QUERY_TIMEOUT_MS,
        }),
      showNotification: (title, options) => self.registration.showNotification(title, options),
    }),
  );
});

/** Projects a live `WindowClient` onto the descriptor the decision uses. */
function toClickClient(client: WindowClient): NotificationClickClient {
  return { id: client.id, focused: client.focused, visibilityState: client.visibilityState };
}

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const sessionId =
    (event.notification.data as { sessionId?: string } | null)?.sessionId ?? undefined;
  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const action = resolveNotificationClick(sessionId, windowClients.map(toClickClient));
      const byId = (id: string): WindowClient | undefined =>
        windowClients.find((client) => client.id === id);
      switch (action.kind) {
        case "open":
          await self.clients.openWindow(action.url);
          return;
        case "focus":
          await byId(action.clientId)?.focus();
          return;
        case "post": {
          const client = byId(action.clientId);
          if (!client) return;
          await client.focus();
          client.postMessage({ type: OPEN_SESSION_MESSAGE, sessionId: action.sessionId });
          return;
        }
        case "navigate": {
          const client = byId(action.clientId);
          if (!client) return;
          await client.focus();
          try {
            await client.navigate(action.url);
          } catch {
            // Some platforms reject navigate() on an uncontrolled client. Opening
            // a deep-linked window is more reliable than a postMessage a frozen
            // page could drop — which is the failure this handler prevents.
            await self.clients.openWindow(action.url);
          }
          return;
        }
        default: {
          const exhaustive: never = action;
          return exhaustive;
        }
      }
    })(),
  );
});
