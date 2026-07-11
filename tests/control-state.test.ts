import { test, expect } from "bun:test";
import {
  deriveControlState,
  generateViewerId,
  surfaceKind,
  shouldRefitOnControlFrame,
  shouldSendResize
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
