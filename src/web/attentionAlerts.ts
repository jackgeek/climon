import { useEffect, useMemo } from "react";
import type { SessionMeta } from "../types.js";
import { webLog } from "./log.js";

const log = webLog("attention-alerts");

export interface AttentionAlert {
  title: string;
  body: string;
  sessionId: string;
  key: string;
}

export interface TitleAdapter {
  get: () => string;
  set: (title: string) => void;
}

export interface SoundAdapter {
  play: () => void | Promise<void>;
  dispose?: () => void | Promise<void>;
}

export interface NotificationAdapter {
  notify: (alert: AttentionAlert) => void | Promise<void>;
}

export interface AttentionAlertManagerOptions {
  title?: TitleAdapter;
  sound?: SoundAdapter;
  notifications?: NotificationAdapter;
}

export interface AttentionAlertManager {
  update: (sessions: SessionMeta[], viewedSessionId?: string | null) => void;
  dispose: () => void;
}

const DEFAULT_TITLE = "climon";
const NOTIFICATION_TITLE = "climon needs attention";
const NOTIFICATIONS_ENABLED_STORAGE_KEY = "climon.notificationsEnabled";

type AudioContextConstructor = typeof AudioContext;
type BrowserNotificationApi = Pick<typeof Notification, "permission" | "requestPermission">;
type NotificationStorage = Pick<Storage, "getItem" | "setItem">;
export type BrowserNotificationPermissionResult = NotificationPermission | "unsupported" | "insecure-context";
export const browserNotificationPermissionFailureTitle = "Failed to enable notifications";

interface WindowWithWebkitAudioContext extends Window {
  AudioContext?: AudioContextConstructor;
  webkitAudioContext?: AudioContextConstructor;
}

export function formatAttentionTitle(baseTitle: string, attentionCount: number): string {
  return attentionCount > 0 ? `${baseTitle} (!${attentionCount})` : baseTitle;
}

export function sessionAttentionLabel(session: Pick<SessionMeta, "name" | "displayCommand" | "command">): string {
  const trimmedName = session.name?.trim();
  if (trimmedName) {
    return trimmedName;
  }
  const trimmedDisplayCommand = session.displayCommand.trim();
  if (trimmedDisplayCommand) {
    return trimmedDisplayCommand;
  }
  return session.command.join(" ");
}

export function attentionStateKey(session: Pick<SessionMeta, "id" | "attentionMatchedAt">): string {
  return `${session.id}:${session.attentionMatchedAt ?? "attention"}`;
}

export function buildAttentionNotification(session: SessionMeta): AttentionAlert {
  const label = sessionAttentionLabel(session);
  const baseBody = `${label} needs attention`;
  const reason = session.attentionReason?.trim();
  return {
    title: NOTIFICATION_TITLE,
    body: reason ? `${baseBody}: ${reason}` : baseBody,
    sessionId: session.id,
    key: attentionStateKey(session)
  };
}

export function notificationsEnabledFromState(permission: BrowserNotificationPermissionResult, enabled: boolean): boolean {
  return permission === "granted" && enabled;
}

function browserNotificationPermission(notificationApi?: BrowserNotificationApi): BrowserNotificationPermissionResult {
  const api = notificationApi ?? (typeof Notification === "undefined" ? undefined : Notification);
  return api?.permission ?? "unsupported";
}

function browserStorage(storage?: NotificationStorage | null): NotificationStorage | null {
  if (storage !== undefined) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch (error) {
    log.warn({ err: String(error) }, "Unable to access notification preference storage.");
    return null;
  }
}

export function readBrowserNotificationsEnabled(
  storage?: NotificationStorage | null,
  notificationApi?: BrowserNotificationApi
): boolean {
  const permission = browserNotificationPermission(notificationApi);
  const resolvedStorage = browserStorage(storage);
  let preference = permission === "granted";
  if (resolvedStorage) {
    try {
      const stored = resolvedStorage.getItem(NOTIFICATIONS_ENABLED_STORAGE_KEY);
      if (stored !== null) {
        preference = stored === "true";
      }
    } catch (error) {
      log.warn({ err: String(error) }, "Unable to read notification preference.");
    }
  }
  return notificationsEnabledFromState(permission, preference);
}

export function writeBrowserNotificationsEnabled(enabled: boolean, storage?: NotificationStorage | null): void {
  const resolvedStorage = browserStorage(storage);
  if (!resolvedStorage) {
    return;
  }
  try {
    resolvedStorage.setItem(NOTIFICATIONS_ENABLED_STORAGE_KEY, String(enabled));
  } catch (error) {
    log.warn({ err: String(error) }, "Unable to write notification preference.");
  }
}

export async function requestBrowserNotificationPermission(
  notificationApi?: BrowserNotificationApi
): Promise<BrowserNotificationPermissionResult> {
  if (typeof globalThis.isSecureContext === "boolean" && !globalThis.isSecureContext) {
    return "insecure-context";
  }
  const api = notificationApi ?? (typeof Notification === "undefined" ? undefined : Notification);
  if (!api) {
    return "unsupported";
  }
  if (api.permission !== "default") {
    return api.permission;
  }
  return api.requestPermission();
}

