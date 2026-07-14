import { test, expect } from "bun:test";
import {
  deriveControlState,
  generateViewerId,
  surfaceKind,
  shouldRefitOnControlFrame,
  shouldSendResize,
  shouldReclaimOnFocus,
  shouldTakeControlOnAttach
} from "../src/web/control-state.js";

test("controller is controlling", () => {
  expect(deriveControlState({ ownViewerId: "a", controllerId: "a" })).toBe("controlling");
});
test("non-controller is displaced", () => {
  expect(deriveControlState({ ownViewerId: "a", controllerId: "b" })).toBe("displaced");
});
test("no controller yet is displaced", () => {
  expect(deriveControlState({ ownViewerId: "a", controllerId: null })).toBe("displaced");
});
test("pwa vs dashboard kind", () => {
  expect(surfaceKind(true)).toBe("pwa");
  expect(surfaceKind(false)).toBe("dashboard");
});
test("generateViewerId returns a unique non-empty id on each call", () => {
  const a = generateViewerId();
  const b = generateViewerId();
  expect(a.length).toBeGreaterThan(0);
  expect(b.length).toBeGreaterThan(0);
  expect(a).not.toBe(b);
});

test("controller refits only when it just took control (displaced -> controlling)", () => {
  // Just took control: refit + replay at our size.
  expect(shouldRefitOnControlFrame({ state: "controlling", wasDisplaced: true })).toBe(true);
});
test("stable controller does not refit on self-caused grid changes (no feedback loop)", () => {
  // Already the controller: the grid only changes because we resized it, so
  // re-fitting here would form a resize->control->refit->resize storm.
  expect(shouldRefitOnControlFrame({ state: "controlling", wasDisplaced: false })).toBe(false);
});
test("a displaced surface never refits", () => {
  expect(shouldRefitOnControlFrame({ state: "displaced", wasDisplaced: true })).toBe(false);
  expect(shouldRefitOnControlFrame({ state: "displaced", wasDisplaced: false })).toBe(false);
});

test("resize is sent when the grid changed from the last reported size", () => {
  expect(shouldSendResize({ last: { cols: 80, rows: 24 }, next: { cols: 100, rows: 30 }, requestReplay: false })).toBe(true);
  expect(shouldSendResize({ last: null, next: { cols: 80, rows: 24 }, requestReplay: false })).toBe(true);
});
test("an identical resize is suppressed to avoid redundant PTY resize churn", () => {
  expect(shouldSendResize({ last: { cols: 80, rows: 24 }, next: { cols: 80, rows: 24 }, requestReplay: false })).toBe(false);
});
test("an identical resize is still sent when a replay must accompany it", () => {
  // Take-control needs the resize+replay round-trip even at an unchanged size.
  expect(shouldSendResize({ last: { cols: 80, rows: 24 }, next: { cols: 80, rows: 24 }, requestReplay: true })).toBe(true);
});

test("returning to focus while the live connection still names us controller does not reclaim", () => {
  expect(
    shouldReclaimOnFocus({ visible: true, sessionLive: true, connected: true, controllerId: "me", ownViewerId: "me" })
  ).toBe(false);
});
test("a hidden window never reclaims", () => {
  expect(
    shouldReclaimOnFocus({ visible: false, sessionLive: true, connected: true, controllerId: "other", ownViewerId: "me" })
  ).toBe(false);
});
test("a non-live session never reclaims", () => {
  expect(
    shouldReclaimOnFocus({ visible: true, sessionLive: false, connected: true, controllerId: "other", ownViewerId: "me" })
  ).toBe(false);
});
test("a visible controller reclaims when another surface holds control", () => {
  expect(
    shouldReclaimOnFocus({ visible: true, sessionLive: true, connected: true, controllerId: "other", ownViewerId: "me" })
  ).toBe(true);
});
test("a stale controllerId is ignored while disconnected so reclaim is armed on return", () => {
  // While backgrounded the socket dropped and the daemon reassigned control to
  // the local terminal, but we never received that frame -- controllerId is
  // stale-equal to our own id. Because we are not connected we must still arm a
  // reclaim so the reconnect re-takes control instead of showing "Take control".
  expect(
    shouldReclaimOnFocus({ visible: true, sessionLive: true, connected: false, controllerId: "me", ownViewerId: "me" })
  ).toBe(true);
});

test("attaching the actively-viewed session takes control so a reconnect re-takes from local", () => {
  // The daemon reassigns control to the local terminal the moment our socket
  // drops, so every fresh attach of the session the user is actively viewing
  // must re-take control -- otherwise a select or a mid-session reconnect leaves
  // the surface wrongly displaced behind "This session is being viewed
  // elsewhere." with no focus event to trigger reclaimOnFocus.
  expect(shouldTakeControlOnAttach({ attachIsSelected: true, visible: true, sessionLive: true })).toBe(true);
});
test("attaching a session other than the selected one never takes control", () => {
  expect(shouldTakeControlOnAttach({ attachIsSelected: false, visible: true, sessionLive: true })).toBe(false);
});
test("a hidden surface never takes control on attach", () => {
  expect(shouldTakeControlOnAttach({ attachIsSelected: true, visible: false, sessionLive: true })).toBe(false);
});
test("attaching a non-live session never takes control", () => {
  expect(shouldTakeControlOnAttach({ attachIsSelected: true, visible: true, sessionLive: false })).toBe(false);
});
