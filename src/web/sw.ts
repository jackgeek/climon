/// <reference lib="webworker" />
import {
  parsePushData,
  buildNotificationOptions,
  notificationTargetPath,
  OPEN_SESSION_MESSAGE,
} from "./pwa/pushData.js";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event: PushEvent) => {
  const data = parsePushData(event.data?.text());
  event.waitUntil(self.registration.showNotification(data.title, buildNotificationOptions(data)));
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
