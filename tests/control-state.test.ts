import { test, expect } from "bun:test";
import { deriveControlState, surfaceKind } from "../src/web/control-state.js";

test("controller is controlling regardless of size", () => {
  expect(deriveControlState({ ownViewerId: "a", controllerId: "a", ownCols: 40, ownRows: 20, ctrlCols: 40, ctrlRows: 20 })).toBe("controlling");
});
test("smaller non-controller is displaced", () => {
  expect(deriveControlState({ ownViewerId: "a", controllerId: "b", ownCols: 79, ownRows: 24, ctrlCols: 80, ctrlRows: 24 })).toBe("displaced");
});
test("equal/larger non-controller is following", () => {
  expect(deriveControlState({ ownViewerId: "a", controllerId: "b", ownCols: 120, ownRows: 40, ctrlCols: 80, ctrlRows: 24 })).toBe("following");
});
test("pwa vs dashboard kind", () => {
  expect(surfaceKind(true)).toBe("pwa");
  expect(surfaceKind(false)).toBe("dashboard");
});
