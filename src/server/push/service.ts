import webpush from "web-push";
import type { SessionMeta } from "../../types.js";
import { buildPushPayload, createAttentionTracker } from "./attention.js";
import { sendPushToAll, type WebPushClient } from "./send.js";
import {
  addSubscription,
  removeSubscription,
  type StoredPushSubscription,
} from "./subscriptions.js";
import { loadOrCreateVapidKeys } from "./vapid.js";

export interface PushService {
  getVapidPublicKey(): string;
  subscribe(subscription: StoredPushSubscription): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
  notifyAttention(sessions: SessionMeta[]): Promise<void>;
}

const VAPID_SUBJECT = "mailto:climon@localhost";

export async function createPushService(
  climonHome: string,
  client?: WebPushClient,
): Promise<PushService> {
  const keys = await loadOrCreateVapidKeys(climonHome);
  webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);

  const pushClient: WebPushClient =
    client ?? {
      sendNotification: (subscription, payload) =>
        webpush.sendNotification(subscription, payload),
    };

  const tracker = createAttentionTracker();

  return {
    getVapidPublicKey: () => keys.publicKey,
    subscribe: (subscription) => addSubscription(climonHome, subscription),
    unsubscribe: (endpoint) => removeSubscription(climonHome, endpoint),
    notifyAttention: async (sessions) => {
      const newly = tracker.update(sessions);
      for (const session of newly) {
        await sendPushToAll(climonHome, pushClient, buildPushPayload(session));
      }
    },
  };
}
