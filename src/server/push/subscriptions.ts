import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StoredPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export function subscriptionsPath(climonHome: string): string {
  return join(climonHome, "push", "subscriptions.json");
}

export function isValidSubscription(value: unknown): value is StoredPushSubscription {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.endpoint !== "string" || v.endpoint.length === 0) return false;
  const keys = v.keys as Record<string, unknown> | undefined;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return false;
  return true;
}

async function readAll(climonHome: string): Promise<StoredPushSubscription[]> {
  const file = Bun.file(subscriptionsPath(climonHome));
  if (!(await file.exists())) return [];
  try {
    const parsed = (await file.json()) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidSubscription);
  } catch {
    return [];
  }
}

async function writeAll(climonHome: string, subs: StoredPushSubscription[]): Promise<void> {
  const path = subscriptionsPath(climonHome);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(subs, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

export async function listSubscriptions(climonHome: string): Promise<StoredPushSubscription[]> {
  return readAll(climonHome);
}

export async function addSubscription(
  climonHome: string,
  subscription: StoredPushSubscription,
): Promise<void> {
  const subs = await readAll(climonHome);
  const next = subs.filter((s) => s.endpoint !== subscription.endpoint);
  next.push(subscription);
  await writeAll(climonHome, next);
}

export async function removeSubscription(climonHome: string, endpoint: string): Promise<void> {
  const subs = await readAll(climonHome);
  const next = subs.filter((s) => s.endpoint !== endpoint);
  if (next.length !== subs.length) await writeAll(climonHome, next);
}
