import { webLog } from "./log.js";

const log = webLog("key-bar-pinned");

export const KEY_BAR_PINNED_STORAGE_KEY = "climon.keyBarPinned";

type KeyBarPinnedStorage = Pick<Storage, "getItem" | "setItem">;
type StorageResolver = () => KeyBarPinnedStorage | null;

function getBrowserStorage(): KeyBarPinnedStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage;
}

function resolveStorage(
  storage: KeyBarPinnedStorage | null | undefined,
  resolveBrowserStorage: StorageResolver,
  warningMessage: string
): KeyBarPinnedStorage | null {
  if (storage !== undefined) {
    return storage;
  }

  try {
    return resolveBrowserStorage();
  } catch (error) {
    log.warn({ err: String(error) }, warningMessage);
    return null;
  }
}

export function readKeyBarPinned(
  storage?: KeyBarPinnedStorage | null,
  resolveBrowserStorage: StorageResolver = getBrowserStorage
): boolean {
  const resolvedStorage = resolveStorage(
    storage,
    resolveBrowserStorage,
    "Unable to read key bar pinned preference."
  );
  if (!resolvedStorage) {
    return false;
  }

  try {
    return resolvedStorage.getItem(KEY_BAR_PINNED_STORAGE_KEY) === "true";
  } catch (error) {
    log.warn({ err: String(error) }, "Unable to read key bar pinned preference.");
    return false;
  }
}

export function writeKeyBarPinned(
  pinned: boolean,
  storage?: KeyBarPinnedStorage | null,
  resolveBrowserStorage: StorageResolver = getBrowserStorage
): void {
  const resolvedStorage = resolveStorage(
    storage,
    resolveBrowserStorage,
    "Unable to write key bar pinned preference."
  );
  if (!resolvedStorage) {
    return;
  }

  try {
    resolvedStorage.setItem(KEY_BAR_PINNED_STORAGE_KEY, String(pinned));
  } catch (error) {
    log.warn({ err: String(error) }, "Unable to write key bar pinned preference.");
  }
}
