import { webLog } from "./log.js";

const log = webLog("font-size");

export const FONT_SIZE_STORAGE_KEY = "climon.fontSize";

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
export const DEFAULT_FONT_SIZE = 13;

type FontSizeStorage = Pick<Storage, "getItem" | "setItem">;
type StorageResolver = () => FontSizeStorage | null;

function getBrowserStorage(): FontSizeStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage;
}

function resolveStorage(
  storage: FontSizeStorage | null | undefined,
  resolveBrowserStorage: StorageResolver,
  warningMessage: string
): FontSizeStorage | null {
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

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) {
    return DEFAULT_FONT_SIZE;
  }
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

export function readFontSize(
  storage?: FontSizeStorage | null,
  resolveBrowserStorage: StorageResolver = getBrowserStorage
): number {
  const resolvedStorage = resolveStorage(storage, resolveBrowserStorage, "Unable to read font size preference.");
  if (!resolvedStorage) {
    return DEFAULT_FONT_SIZE;
  }

  try {
    const raw = resolvedStorage.getItem(FONT_SIZE_STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_FONT_SIZE;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      return DEFAULT_FONT_SIZE;
    }
    return clampFontSize(parsed);
  } catch (error) {
    log.warn({ err: String(error) }, "Unable to read font size preference.");
    return DEFAULT_FONT_SIZE;
  }
}

export function writeFontSize(
  size: number,
  storage?: FontSizeStorage | null,
  resolveBrowserStorage: StorageResolver = getBrowserStorage
): void {
  const resolvedStorage = resolveStorage(storage, resolveBrowserStorage, "Unable to write font size preference.");
  if (!resolvedStorage) {
    return;
  }

  try {
    resolvedStorage.setItem(FONT_SIZE_STORAGE_KEY, String(clampFontSize(size)));
  } catch (error) {
    log.warn({ err: String(error) }, "Unable to write font size preference.");
  }
}
