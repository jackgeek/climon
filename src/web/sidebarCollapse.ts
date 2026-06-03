export const SIDEBAR_COLLAPSED_STORAGE_KEY = "climon.sidebarCollapsed";

type SidebarCollapseStorage = Pick<Storage, "getItem" | "setItem">;
type StorageResolver = () => SidebarCollapseStorage | null;

function getBrowserStorage(): SidebarCollapseStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage;
}

function resolveStorage(
  storage: SidebarCollapseStorage | null | undefined,
  resolveBrowserStorage: StorageResolver,
  warningMessage: string
): SidebarCollapseStorage | null {
  if (storage !== undefined) {
    return storage;
  }

  try {
    return resolveBrowserStorage();
  } catch (error) {
    console.warn(warningMessage, error);
    return null;
  }
}

export function readSidebarCollapsed(
  storage?: SidebarCollapseStorage | null,
  resolveBrowserStorage: StorageResolver = getBrowserStorage
): boolean {
  const resolvedStorage = resolveStorage(
    storage,
    resolveBrowserStorage,
    "Unable to read sidebar collapse preference."
  );
  if (!resolvedStorage) {
    return false;
  }

  try {
    return resolvedStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch (error) {
    console.warn("Unable to read sidebar collapse preference.", error);
    return false;
  }
}

export function writeSidebarCollapsed(
  collapsed: boolean,
  storage?: SidebarCollapseStorage | null,
  resolveBrowserStorage: StorageResolver = getBrowserStorage
): void {
  const resolvedStorage = resolveStorage(
    storage,
    resolveBrowserStorage,
    "Unable to write sidebar collapse preference."
  );
  if (!resolvedStorage) {
    return;
  }

  try {
    resolvedStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch (error) {
    console.warn("Unable to write sidebar collapse preference.", error);
  }
}

export function effectiveSidebarCollapsed(persistedCollapsed: boolean, isMobile: boolean): boolean {
  return persistedCollapsed && !isMobile;
}
