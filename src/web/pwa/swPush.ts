import {
  parsePushData,
  buildNotificationOptions,
  notificationTargetPath,
  type PushNotificationOptions,
} from "./pushData.js";

export interface HandlePushDeps {
  /** Raw push payload text (or null/undefined when absent). */
  raw: string | null | undefined;
  /** Displays the notification. */
  showNotification: (title: string, options: PushNotificationOptions) => Promise<void> | void;
}

/**
 * Core push-event behavior: always shows the system notification for the push.
 *
 * iOS/WebKit requires a PWA service worker to call `showNotification()` for
 * every push it receives; silently suppressing raises a generic fallback banner
 * and can revoke the subscription. Foreground suppression is therefore done on
 * the server (it skips push subscriptions reported foreground) rather than here.
 */
export async function handlePush(deps: HandlePushDeps): Promise<void> {
  const data = parsePushData(deps.raw);
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
