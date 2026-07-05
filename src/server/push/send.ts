import { listSubscriptions, removeSubscription, type StoredPushSubscription } from "./subscriptions.js";
import { child } from "../../logging/logger.js";
import { logMsg } from "../../i18n/log-msg.js";

export interface WebPushClient {
  sendNotification(subscription: StoredPushSubscription, payload: string): Promise<unknown>;
}

function statusCodeOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

export async function sendPushToAll(
  climonHome: string,
  client: WebPushClient,
  payload: unknown,
  skip?: (endpoint: string) => boolean,
): Promise<void> {
  const subs = await listSubscriptions(climonHome);
  const targets = skip ? subs.filter((subscription) => !skip(subscription.endpoint)) : subs;
  const body = JSON.stringify(payload);
  await Promise.all(
    targets.map(async (subscription) => {
      try {
        await client.sendNotification(subscription, body);
      } catch (error) {
        const status = statusCodeOf(error);
        if (status === 404 || status === 410) {
          await removeSubscription(climonHome, subscription.endpoint);
        } else {
          logMsg(child("push"), "warn", "push.send_failed", { endpoint: subscription.endpoint, err: error instanceof Error ? error.message : String(error) });
        }
      }
    }),
  );
}
