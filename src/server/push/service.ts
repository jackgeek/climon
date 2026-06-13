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

const DEFAULT_VAPID_SUBJECT = "mailto:climon@example.com";

/**
 * Resolves the VAPID JWT `sub` claim. Apple's push service rejects any subject
 * whose hostname is `localhost` with a `BadJwtToken` 403, so the default uses a
 * valid non-localhost contact. Operators can override it with a real `mailto:`
 * address or `https:` URL via `CLIMON_VAPID_SUBJECT`.
 */
export function resolveVapidSubject(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLIMON_VAPID_SUBJECT?.trim();
  return override && override.length > 0 ? override : DEFAULT_VAPID_SUBJECT;
}

export async function createPushService(
  climonHome: string,
  client?: WebPushClient,
): Promise<PushService> {
  const keys = await loadOrCreateVapidKeys(climonHome);
  webpush.setVapidDetails(resolveVapidSubject(), keys.publicKey, keys.privateKey);

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
