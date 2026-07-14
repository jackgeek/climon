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

// The controller re-fits (and requests a scrollback replay at its new grid) ONLY
// when it has just *taken* control -- i.e. transitioned from displaced to
// controlling. A surface that is already the stable controller must NOT re-fit in
// response to grid changes, because as the controller it is the one that caused
// them: doing so forms a resize -> control-broadcast -> refit -> resize feedback
// loop that never settles when the viewport fit is unstable (e.g. a mobile PWA
// whose visual viewport or scrollbar jitters), spamming PTY resizes and replays
// until the screen corrupts. Displaced surfaces never refit (they stay blank).
export function shouldRefitOnControlFrame(args: { state: ControlState; wasDisplaced: boolean }): boolean {
  return args.state === "controlling" && args.wasDisplaced;
}

// Dedupe redundant resize reports: only report a size when it actually changed
// from the last size we sent, unless a replay must ride along (the take-control
// handoff needs the resize+replay round-trip even when the size is unchanged).
// This bounds any residual viewport jitter to at most one PTY resize per real
// size change.
export function shouldSendResize(args: {
  last: { cols: number; rows: number } | null;
  next: { cols: number; rows: number };
  requestReplay: boolean;
}): boolean {
  if (args.requestReplay) {
    return true;
  }
  return !args.last || args.last.cols !== args.next.cols || args.last.rows !== args.next.rows;
}

// Decide whether a surface that just became focused/visible should reclaim
// control of the session it is showing. Per the control-priority design,
// returning to a window (alt-tab, tab switch, unlocking a phone, resuming a PWA)
// makes it the controller again. We skip reclaiming ONLY when we can prove we
// already hold control: a live open connection whose latest control frame named
// us. While disconnected the `controllerId` we last saw may be stale -- the
// daemon reassigns control to the local terminal when this surface's socket
// drops (e.g. a backgrounded tab), and we never received that frame -- so we
// must reclaim rather than trust a stale "we are the controller" value.
// Otherwise the reconnect delivers a control frame naming the local terminal and
// the surface wrongly shows the "Take control" button despite having had control.
export function shouldReclaimOnFocus(args: {
  visible: boolean;
  sessionLive: boolean;
  connected: boolean;
  controllerId: string | null;
  ownViewerId: string;
}): boolean {
  if (!args.visible || !args.sessionLive) return false;
  if (args.connected && args.controllerId === args.ownViewerId) return false;
  return true;
}

// Decide whether a fresh attachment should immediately seize control. The daemon
// reassigns control to the local terminal the moment this surface's socket drops
// (a session switch, a server-token reattach, or any reconnect), so every attach
// of the session the user is actively viewing -- the selected, visible, live
// session -- must re-take control. Unlike shouldReclaimOnFocus this fires on the
// reconnect/select edge rather than a window focus event, which is the ONLY path
// that covers an intra-tab mouse switch (switching sessions in the same tab emits
// no focus/visibilitychange). Without it a raced take-control is dropped and the
// surface sticks behind "This session is being viewed elsewhere." Attaching only
// ever targets the selected+visible session, so gating on attachIsSelected keeps
// a background prefetch (should one ever exist) from stealing control.
export function shouldTakeControlOnAttach(args: {
  attachIsSelected: boolean;
  visible: boolean;
  sessionLive: boolean;
}): boolean {
  return args.attachIsSelected && args.visible && args.sessionLive;
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
