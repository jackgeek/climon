/// <reference lib="webworker" />
import { notificationTargetPath, OPEN_SESSION_MESSAGE } from "./pwa/pushData.js";
import { handlePush, queryViewedSession, type ViewedSessionChannel } from "./pwa/swPush.js";

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
