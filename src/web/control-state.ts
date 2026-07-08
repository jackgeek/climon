import type { SurfaceKind } from "../ipc/frame.js";

export type ControlState = "controlling" | "displaced";

// A surface controls the shared PTY grid when the daemon names it as controller;
// every other surface is "displaced" and shows a take-control message rather than
// trying to mirror the controller's grid. This deliberately ignores viewport size
// so a non-controller never fights the controller over dimensions.
export function deriveControlState(args: { ownViewerId: string; controllerId: string | null }): ControlState {
  if (args.controllerId && args.controllerId === args.ownViewerId) return "controlling";
  return "displaced";
}

export function surfaceKind(isStandalone: boolean): SurfaceKind {
  return isStandalone ? "pwa" : "dashboard";
}

// A per-tab identity for this dashboard/PWA surface, sent with every resize so
// the daemon can name exactly one controller and every other surface stays
// displaced. `crypto.randomUUID()` only exists in secure contexts (https or
// localhost); dashboards reached over plain http on a LAN IP would otherwise
// throw here and lose their identity, so fall back to getRandomValues and then
// to a time+random string. The value only needs to be unique among the
// surfaces attached to one session, never cryptographically strong.
export function generateViewerId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
