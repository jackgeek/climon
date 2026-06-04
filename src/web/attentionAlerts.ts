import { useEffect, useMemo } from "react";
import type { SessionMeta } from "../types.js";

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
  update: (sessions: SessionMeta[]) => void;
  dispose: () => void;
}

const DEFAULT_TITLE = "climon";
const NOTIFICATION_TITLE = "climon needs attention";
const NOTIFICATIONS_ENABLED_STORAGE_KEY = "climon.notificationsEnabled";

type AudioContextConstructor = typeof AudioContext;
type BrowserNotificationApi = Pick<typeof Notification, "permission" | "requestPermission">;
type NotificationStorage = Pick<Storage, "getItem" | "setItem">;
export type BrowserNotificationPermissionResult = NotificationPermission | "unsupported" | "insecure-context";

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
    console.warn("Unable to access notification preference storage.", error);
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
      console.warn("Unable to read notification preference.", error);
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
    console.warn("Unable to write notification preference.", error);
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

  function update(sessions: SessionMeta[]): void {
    const attentiveSessions = sessions.filter(isAttentionSession);
    title.set(formatAttentionTitle(baseTitle, attentiveSessions.length));

    const currentKeys = new Set(attentiveSessions.map(attentionStateKey));
    const newlyAttentive = attentiveSessions.filter((session) => !seenAttentionKeys.has(attentionStateKey(session)));

    seenAttentionKeys.clear();
    for (const key of currentKeys) {
      seenAttentionKeys.add(key);
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

export function useAttentionAlerts(sessions: SessionMeta[], options?: AttentionAlertManagerOptions): void {
  // Options are intentionally captured at mount; live adapter swapping is not supported.
  const manager = useMemo(() => createAttentionAlertManager(options), []);

  useEffect(() => {
    manager.update(sessions);
  }, [manager, sessions]);

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

export function createBrowserNotificationAdapter(): NotificationAdapter {
  return {
    notify: async (alert) => {
      const permission = browserNotificationPermission();
      if (!notificationsEnabledFromState(permission, readBrowserNotificationsEnabled())) {
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
