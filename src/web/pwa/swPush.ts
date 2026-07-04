import {
  parsePushData,
  buildNotificationOptions,
  notificationTargetPath,
  type PushNotificationOptions,
} from "./pushData.js";

/** Minimal slice of a window `Client` the push suppression check needs. */
export interface PushWindowClient {
  visibilityState: "hidden" | "visible" | "prerender" | "unloaded";
  focused: boolean;
}

/**
 * True when at least one open window client is in the foreground (focused or
 * visible). When so, the in-app attention toast handles alerting, so the
 * service worker must not also raise a system notification.
 */
export function anyClientForeground(clients: readonly PushWindowClient[]): boolean {
  return clients.some((client) => client.focused || client.visibilityState === "visible");
}

export interface HandlePushDeps {
  /** Raw push payload text (or null/undefined when absent). */
  raw: string | null | undefined;
  /** Returns the currently open window clients. */
  matchWindowClients: () => Promise<readonly PushWindowClient[]>;
  /** Displays the notification. */
  showNotification: (title: string, options: PushNotificationOptions) => Promise<void> | void;
}

/**
 * Core push-event behavior: shows the system notification only when the
 * dashboard is not open in the foreground. If any window client is
 * visible/focused, the foreground app raises a subtle in-app toast instead, so
 * the system banner is suppressed to avoid a double alert.
 */
export async function handlePush(deps: HandlePushDeps): Promise<void> {
  const clients = await deps.matchWindowClients();
  if (anyClientForeground(clients)) {
    return;
  }
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
