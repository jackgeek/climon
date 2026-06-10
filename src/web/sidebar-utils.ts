export const remotesMenuLabel = "Remotes (experimental)…";
export const removeDisconnectedMenuLabel = "Remove disconnected";
export function notificationsMenuLabel(enabled: boolean): string {
  return enabled ? "Disable notifications" : "Enable notifications";
}

export type SessionItemRef = (element: HTMLElement | null) => void;

export interface StableSessionItemRefRegistry {
  refs: Record<string, SessionItemRef>;
  animatedRefs: Record<string, SessionItemRef>;
  elements: Record<string, HTMLElement | undefined>;
}

export function getStableSessionItemRef(
  registry: StableSessionItemRefRegistry,
  id: string,
  getAnimatedRef: (id: string) => SessionItemRef
): SessionItemRef {
  registry.animatedRefs[id] = getAnimatedRef(id);
  if (!(id in registry.refs)) {
    registry.refs[id] = (element) => {
      registry.animatedRefs[id]?.(element);
      if (element) {
        registry.elements[id] = element;
      } else {
        delete registry.elements[id];
      }
    };
  }
  return registry.refs[id]!;
}

export function scrollActiveSessionIntoView(
  activeId: string | null,
  getElement: (id: string) => Pick<HTMLElement, "scrollIntoView"> | null | undefined
): void {
  if (!activeId) {
    return;
  }
  getElement(activeId)?.scrollIntoView({ block: "nearest" });
}
