import { webLog } from "./log.js";
import { withQuery } from "./api.js";
import { PREF_KEY_BAR_PINNED } from "../dashboard-preference-keys.js";

const log = webLog("preferences");

const LEGACY_KEY_BAR_KEY = "climon.keyBarPinned";
const LEGACY_MIGRATED_FLAG = "climon.pref.migrated.keyBarPinned";

type PrefStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): PrefStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function cacheKeyFor(prefKey: string): string {
  return `climon.pref.${prefKey}`;
}

export function readCachedPreference(prefKey: string, storage: PrefStorage | null = browserStorage()): unknown {
  if (!storage) {
    return undefined;
  }
  try {
    const raw = storage.getItem(cacheKeyFor(prefKey));
    return raw === null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export function writeCachedPreference(
  prefKey: string,
  value: unknown,
  storage: PrefStorage | null = browserStorage()
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(cacheKeyFor(prefKey), JSON.stringify(value));
  } catch (error) {
    log.warn({ err: String(error) }, "Unable to cache preference.");
  }
}

/** POSTs a preference to the server; the same-origin guard requires JSON. */
async function postPreference(key: string, value: unknown): Promise<void> {
  const res = await fetch(withQuery("/api/dashboard/preferences"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, value })
  });
  if (!res.ok) {
    throw new Error(`preference write failed: ${res.status}`);
  }
}

/** Optimistically caches, then persists to the server. Never throws. */
export async function setDashboardPreference(key: string, value: unknown): Promise<void> {
  writeCachedPreference(key, value);
  try {
    await postPreference(key, value);
  } catch (error) {
    log.warn({ err: String(error), key }, "Unable to persist preference to server.");
  }
}

/**
 * One-time migration: seed the shared config from the legacy device-local
 * keyBarPinned value, then drop the legacy key. The writer is injected for tests.
 */
export async function migrateLegacyKeyBarPinned(
  storage: PrefStorage | null = browserStorage(),
  write: (key: string, value: unknown) => Promise<void> = setDashboardPreference
): Promise<void> {
  if (!storage) {
    return;
  }
  if (storage.getItem(LEGACY_MIGRATED_FLAG) === "true") {
    return;
  }
  const legacy = storage.getItem(LEGACY_KEY_BAR_KEY);
  if (legacy === null) {
    return;
  }
  await write(PREF_KEY_BAR_PINNED, legacy === "true");
  storage.setItem(LEGACY_MIGRATED_FLAG, "true");
  storage.removeItem(LEGACY_KEY_BAR_KEY);
}
