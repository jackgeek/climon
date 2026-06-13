import { listSubscriptions, removeSubscription, type StoredPushSubscription } from "./subscriptions.js";

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
): Promise<void> {
  const subs = await listSubscriptions(climonHome);
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (subscription) => {
      try {
        await client.sendNotification(subscription, body);
      } catch (error) {
        const status = statusCodeOf(error);
        if (status === 404 || status === 410) {
          await removeSubscription(climonHome, subscription.endpoint);
        } else {
          console.warn(`[push] send failed for ${subscription.endpoint}:`, error);
        }
      }
    }),
  );
}
