import { test, expect } from "bun:test";
import { deriveControlState, generateViewerId, surfaceKind } from "../src/web/control-state.js";

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