export function browserNotificationPermissionMessage(
  permission: BrowserNotificationPermissionResult | "request-failed"
): string | null {
  switch (permission) {
    case "denied":
      return "Notifications are blocked in your browser. Enable them for this site in Edge site settings, then try again.";
    case "default":
      return "The browser did not grant notification permission. If no prompt appeared, check Edge notification settings for this site and try again.";
    case "unsupported":
      return "This browser does not support dashboard notifications.";
    case "insecure-context":
      return "This dashboard is not on a secure origin, so the browser will not show a notification permission prompt. Open climon from localhost or HTTPS and try again.";
    case "request-failed":
      return "The browser failed to request notification permission. Check Edge notification settings for this site and try again.";
    case "granted":
      return null;
  }
}

function isAttentionSession(session: SessionMeta): boolean {
  return session.status === "needs-attention";
}

function safeCall(callback: () => void | Promise<void>): void {
  try {
    void Promise.resolve(callback()).catch(() => undefined);
  } catch {
    // Browser notification/audio failures must not break title updates.
  }
}

export function createAttentionAlertManager(options: AttentionAlertManagerOptions = {}): AttentionAlertManager {
  const title = options.title ?? createDocumentTitleAdapter();
  const sound = options.sound ?? createWebAudioSoundAdapter();
  const notifications = options.notifications ?? createBrowserNotificationAdapter();
  const baseTitle = title.get() || DEFAULT_TITLE;
  const seenAttentionKeys = new Set<string>();
  let seeded = false;

  function update(sessions: SessionMeta[], viewedSessionId?: string | null): void {
    const attentiveSessions = sessions.filter(isAttentionSession);
    // The session the user is actively viewing must not contribute to the
    // attention count or fire alerts.
    const visibleAttentive = attentiveSessions.filter((session) => session.id !== viewedSessionId);
    title.set(formatAttentionTitle(baseTitle, visibleAttentive.length));

    const newlyAttentive = visibleAttentive.filter(
      (session) => !seenAttentionKeys.has(attentionStateKey(session))
    );

    // Record every attentive session (including the viewed one) as seen so that
    // navigating away from a still-attentive session does not re-fire an alert.
    seenAttentionKeys.clear();
    for (const session of attentiveSessions) {
      seenAttentionKeys.add(attentionStateKey(session));
    }

    if (!seeded) {
      seeded = true;
      return;
    }

    for (const session of newlyAttentive) {
      const alert = buildAttentionNotification(session);
      safeCall(() => sound.play());
      safeCall(() => notifications.notify(alert));
    }
  }

  function dispose(): void {
    title.set(baseTitle);
    if (sound.dispose) {
      safeCall(() => sound.dispose!());
    }
  }

  return { update, dispose };
}

export function useAttentionAlerts(
  sessions: SessionMeta[],
  options?: AttentionAlertManagerOptions,
  viewedSessionId?: string | null
): void {
  // Options are intentionally captured at mount; live adapter swapping is not supported.
  const manager = useMemo(() => createAttentionAlertManager(options), []);

  useEffect(() => {
    manager.update(sessions, viewedSessionId);
  }, [manager, sessions, viewedSessionId]);

  useEffect(() => {
    return () => manager.dispose();
  }, [manager]);
}

function createDocumentTitleAdapter(): TitleAdapter {
  return {
    get: () => (typeof document === "undefined" ? DEFAULT_TITLE : document.title || DEFAULT_TITLE),
    set: (t) => {
      if (typeof document !== "undefined") {
        document.title = t;
      }
    }
  };
}

/**
 * Deduplication window (ms) for cross-tab notification coordination.
 * If another tab already fired a notification for the same alert key within
 * this window, this tab skips it.
 */
const NOTIFICATION_DEDUP_WINDOW_MS = 5000;
const NOTIFICATION_DEDUP_PREFIX = "climon.notified:";

/**
 * Attempts to claim a notification so only one tab fires it. Returns true if
 * this tab won the claim (i.e. should fire the notification).
 */
function claimNotification(alertKey: string): boolean {
  const storageKey = `${NOTIFICATION_DEDUP_PREFIX}${alertKey}`;
  const now = Date.now();
  try {
    const storage = typeof localStorage !== "undefined" ? localStorage : null;
    if (!storage) {
      return true;
    }
    const existing = storage.getItem(storageKey);
    if (existing) {
      const claimedAt = Number(existing);
      if (now - claimedAt < NOTIFICATION_DEDUP_WINDOW_MS) {
        return false;
      }
    }
    storage.setItem(storageKey, String(now));
    return true;
  } catch {
    // Storage unavailable — fire anyway to avoid silent failure.
    return true;
  }
}

export function createBrowserNotificationAdapter(): NotificationAdapter {
  return {
    notify: async (alert) => {
      const permission = browserNotificationPermission();
      if (!notificationsEnabledFromState(permission, readBrowserNotificationsEnabled())) {
        return;
      }
      if (!claimNotification(alert.key)) {
        return;
      }
      new Notification(alert.title, { body: alert.body });
    }
  };
}

function createWebAudioSoundAdapter(): SoundAdapter {
  let audioContext: AudioContext | null = null;
  return {
    play: () => {
      if (typeof window === "undefined") {
        return;
      }
      const browserWindow = window as WindowWithWebkitAudioContext;
      const AudioContextCtor = browserWindow.AudioContext ?? browserWindow.webkitAudioContext;
      if (!AudioContextCtor) {
        return;
      }
      if (!audioContext) {
        audioContext = new AudioContextCtor();
      }
      const ctx = audioContext;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.2);
    },
    dispose: async () => {
      if (audioContext) {
        const ctx = audioContext;
        audioContext = null;
        await ctx.close();
      }
    }
  };
}
