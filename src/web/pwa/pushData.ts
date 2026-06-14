export interface ParsedPushData {
  title: string;
  body: string;
  sessionId?: string;
}

const DEFAULT_TITLE = "climon";
const DEFAULT_BODY = "A session needs attention";

export function parsePushData(raw: string | null | undefined): ParsedPushData {
  if (!raw) {
    return { title: DEFAULT_TITLE, body: DEFAULT_BODY };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const title = typeof parsed.title === "string" && parsed.title ? parsed.title : DEFAULT_TITLE;
    const body = typeof parsed.body === "string" && parsed.body ? parsed.body : DEFAULT_BODY;
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
    return { title, body, sessionId };
  } catch {
    return { title: DEFAULT_TITLE, body: DEFAULT_BODY };
  }
}

/** Message posted from the service worker to an open page on notification click. */
export const OPEN_SESSION_MESSAGE = "climon:open-session";

/** Vibration pattern used to alert on devices that support haptics. */
const ATTENTION_VIBRATE = [200, 100, 200];

export interface PushNotificationOptions extends NotificationOptions {
  vibrate?: number[];
  renotify?: boolean;
}

/**
 * Builds the notification options for an attention push. `silent: false` plus a
 * vibration pattern ensures the device plays its notification sound/haptics, and
 * `renotify` re-alerts when a session needs attention again under the same tag.
 */
export function buildNotificationOptions(data: ParsedPushData): PushNotificationOptions {
  return {
    body: data.body,
    icon: "/assets/icon-192.png",
    badge: "/assets/icon-192.png",
    tag: data.sessionId ? `climon-${data.sessionId}` : "climon",
    renotify: true,
    silent: false,
    vibrate: ATTENTION_VIBRATE,
    data: { sessionId: data.sessionId },
  };
}

/** Deep-link path that opens the dashboard focused on a specific session. */
export function notificationTargetPath(sessionId: string | undefined): string {
  return sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/";
}

/** Reads the `session` deep-link parameter from a URL query string. */
export function parseSessionFromSearch(search: string | null | undefined): string | null {
  if (!search) return null;
  try {
    const id = new URLSearchParams(search).get("session");
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Validates a service-worker → page message and extracts the session id to open. */
export function parseOpenSessionMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.type !== OPEN_SESSION_MESSAGE) return null;
  return typeof message.sessionId === "string" && message.sessionId.length > 0
    ? message.sessionId
    : null;
}

/** Message the service worker posts to a page to ask which session it is viewing. */
export const VIEWED_SESSION_QUERY = "climon:viewed-session-query";

export interface ViewedSessionResponse {
  type: typeof VIEWED_SESSION_QUERY;
  sessionId: string | null;
}

/** Builds a page's reply to a viewed-session query. Empty ids normalize to null. */
export function viewedSessionResponse(sessionId: string | null): ViewedSessionResponse {
  return {
    type: VIEWED_SESSION_QUERY,
    sessionId: sessionId && sessionId.length > 0 ? sessionId : null,
  };
}

/** Validates a service-worker → page viewed-session query message. */
export function isViewedSessionQuery(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>).type === VIEWED_SESSION_QUERY;
}

/** Parses a page → service-worker viewed-session reply; returns the viewed id or null. */
export function parseViewedSessionResponse(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.type !== VIEWED_SESSION_QUERY) return null;
  return typeof message.sessionId === "string" && message.sessionId.length > 0
    ? message.sessionId
    : null;
}

/**
 * Decides whether a push for `pushSessionId` should be suppressed because a
 * client is currently viewing that session. Suppresses only when the push
 * targets a specific session and at least one client reports viewing it.
 */
export function shouldSuppressPush(
  pushSessionId: string | undefined,
  viewedSessionIds: (string | null)[],
): boolean {
  if (!pushSessionId) return false;
  return viewedSessionIds.some((id) => id === pushSessionId);
}
