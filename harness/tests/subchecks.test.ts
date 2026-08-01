import { describe, expect, test } from "bun:test";
import {
  formatSubcheckLabel,
  validateSubcheckResults,
  type SubcheckDefinition,
} from "../src/subchecks.js";
import type { SubcheckResult } from "../src/types.js";

const CONTRACT = [
  {
    name: "same-size-browser-control-jiggle",
    title: "Jiggles both terminal dimensions when same-size browser control is acquired",
  },
  {
    name: "final-frame-repaint",
    title: "Repaints the final authoritative frame after the jiggle",
  },
] as const satisfies readonly SubcheckDefinition[];

function passedSubcheck(name: string, title: string): SubcheckResult {
  return {
    name,
    title,
    status: "passed",
    durationMs: 1,
  };
}

describe("subcheck contracts", () => {
  test("accepts exact ordered results with matching titles", () => {
    expect(() =>
      validateSubcheckResults(CONTRACT, [
        passedSubcheck(
          "same-size-browser-control-jiggle",
          "Jiggles both terminal dimensions when same-size browser control is acquired"
        ),
        passedSubcheck(
          "final-frame-repaint",
          "Repaints the final authoritative frame after the jiggle"
        ),
      ])
    ).not.toThrow();
  });

  test("rejects count mismatches", () => {
    expect(() =>
      validateSubcheckResults(CONTRACT, [
        passedSubcheck(
          "same-size-browser-control-jiggle",
          "Jiggles both terminal dimensions when same-size browser control is acquired"
        ),
      ])
    ).toThrow("Expected 2 subchecks, received 1");
  });

  test("rejects reordered results", () => {
    expect(() =>
      validateSubcheckResults(CONTRACT, [
        passedSubcheck(
          "final-frame-repaint",
          "Repaints the final authoritative frame after the jiggle"
        ),
        passedSubcheck(
          "same-size-browser-control-jiggle",
          "Jiggles both terminal dimensions when same-size browser control is acquired"
        ),
      ])
    ).toThrow(
      "Subcheck order mismatch at 0: expected same-size-browser-control-jiggle, received final-frame-repaint"
    );
  });

  test("rejects title drift for a stable subcheck id", () => {
    expect(() =>
      validateSubcheckResults(CONTRACT, [
        passedSubcheck("same-size-browser-control-jiggle", "Wrong title"),
        passedSubcheck(
          "final-frame-repaint",
          "Repaints the final authoritative frame after the jiggle"
        ),
      ])
    ).toThrow("Subcheck title mismatch for same-size-browser-control-jiggle");
  });

  test("formats descriptive labels with stable ids", () => {
    expect(formatSubcheckLabel(CONTRACT[0])).toBe(
      "Jiggles both terminal dimensions when same-size browser control is acquired (same-size-browser-control-jiggle)"
    );
  });
});
