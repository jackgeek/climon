export const SIDEBAR_COLLAPSED_STORAGE_KEY = "climon.sidebarCollapsed";

type SidebarCollapseStorage = Pick<Storage, "getItem" | "setItem">;

function getBrowserStorage(): SidebarCollapseStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage;
}

export function readSidebarCollapsed(
  storage: SidebarCollapseStorage | null | undefined = getBrowserStorage()
): boolean {
  if (!storage) {
    return false;
  }

  try {
    return storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch (error) {
    console.warn("Unable to read sidebar collapse preference.", error);
    return false;
  }
}

export function writeSidebarCollapsed(
  collapsed: boolean,
  storage: SidebarCollapseStorage | null | undefined = getBrowserStorage()
): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch (error) {
    console.warn("Unable to write sidebar collapse preference.", error);
  }
}
