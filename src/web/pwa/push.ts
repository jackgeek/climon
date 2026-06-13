import { fetchVapidPublicKey, postPushSubscribe, postPushUnsubscribe } from "../api.js";

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

export function shouldShowTunnelDownBanner(consecutiveFailures: number, threshold: number): boolean {
  return consecutiveFailures >= threshold;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js");
}

export async function subscribeToPush(): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const key = await fetchVapidPublicKey();
  const keyBytes = urlBase64ToUint8Array(key);
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes as BufferSource
  });
  await postPushSubscribe(subscription.toJSON());
}

export async function unsubscribeFromPush(): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    return;
  }
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await postPushUnsubscribe(endpoint);
}
